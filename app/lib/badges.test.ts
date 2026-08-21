// The badge grid: pinned so the ten stickers earn from exactly the right signal,
// degrade to LOCKED (never fake-earned) when a source dies, and never leak a
// trust tier onto a badge object. Two layers are tested: computeBadges (pure
// mapping) and getBadges (the three-source gather, with every source mocked).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeBadges, type BadgeSignals } from "@/lib/badges";

// ------------------------------------------------------------ mockable sources

const fetchPools = vi.fn();
const fetchParticipant = vi.fn();
const getSocialStats = vi.fn();
const getSupabaseServiceRole = vi.fn();

vi.mock("@/lib/contract", () => ({
  fetchPools: (...args: unknown[]) => fetchPools(...args),
  fetchParticipant: (...args: unknown[]) => fetchParticipant(...args),
}));
vi.mock("@/lib/server/social-stats", () => ({
  getSocialStats: (...args: unknown[]) => getSocialStats(...args),
}));
vi.mock("@/lib/server/supabase", () => ({
  getSupabaseServiceRole: (...args: unknown[]) => getSupabaseServiceRole(...args),
}));

const { getBadges } = await import("@/lib/badges");

const USER = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000b2";

// ---------------------------------------------------------------- builders

type Pool = {
  id: bigint;
  creator: string;
  bountyModel: number;
  settled: boolean;
  periodStart: bigint;
  periodEnd: bigint;
  entryFee: bigint;
  balance: bigint;
  initiative: string;
  goalSpec: string;
};

type Participant = {
  joined: boolean;
  resultRecorded: boolean;
  verdict: boolean;
  multiplierBps: number;
  nullifierHash: bigint;
  backingTotal: bigint;
};

function pool(over: Partial<Pool> & { id: bigint }): Pool {
  return {
    creator: OTHER,
    bountyModel: 0,
    settled: false,
    periodStart: 0n,
    periodEnd: 0n,
    entryFee: 0n,
    balance: 0n,
    initiative: "Sleep more",
    goalSpec: "Sleep 7h nightly",
    ...over,
  };
}

function participant(over: Partial<Participant> = {}): Participant {
  return {
    joined: false,
    resultRecorded: false,
    verdict: false,
    multiplierBps: 0,
    nullifierHash: 0n,
    backingTotal: 0n,
    ...over,
  };
}

function zeroStats() {
  return {
    goalsHit: 0,
    verifiedWins: 0,
    selfReportedWins: 0,
    usdcEarned: 0n,
    poolsJoined: 0,
    backerWins: 0,
    winStreak: 0,
    backerAddresses: [],
    backingAddresses: [],
    recentWins: [] as Array<{
      at: string;
      amountUsd: string;
      txHash: string;
      role: "achiever" | "backer";
      tier: "verified" | "self-reported" | "unknown" | null;
    }>,
  };
}

/** A chainable Supabase stub: from().select().eq().order() resolves to result. */
function fakeSupabase(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve(result),
        }),
      }),
    }),
  };
}

/** Wire fetchPools + fetchParticipant from a list of [pool, participant] pairs. */
function wireChain(pairs: Array<[Pool, Participant]>): void {
  fetchPools.mockResolvedValue(pairs.map(([p]) => p));
  const byId = new Map(pairs.map(([p, part]) => [p.id.toString(), part]));
  fetchParticipant.mockImplementation(async (id: bigint) => {
    const found = byId.get(id.toString());
    return found ?? participant();
  });
}

