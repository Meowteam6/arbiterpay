// SPOTTER's append-only decision ledger, keyed by goalId.
//
// Every step the agent takes on a claim - the plan it prints before spending,
// each purchase, the attester verdict, its decision, the on-chain writes, the
// settlement - lands here as one entry. AgentReceipt renders this verbatim;
// nothing on that screen exists unless it went through this file first.
//
// Two invariants are enforced at append time, not render time:
//   1. No spend without a prior plan entry ("emit plan before any spend").
//   2. Spends stop dead at the per-claim USDC cap frozen into the plan.
// A violating entry throws LedgerInvariantError and persists nothing.
//
// Built on store.ts (Upstash Redis in prod, JSON files locally). Storage is
// append-only at the store level: one entry per RPUSH, one index member per
// ZADD. The previous shape read the whole ledger array, appended and wrote it
// back, so two concurrent appends dropped one of the entries - and a dropped
// "record" entry strands a claim outside the settlement sweep forever while a
// dropped "settled" entry shows a paid user an error screen forever. The index
// was worse: one global blob, so two users claiming in the same second lost
// one of them from the feed and the sweep silently.
//
// Appends that carry an invariant (plan, spend) additionally take a per-goal
// lock, because RPUSH alone cannot enforce "one plan" or "stop at the cap":
// two concurrent spends would each read the same total and each decide they
// fit. Appends with no invariant (verdict, reason, record, settle, error) skip
// the lock - RPUSH is already atomic and they are the ones that must never be
// delayed on a money path.
//
// The exported API and the LedgerEntry union are frozen: other modules code
// against them. Storage changed; shapes and signatures did not.

import {
  appendJson,
  appendJsonAll,
  readJson,
  readJsonList,
  withLock,
  zaddNx,
  zrevrange,
} from "@/lib/server/store";
import { optionalEnv } from "@/lib/server/env";
import type { Confidence } from "@/lib/server/judge";

export const DEFAULT_CLAIM_CAP_USD = "1.00";

export interface PlannedStep {
  service: string;
  label: string;
  estUsd: string;
}

interface Stamped {
  at: string;
}

export type LedgerEntry = Stamped &
  (
    | {
        kind: "plan";
        steps: PlannedStep[];
        capUsd: string;
        /** On-chain pool linkage, written at plan time so the settlement
         *  sweep can act on this claim from the ledger alone. */
        poolId?: string;
        participant?: string;
      }
    | {
        kind: "spend";
        service: string;
        label: string;
        amountUsd: string;
        /** External reference for dedupe, e.g. the attester job id. */
        ref: string;
        /** How the purchase settled. "prepaid" = metered under an existing
         *  API key; "x402" = paid per-call from SPOTTER's wallet. */
        settlement: "prepaid" | "x402";
        note?: string;
      }
    | {
        kind: "verdict";
        verified: boolean;
        confidence: Confidence;
        reason: string;
        /** The attester job this verdict belongs to: the attesterId for the
         *  primary read, `${attesterId}:vision-judge` for an escalation. A
         *  retried claim gets a fresh attesterId, so ref is what keeps a
         *  fresh retry from short-circuiting on a stale verdict. */
        ref: string;
      }
    | {
        kind: "reason";
        decision: "pay" | "no-pay";
        note: string;
        /** The attesterId this decision was made against. Always set on new
         *  writes; optional because entries predate the field. Selection is
         *  by ref match, so a retry under a fresh attesterId re-decides
         *  instead of replaying the stale outcome. */
        ref?: string;
      }
    | {
        kind: "record";
        goalId: string;
        resultTx?: string;
        registryStatus: "recorded" | "already-recorded" | "skipped";
        registryTx?: string;
      }
    | {
        kind: "settle";
        status: "deferred" | "settled" | "already-settled";
        txHash?: string;
        paidUsd?: string;
        /** For deferred entries: when the pool period ends, ISO-8601 UTC.
         *  The note stays plain prose; no raw epoch seconds in it. */
        periodEndIso?: string;
        note?: string;
      }
    /** stage vocabulary: "buy" | "attester" | "record" | "settle". */
    | { kind: "error"; stage: string; message: string }
  );

export type LedgerEntryInput = LedgerEntry extends infer E
  ? E extends Stamped
    ? Omit<E, "at">
    : never
  : never;

