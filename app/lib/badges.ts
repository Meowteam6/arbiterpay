// Duolingo-style completion stickers for a GoHealthMe wallet.
//
// WHAT THIS IS
//   A read-only badge grid: ten stickers, each either earned or locked, derived
//   entirely from state the app already holds. The design layer maps art to each
//   badge by its stable `id` (exposed as `iconKey`); this module only decides who
//   earned what and when.
//
// HONESTY BOUNDARY (load-bearing)
//   Badges celebrate COMPLETION, never VERIFICATION. A self-reported win earns
//   "First Win" identically to a verified one, and NO badge object carries a tier
//   or "verified" flag. Exactly one badge (verified-streak) inspects the trust
//   tier at all - because the streak it names is itself verified - and even it
//   exposes no tier on the returned object.
//
// RELIABILITY (load-bearing)
//   Every source degrades to LOCKED, never to fake-earned:
//     - On-chain participation/funding is read with reliable state reads
//       (fetchPools + fetchParticipant, the dashboard/challenges pattern) - no
//       getLogs is added here. A read failure locks the on-chain badges.
//     - Paid-win + verified-tier counts come from the existing win source
//       (getSocialStats, which is HealthVerdict-bitmap aware). That scan returns
//       zeroed stats on a degraded/archival RPC rather than throwing, so the win
//       badges lock honestly instead of vanishing the whole grid.
//     - Authored challenges come from Supabase; an unconfigured or failing read
//       locks dare-devil.
//   No single degraded source ever takes down the grid: each is gathered behind
//   its own guard and the full ten-badge grid always returns.

import { getAddress, type Address } from "viem";
import {
  fetchParticipant,
  fetchPools,
  type ParticipantInfo,
  type PoolInfo,
} from "@/lib/contract";
import { getSocialStats, type SocialStats } from "@/lib/server/social-stats";
import { getSupabaseServiceRole } from "@/lib/server/supabase";
import { normalizeAddress } from "@/lib/social";

// ---------------------------------------------------------------- public types

export interface BadgeProgress {
  current: number;
  target: number;
}

export interface Badge {
  /** Stable slug. Also the art key the design layer maps to (see iconKey). */
  id: string;
  name: string;
  /** One line: what this sticker celebrates. */
  blurb: string;
  /** Art key. Equals `id` for now; the design layer maps art onto it. */
  iconKey: string;
  earned: boolean;
  /** ISO-8601 of the qualifying event when it is cheaply available, else null.
   *  Always null while the badge is locked. Carries NO tier claim. */
  earnedAt: string | null;
  /** For countable badges only; null otherwise. */
  progress: BadgeProgress | null;
  /** How to earn it, shown on locked stickers. */
  lockedHint: string | null;
}

export interface BadgesResult {
  earnedCount: number;
  total: number;
  badges: Badge[];
}

// ---------------------------------------------------------------- thresholds

/** A "big" pool: 50 USDC in 6-decimal base units. Balance is read straight off
 *  getPool, so this compares base units to base units with no float rounding. */
const WHALE_MIN_UUSDC = 50_000_000n;

/** Wins needed for the "On a Roll" streak sticker. */
const ON_A_ROLL_TARGET = 3;

/** The on-chain marker that a pool is a private peer challenge. Immutable, set
 *  once at createPool - the reliable challenge signal (mirrors challenge-pool.ts;
 *  the Supabase challenges row can be absent if its write failed). */
const CHALLENGE_INITIATIVE = "challenge";

// -------------------------------------------------------------------- signals

/** Everything the ten badges are decided from, gathered from the three sources.
 *  Kept as a flat plain-data bag so the mapping in computeBadges is a pure,
 *  fully unit-testable function with no IO. */