function badgeById(result: { badges: Array<{ id: string }> }, id: string) {
  const found = result.badges.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no badge ${id}`);
  return found as {
    id: string;
    name: string;
    blurb: string;
    iconKey: string;
    earned: boolean;
    earnedAt: string | null;
    progress: { current: number; target: number } | null;
    lockedHint: string | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Defaults: nothing earned anywhere. Each test overrides what it exercises.
  fetchPools.mockResolvedValue([]);
  fetchParticipant.mockResolvedValue(participant());
  getSocialStats.mockResolvedValue(zeroStats());
  getSupabaseServiceRole.mockReturnValue(null);
});

// ---------------------------------------------------------- pure: computeBadges

const NO_SIGNALS: BadgeSignals = {
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

describe("computeBadges (pure)", () => {
  it("returns the full ten-badge grid with everything locked", () => {
    const res = computeBadges(NO_SIGNALS);
    expect(res.total).toBe(10);
    expect(res.badges).toHaveLength(10);
    expect(res.earnedCount).toBe(0);
    expect(res.badges.every((b) => !b.earned)).toBe(true);
    // Every locked badge keeps its how-to-earn hint and null earnedAt.
    expect(res.badges.every((b) => b.lockedHint !== null)).toBe(true);
    expect(res.badges.every((b) => b.earnedAt === null)).toBe(true);
  });

  it("mirrors iconKey onto id and never exposes a tier field", () => {
    const res = computeBadges({ ...NO_SIGNALS, verifiedWins: 5 });
    for (const b of res.badges) {
      expect(b.iconKey).toBe(b.id);
      expect(b).not.toHaveProperty("tier");
      expect(b).not.toHaveProperty("verified");
    }
  });

  it("counts earned badges and fills on-a-roll progress", () => {
    const res = computeBadges({
      ...NO_SIGNALS,
      joinedCount: 2,
      goalsHit: 3,
    });
    expect(badgeById(res, "first-steps").earned).toBe(true);
    expect(badgeById(res, "first-win").earned).toBe(true);
    const roll = badgeById(res, "on-a-roll");
    expect(roll.earned).toBe(true);
    expect(roll.progress).toEqual({ current: 3, target: 3 });
    expect(res.earnedCount).toBe(3);
  });

  it("shows on-a-roll progress while still locked below three wins", () => {
    const roll = badgeById(computeBadges({ ...NO_SIGNALS, goalsHit: 1 }), "on-a-roll");
    expect(roll.earned).toBe(false);
    expect(roll.progress).toEqual({ current: 1, target: 3 });
  });

  it("forces earnedAt to null when a badge is locked, even if a date was passed", () => {
    // goalsHit 0 -> first-win locked; the firstWinAt must not leak onto it.
    const res = computeBadges({ ...NO_SIGNALS, firstWinAt: "2026-08-10T00:00:00.000Z" });
    expect(badgeById(res, "first-win").earned).toBe(false);
    expect(badgeById(res, "first-win").earnedAt).toBe(null);
  });

  it("keeps comeback always locked with its hint", () => {
    const res = computeBadges({
      ...NO_SIGNALS,
      joinedCount: 9,
      goalsHit: 9,
      verifiedWins: 9,
      wonSleep: true,
      answeredCall: true,
      sponsoredCount: 9,
      whale: true,
      dareCount: 9,
    });
    const comeback = badgeById(res, "comeback");
    expect(comeback.earned).toBe(false);
    expect(comeback.earnedAt).toBe(null);
    expect(comeback.lockedHint).toBe("Come back and win after a break");
    // Everything else earned -> 9 of 10.
    expect(res.earnedCount).toBe(9);
  });
});

// --------------------------------------------------------------- IO: getBadges

describe("getBadges", () => {
  it("returns the all-locked grid for a malformed address without any read", async () => {
    const res = await getBadges("not-an-address");
    expect(res.earnedCount).toBe(0);
    expect(fetchPools).not.toHaveBeenCalled();
    expect(getSocialStats).not.toHaveBeenCalled();
    expect(getSupabaseServiceRole).not.toHaveBeenCalled();
  });

  it("derives participation, funding, sleep, wins, tier, and dares end to end", async () => {
    wireChain([
      // Joined a public sleep pool and won it (verdict recorded true).
      [
        pool({ id: 1n, creator: OTHER, initiative: "Sleep streak", goalSpec: "Sleep 7h nightly", balance: 100_000_000n }),
        participant({ joined: true, resultRecorded: true, verdict: true }),
      ],
      // Joined a challenge someone else authored -> answered the call.
      [
        pool({ id: 2n, creator: OTHER, initiative: "challenge", goalSpec: "Run 5k", balance: 10_000_000n }),
        participant({ joined: true }),
      ],
      // Created and funded a public 60 USDC pool -> sponsor + whale.
      [
        pool({ id: 3n, creator: USER, initiative: "Steps", goalSpec: "10k steps", balance: 60_000_000n }),
        participant({ joined: false }),
      ],
    ]);
    getSocialStats.mockResolvedValue({
      ...zeroStats(),
      goalsHit: 3,
      verifiedWins: 1,
      recentWins: [
        { at: "2026-08-10T00:00:00.000Z", amountUsd: "40.00", txHash: "0xa", role: "achiever", tier: "verified" },
        { at: "2026-08-09T00:00:00.000Z", amountUsd: "10.00", txHash: "0xb", role: "achiever", tier: "self-reported" },
        { at: "", amountUsd: "5.00", txHash: "0xc", role: "achiever", tier: "verified" },
        { at: "2026-08-11T00:00:00.000Z", amountUsd: "20.00", txHash: "0xd", role: "backer", tier: null },
      ],
    });
    getSupabaseServiceRole.mockReturnValue(
      fakeSupabase({
        data: [
          { created_at: "2026-08-01T12:00:00Z" },
          { created_at: "2026-08-05T12:00:00Z" },
        ],
        error: null,
      }),
    );

    const res = await getBadges(USER);

    expect(badgeById(res, "first-steps").earned).toBe(true);
    expect(badgeById(res, "answered-call").earned).toBe(true);
    expect(badgeById(res, "sponsor").earned).toBe(true);
    expect(badgeById(res, "whale").earned).toBe(true);
    expect(badgeById(res, "well-rested").earned).toBe(true);
    expect(badgeById(res, "first-win").earned).toBe(true);
    expect(badgeById(res, "on-a-roll").earned).toBe(true);
    expect(badgeById(res, "verified-streak").earned).toBe(true);
    expect(badgeById(res, "dare-devil").earned).toBe(true);
    expect(badgeById(res, "comeback").earned).toBe(false);
    expect(res.earnedCount).toBe(9);

    // earnedAt: earliest achiever win (skipping the empty-timestamp row); the
    // verified badge uses the earliest verified achiever win specifically.
    expect(badgeById(res, "first-win").earnedAt).toBe("2026-08-09T00:00:00.000Z");
    expect(badgeById(res, "verified-streak").earnedAt).toBe("2026-08-10T00:00:00.000Z");
    // dare-devil earnedAt is the earliest authored-challenge created_at as ISO.
    expect(badgeById(res, "dare-devil").earnedAt).toBe("2026-08-01T12:00:00.000Z");
  });

  it("does not earn sponsor or whale from a challenge pool the wallet authored", async () => {
    // Authoring a challenge is dare-devil, not sponsorship - even a big one.
    wireChain([
      [
        pool({ id: 1n, creator: USER, initiative: "challenge", goalSpec: "Lose 10 lbs", balance: 500_000_000n }),
        participant({ joined: true }),
      ],
    ]);
    const res = await getBadges(USER);
    expect(badgeById(res, "sponsor").earned).toBe(false);
    expect(badgeById(res, "whale").earned).toBe(false);
    // Joined my own challenge pool -> first-steps yes, answered-call no (I made it).
    expect(badgeById(res, "first-steps").earned).toBe(true);
    expect(badgeById(res, "answered-call").earned).toBe(false);
  });

  it("locks whale when a created pool is under 50 USDC but still earns sponsor", async () => {
    wireChain([
      [
        pool({ id: 1n, creator: USER, initiative: "Steps", goalSpec: "10k steps", balance: 49_999_999n }),
        participant({ joined: false }),
      ],
    ]);
    const res = await getBadges(USER);
    expect(badgeById(res, "sponsor").earned).toBe(true);
    expect(badgeById(res, "whale").earned).toBe(false);
  });

  it("does not earn well-rested for a non-sleep win", async () => {
    wireChain([
      [
        pool({ id: 1n, creator: OTHER, initiative: "Steps", goalSpec: "10k steps daily", balance: 10_000_000n }),
        participant({ joined: true, resultRecorded: true, verdict: true }),
      ],
    ]);
    const res = await getBadges(USER);
    expect(badgeById(res, "first-steps").earned).toBe(true);
    expect(badgeById(res, "well-rested").earned).toBe(false);
  });

  it("does not earn well-rested for a sleep goal that was not won", async () => {
    wireChain([
      [
        pool({ id: 1n, creator: OTHER, initiative: "Sleep", goalSpec: "Sleep 8h", balance: 10_000_000n }),
        // joined a sleep pool but no passing verdict recorded yet.
        participant({ joined: true, resultRecorded: true, verdict: false }),
      ],
    ]);
    const res = await getBadges(USER);
    expect(badgeById(res, "well-rested").earned).toBe(false);
  });

  it("locks the on-chain badges when the pool read fails, but keeps win + dare badges", async () => {
    fetchPools.mockRejectedValue(new Error("Arc RPC down"));
    getSocialStats.mockResolvedValue({ ...zeroStats(), goalsHit: 1 });
    getSupabaseServiceRole.mockReturnValue(
      fakeSupabase({ data: [{ created_at: "2026-08-01T00:00:00Z" }], error: null }),
    );

    const res = await getBadges(USER);
    // On-chain badges lock honestly...
    expect(badgeById(res, "first-steps").earned).toBe(false);
    expect(badgeById(res, "sponsor").earned).toBe(false);
    expect(badgeById(res, "well-rested").earned).toBe(false);
    // ...while the independent sources still resolve their own badges.
    expect(badgeById(res, "first-win").earned).toBe(true);
    expect(badgeById(res, "dare-devil").earned).toBe(true);
  });

  it("locks the win badges when the win source degrades to zeroed stats", async () => {
    // getSocialStats returns zeroed stats on a degraded/archival RPC (it never
    // throws); the win badges must lock, never fake-earn.
    getSocialStats.mockResolvedValue(zeroStats());
    wireChain([
      [pool({ id: 1n, creator: OTHER }), participant({ joined: true })],
    ]);
    const res = await getBadges(USER);
    expect(badgeById(res, "first-win").earned).toBe(false);
    expect(badgeById(res, "on-a-roll").earned).toBe(false);
    expect(badgeById(res, "verified-streak").earned).toBe(false);
    // A reliable participation badge is unaffected.
    expect(badgeById(res, "first-steps").earned).toBe(true);
  });

  it("locks dare-devil when Supabase is unconfigured", async () => {
    getSupabaseServiceRole.mockReturnValue(null);
    const res = await getBadges(USER);
    expect(badgeById(res, "dare-devil").earned).toBe(false);
    expect(badgeById(res, "dare-devil").earnedAt).toBe(null);
  });

  it("locks dare-devil when the challenges read returns an error", async () => {
    getSupabaseServiceRole.mockReturnValue(
      fakeSupabase({ data: null, error: { message: "relation missing" } }),
    );
    const res = await getBadges(USER);
    expect(badgeById(res, "dare-devil").earned).toBe(false);
  });
});