export class LedgerInvariantError extends Error {}

/** Append-only list of entries for one claim. */
function ledgerListKey(goalId: string): string {
  return `agent-ledger-${goalId.toLowerCase()}.jsonl`;
}

/** Pre-migration whole-blob ledger. Still read so nothing already written is
 *  orphaned; copied into the list the first time the claim is appended to. */
function legacyLedgerFile(goalId: string): string {
  return `agent-ledger-${goalId.toLowerCase()}.json`;
}

function ledgerLockName(goalId: string): string {
  return `agent-ledger:${goalId.toLowerCase()}`;
}

// Long enough to cover a slow Redis round trip, short enough that a lambda
// killed mid-append does not block the next one for long.
const LEDGER_LOCK_TTL_MS = 5_000;

// The store is key/value with no scan, so the /agent feed needs its own
// index: one member per claim, added when the claim's plan lands (the plan is
// every claim's first entry, so one index write per claim, ever). A sorted set
// scored by timestamp is idempotent by member, which is what removes both the
// read-then-dedupe pass and the whole-blob rewrite.
const LEDGER_INDEX_KEY = "agent-ledger-index.zset";

/** Pre-migration index blob, merged in on read so older claims keep showing
 *  up in the feed and the settlement sweep. */
const LEGACY_LEDGER_INDEX_FILE = "agent-ledger-index.json";

export interface LedgerIndexEntry {
  goalId: string;
  at: string;
}

// Sorted-set scores are milliseconds, so two claims planned inside the same
// millisecond would tie and order arbitrarily. Nudging the score forward keeps
// insertion order stable for everything one process indexed; across instances
// a tie is harmless because both entries still appear.
let lastIndexScore = 0;

function indexScore(at: string): number {
  const ms = Date.parse(at);
  const score = ms > lastIndexScore ? ms : lastIndexScore + 0.001;
  lastIndexScore = score;
  return score;
}