export interface BadgeSignals {
  /** Reliable: pools this wallet has joined (fetchParticipant.joined). */
  joinedCount: number;
  /** Reliable: joined a challenge-initiative pool this wallet did NOT create. */
  answeredCall: boolean;
  /** Reliable: non-challenge pools this wallet created (and thereby funded). */
  sponsoredCount: number;
  /** Reliable: created a non-challenge pool whose balance is >= 50 USDC. */
  whale: boolean;
  /** Reliable: completed (verdict recorded true) a pool whose goal is sleep. */
  wonSleep: boolean;
  /** Win source: paid achiever wins, any tier (getSocialStats.goalsHit). */
  goalsHit: number;
  /** Win source: achiever wins with a verified trust facet (verifiedWins). */
  verifiedWins: number;
  /** Earliest achiever-win timestamp available from the win source, or null. */
  firstWinAt: string | null;
  /** Earliest verified-tier achiever-win timestamp available, or null. */
  verifiedStreakAt: string | null;
  /** Supabase: challenges this wallet authored (challenger_address). */
  dareCount: number;
  /** Earliest authored-challenge created_at as ISO, or null. */
  dareFirstAt: string | null;
}

const EMPTY_SIGNALS: BadgeSignals = {
  joinedCount: 0,
  answeredCall: false,
  sponsoredCount: 0,
  whale: false,
  wonSleep: false,
  goalsHit: 0,
  verifiedWins: 0,
  firstWinAt: null,
  verifiedStreakAt: null,
  dareCount: 0,
  dareFirstAt: null,
};

// ------------------------------------------------------------------- helpers

/** True when a pool's on-chain goal text mentions sleep. Case-insensitive over
 *  the raw goalSpec (any leading proof marker never contains "sleep"). */
function mentionsSleep(goalSpec: string): boolean {
  return goalSpec.toLowerCase().includes("sleep");
}

/** The earliest non-empty ISO timestamp among the win rows that pass `keep`.
 *  recentWins are newest-first and carry "" when a block time was unreadable;
 *  those are skipped. ISO-8601 UTC strings sort lexicographically, so a string
 *  min is a chronological min. Returns null when no dated row qualifies. */
function earliestWinAt(
  wins: SocialStats["recentWins"],
  keep: (win: SocialStats["recentWins"][number]) => boolean,
): string | null {
  let earliest: string | null = null;
  for (const win of wins) {
    if (!keep(win)) continue;
    if (win.at === "") continue;
    if (earliest === null || win.at < earliest) earliest = win.at;
  }
  return earliest;
}

/** Coerce a Supabase timestamp to a canonical ISO string, or null when it does
 *  not parse. Keeps a malformed stored value from reaching the client verbatim. */
function toIso(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Build one badge, centralizing the two invariants every badge shares:
 *  iconKey mirrors id, and earnedAt is forced to null while locked. */
function makeBadge(def: {
  id: string;
  name: string;
  blurb: string;
  earned: boolean;
  earnedAt: string | null;
  progress: BadgeProgress | null;
  lockedHint: string;
}): Badge {
  return {
    id: def.id,
    name: def.name,
    blurb: def.blurb,
    iconKey: def.id,
    earned: def.earned,
    earnedAt: def.earned ? def.earnedAt : null,
    progress: def.progress,
    lockedHint: def.lockedHint,
  };
}

// -------------------------------------------------------------- pure mapping

/**
 * Map gathered signals onto the ten badges. Pure: no IO, no clock, no RPC - so
 * every earn rule and every locked/earned edge is testable in node. The order
 * is stable (the product's badge order) so the grid renders identically run to
 * run. NOTE: no badge carries a tier or "verified" field; verified-streak reads
 * the tier upstream but exposes only earned/earnedAt here.
 */
export function computeBadges(signals: BadgeSignals): BadgesResult {
  const badges: Badge[] = [
    makeBadge({
      id: "first-steps",
      name: "First Steps",
      blurb: "Joined your first pool or challenge",
      earned: signals.joinedCount >= 1,
      earnedAt: null,
      progress: null,
      lockedHint: "Join a pool or accept a challenge",
    }),
    makeBadge({
      id: "first-win",
      name: "First Win",
      blurb: "Completed your first goal",
      earned: signals.goalsHit >= 1,
      earnedAt: signals.firstWinAt,
      progress: null,
      lockedHint: "Hit a goal and get paid",
    }),
    makeBadge({
      id: "on-a-roll",
      name: "On a Roll",
      blurb: "Three wins and counting",
      earned: signals.goalsHit >= ON_A_ROLL_TARGET,
      earnedAt: null,
      progress: { current: signals.goalsHit, target: ON_A_ROLL_TARGET },
      lockedHint: "Win 3 goals",
    }),
    makeBadge({
      id: "dare-devil",
      name: "Dare Devil",
      blurb: "Sent your first challenge",
      earned: signals.dareCount >= 1,
      earnedAt: signals.dareFirstAt,
      progress: null,
      lockedHint: "Dare a friend",
    }),
    makeBadge({
      id: "answered-call",
      name: "Answered the Call",
      blurb: "Accepted a dare sent to you",
      earned: signals.answeredCall,
      earnedAt: null,
      progress: null,
      lockedHint: "Accept a challenge",
    }),
    makeBadge({
      id: "sponsor",
      name: "Sponsor",
      blurb: "Funded a pool",
      earned: signals.sponsoredCount >= 1,
      earnedAt: null,
      progress: null,
      lockedHint: "Fund a pool",
    }),
    makeBadge({
      // The only tier-gated badge: the streak it names is itself verified, so it
      // requires a verified-tier win. Even so it exposes no tier on the object -
      // the sticker uses no check/shield; trust tier lives on the tier badge.
      id: "verified-streak",
      name: "Verified Streak",
      blurb: "A wearable-verified streak",
      earned: signals.verifiedWins >= 1,
      earnedAt: signals.verifiedStreakAt,
      progress: null,
      lockedHint: "Hit a streak with a connected wearable",
    }),
    makeBadge({
      id: "well-rested",
      name: "Well Rested",
      blurb: "Won a sleep goal",
      earned: signals.wonSleep,
      earnedAt: null,
      progress: null,
      lockedHint: "Win a sleep-streak goal",
    }),
    makeBadge({
      // ALWAYS-LOCKED, on purpose. "Back at it after a break" needs activity-gap
      // detection: a timeline of timestamped activity to spot a lapse, then a win
      // after it. The reliable state reads (fetchParticipant) carry NO timestamps,
      // and the win source's timestamps cover only the last few paid wins - too
      // partial to tell a real lapse from a truncated history without faking it.
      // Per the honesty rule this ships locked with its hint rather than guessing.
      // TODO(comeback): earn this once a timestamped activity timeline exists
      // (e.g. an off-chain activity ledger, or a dedicated indexer) - do NOT
      // reach for getLogs on the browser's pruned/rate-limited RPCs to fake it.
      id: "comeback",
      name: "Comeback",
      blurb: "Back at it after a break",
      earned: false,
      earnedAt: null,
      progress: null,
      lockedHint: "Come back and win after a break",
    }),
    makeBadge({
      id: "whale",
      name: "Whale",
      blurb: "Backed a big one",
      earned: signals.whale,
      earnedAt: null,
      progress: null,
      lockedHint: "Fund a pool of 50+ USDC",
    }),
  ];

  const earnedCount = badges.reduce((n, b) => n + (b.earned ? 1 : 0), 0);
  return { earnedCount, total: badges.length, badges };
}

// --------------------------------------------------------------- IO gathering

interface OnchainSignals {
  joinedCount: number;
  answeredCall: boolean;
  sponsoredCount: number;
  whale: boolean;
  wonSleep: boolean;
}

const EMPTY_ONCHAIN: OnchainSignals = {
  joinedCount: 0,
  answeredCall: false,
  sponsoredCount: 0,
  whale: false,
  wonSleep: false,
};

/**
 * Participation + funding, from reliable state reads only. fetchPools enumerates
 * every pool via poolCount (no getLogs) and fetchParticipant reads one struct per
 * pool - the exact dashboard/challenges pattern. Throws only if the whole read
 * chain fails; the caller catches that and locks these badges.
 */
async function gatherOnchain(
  account: Address,
  lowerAddress: string,
): Promise<OnchainSignals> {
  const pools: PoolInfo[] = await fetchPools();
  const participants: ParticipantInfo[] = await Promise.all(
    pools.map((pool) => fetchParticipant(pool.id, account)),
  );

  let joinedCount = 0;
  let sponsoredCount = 0;
  let whale = false;
  let answeredCall = false;
  let wonSleep = false;

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const participant = participants[i];
    const isChallenge = pool.initiative === CHALLENGE_INITIATIVE;
    const iCreated = pool.creator.toLowerCase() === lowerAddress;

    if (participant.joined) {
      joinedCount += 1;
      // Accepted a dare: a challenge pool I joined but did not author.
      if (isChallenge && !iCreated) answeredCall = true;
      // Won a sleep goal: the on-chain verdict records the goal as achieved and
      // the pool's goal is about sleep. Completion, not payment - the sticker
      // celebrates hitting the goal, and this is the reliable read that also
      // carries the goalSpec the redacted win source cannot expose.
      if (
        participant.resultRecorded &&
        participant.verdict &&
        mentionsSleep(pool.goalSpec)
      ) {
        wonSleep = true;
      }
    }

    // Sponsoring = funding a public pool. A challenge is a private dare, not a
    // sponsorship, so challenge pools are excluded here (they earn dare-devil
    // instead). whale is the same set gated on size, so whale implies sponsor.
    if (iCreated && !isChallenge) {
      sponsoredCount += 1;
      if (pool.balance >= WHALE_MIN_UUSDC) whale = true;
    }
  }

  return { joinedCount, sponsoredCount, whale, answeredCall, wonSleep };
}