/** Claims SPOTTER has touched, most recent first. */
export async function listLedgerGoalIds(
  limit = 20,
): Promise<LedgerIndexEntry[]> {
  if (limit <= 0) return [];

  const merged = new Map<string, LedgerIndexEntry>();
  for (const { member, score } of await zrevrange(LEDGER_INDEX_KEY, limit)) {
    merged.set(member, {
      goalId: member,
      at: new Date(Math.floor(score)).toISOString(),
    });
  }
  for (const entry of await readJson<LedgerIndexEntry[]>(
    LEGACY_LEDGER_INDEX_FILE,
    [],
  )) {
    if (!merged.has(entry.goalId)) merged.set(entry.goalId, entry);
  }

  // Stable sort: ties keep the sorted set's own (sub-millisecond) ordering.
  return [...merged.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

async function indexGoal(goalId: string, at: string): Promise<void> {
  await zaddNx(LEDGER_INDEX_KEY, goalId.toLowerCase(), indexScore(at));
}

/** Whole-cent USD amounts only; anything else is a bug upstream. */
function usdToCents(amount: string, context: string): number {
  if (!/^\d+\.\d{2}$/.test(amount)) {
    throw new LedgerInvariantError(
      `${context}: amount ${JSON.stringify(amount)} must be a USD string with exactly two decimals`,
    );
  }
  const [dollars, cents] = amount.split(".");
  return Number(dollars) * 100 + Number(cents);
}

function centsToUsd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  return `${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

export function defaultClaimCapUsd(): string {
  return optionalEnv("AGENT_CLAIM_CAP_USD", DEFAULT_CLAIM_CAP_USD);
}

interface LedgerState {
  entries: LedgerEntry[];
  /** Entries came from the pre-migration blob and are not in the list yet. */
  fromLegacy: boolean;
}

async function loadLedger(goalId: string): Promise<LedgerState> {
  const entries = await readJsonList<LedgerEntry>(ledgerListKey(goalId));
  if (entries.length > 0) return { entries, fromLegacy: false };

  const legacy = await readJson<LedgerEntry[]>(legacyLedgerFile(goalId), []);
  return { entries: legacy, fromLegacy: legacy.length > 0 };
}

export async function readLedger(goalId: string): Promise<LedgerEntry[]> {
  return (await loadLedger(goalId)).entries;
}

export function totalSpentUsd(entries: LedgerEntry[]): string {
  let cents = 0;
  for (const entry of entries) {
    if (entry.kind === "spend") {
      cents += usdToCents(entry.amountUsd, "totalSpentUsd");
    }
  }
  return centsToUsd(cents);
}

export function findSpend(
  entries: LedgerEntry[],
  service: string,
  ref: string,
): Extract<LedgerEntry, { kind: "spend" }> | undefined {
  return entries.find(
    (e): e is Extract<LedgerEntry, { kind: "spend" }> =>
      e.kind === "spend" && e.service === service && e.ref === ref,
  );
}

function planOf(
  entries: LedgerEntry[],
): Extract<LedgerEntry, { kind: "plan" }> | undefined {
  return entries.find(
    (e): e is Extract<LedgerEntry, { kind: "plan" }> => e.kind === "plan",
  );
}

function assertAppendAllowed(
  entries: LedgerEntry[],
  entry: LedgerEntryInput,
): void {
  if (entry.kind === "plan") {
    if (planOf(entries) !== undefined) {
      throw new LedgerInvariantError(
        "a plan entry already exists for this goal; the plan is emitted once",
      );
    }
    usdToCents(entry.capUsd, "plan.capUsd");
    for (const step of entry.steps) {
      usdToCents(step.estUsd, `plan step ${step.service}`);
    }
    return;
  }

  if (entry.kind === "spend") {
    const plan = planOf(entries);
    if (plan === undefined) {
      throw new LedgerInvariantError(
        "no plan entry exists for this goal; SPOTTER emits its plan before any spend",
      );
    }
    const spent = usdToCents(totalSpentUsd(entries), "ledger total");
    const next = usdToCents(entry.amountUsd, "spend.amountUsd");
    const cap = usdToCents(plan.capUsd, "plan.capUsd");
    if (spent + next > cap) {
      throw new LedgerInvariantError(
        `spend of ${entry.amountUsd} USDC would break the ${plan.capUsd} USDC ` +
          `cap for this claim (already spent ${centsToUsd(spent)})`,
      );
    }
  }
}

function stamp(entry: LedgerEntryInput): LedgerEntry {
  return { ...entry, at: new Date().toISOString() } as LedgerEntry;
}

/**
 * Append one entry, enforcing the plan-before-spend and cap invariants.
 * Returns the full ledger including the new entry.
 *
 * Entries that carry an invariant, and the one-time copy of a pre-migration
 * ledger into the list, run under a per-goal lock so two concurrent callers
 * cannot each decide a spend fits under the cap. Everything else appends
 * straight through: RPUSH is atomic, so nothing is lost.
 */
export async function appendLedger(
  goalId: string,
  entry: LedgerEntryInput,
): Promise<LedgerEntry[]> {
  const state = await loadLedger(goalId);
  const guarded =
    state.fromLegacy || entry.kind === "plan" || entry.kind === "spend";

  if (!guarded) {
    assertAppendAllowed(state.entries, entry);
    const stamped = stamp(entry);
    await appendJson(ledgerListKey(goalId), stamped);
    return [...state.entries, stamped];
  }

  return withLock(ledgerLockName(goalId), LEDGER_LOCK_TTL_MS, async () => {
    // Re-read inside the lock: whoever held it before us may have appended.
    const fresh = await loadLedger(goalId);
    if (fresh.fromLegacy) {
      // Move the old blob into the list before appending, or the list would
      // read as a ledger with no plan and every later invariant check would
      // be made against a truncated history. The blob is left in place; once
      // the list is non-empty it is never read again.
      await appendJsonAll(ledgerListKey(goalId), fresh.entries);
    }

    assertAppendAllowed(fresh.entries, entry);
    const stamped = stamp(entry);

    // Index BEFORE the append. These are two commands and a process that dies
    // between them has to fail in the recoverable direction: an indexed goal
    // with no entries yet is skipped by the sweep and renders as an empty
    // claim, and the retry re-appends the plan under the original score. The
    // other order strands a planned claim outside the index forever, which
    // means it is never swept and the achiever is never paid.
    if (stamped.kind === "plan") {
      await indexGoal(goalId, stamped.at);
    }
    await appendJson(ledgerListKey(goalId), stamped);
    return [...fresh.entries, stamped];
  });
}