interface DareSignals {
  dareCount: number;
  dareFirstAt: string | null;
}

/**
 * Challenges this wallet authored, read from the Supabase challenges table by
 * challenger_address (stored lowercased). Degrades to zero when Supabase is
 * unconfigured or the read fails, which locks dare-devil rather than faking it.
 * created_at gives a cheap, honest earnedAt for the badge.
 */
async function gatherDares(lowerAddress: string): Promise<DareSignals> {
  const supabase = getSupabaseServiceRole();
  if (supabase === null) return { dareCount: 0, dareFirstAt: null };

  try {
    const { data, error } = await supabase
      .from("challenges")
      .select("created_at")
      .eq("challenger_address", lowerAddress)
      .order("created_at", { ascending: true });

    if (error !== null || data === null) {
      return { dareCount: 0, dareFirstAt: null };
    }
    const rows = data as { created_at: string }[];
    const first = rows.length > 0 ? toIso(rows[0].created_at) : null;
    return { dareCount: rows.length, dareFirstAt: first };
  } catch (err) {
    console.error("[badges] challenges read failed", err);
    return { dareCount: 0, dareFirstAt: null };
  }
}

/** Project the existing win source onto the badge signals it feeds. */
function winSignalsFrom(stats: SocialStats): Pick<
  BadgeSignals,
  "goalsHit" | "verifiedWins" | "firstWinAt" | "verifiedStreakAt"
> {
  return {
    goalsHit: stats.goalsHit,
    verifiedWins: stats.verifiedWins,
    firstWinAt: earliestWinAt(stats.recentWins, (w) => w.role === "achiever"),
    verifiedStreakAt: earliestWinAt(
      stats.recentWins,
      (w) => w.role === "achiever" && w.tier === "verified",
    ),
  };
}

/**
 * The badge grid for a wallet. Gathers the three sources behind independent
 * guards - a failure in any one locks only its own badges - then maps the
 * combined signals onto the ten stickers. Never throws for a degraded source;
 * an unparseable address yields the all-locked grid.
 */
export async function getBadges(rawAddress: string): Promise<BadgesResult> {
  const lower = normalizeAddress(rawAddress);
  if (lower === null) return computeBadges(EMPTY_SIGNALS);
  const account = getAddress(lower) as Address;

  let onchain = EMPTY_ONCHAIN;
  try {
    onchain = await gatherOnchain(account, lower);
  } catch (err) {
    // A dead RPC or an unconfigured contract locks the on-chain badges; the
    // Supabase and win sources still resolve their own badges below.
    console.error("[badges] on-chain read failed", err);
  }

  // getSocialStats never throws: it returns zeroed stats on a degraded/archival
  // RPC, so the win badges lock honestly instead of taking down the grid.
  const stats = await getSocialStats(lower);
  const dares = await gatherDares(lower);

  return computeBadges({
    ...onchain,
    ...winSignalsFrom(stats),
    ...dares,
  });
}
