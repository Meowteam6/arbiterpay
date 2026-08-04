// GET/POST /api/agent/sweep - settle every recorded claim whose pool period
// has ended, driven by Vercel cron (app/vercel.json, every two minutes).
//
// Why this exists: the run route only settles while a browser is polling it.
// A participant whose pool ends after they close the tab would otherwise
// never be paid - the exact "manual checkout" failure the agent exists to
// remove. The sweep finds claims that are recorded but not settled and drives
// the SAME settle block the run loop uses (settleRecordedClaim), so both paths
// append identical ledger entries and both assert on the AchieverPaid payout,
// never on transaction success.
//
// Each claim's pool linkage (poolId + participant) is stored in its plan
// entry at plan time, which is what makes this route self-sufficient: no
// request body, no chain scan, just the ledger.
//
// WHAT IT READS. Primary source is the pending-settlement queue (lock.ts): a
// sorted set of claims scored by the moment they become settleable, written
// when a claim defers and removed when it settles. The sweep reads only what
// is actually due instead of walking the newest N ledgers and asking the chain
// about each one. A bounded index scan still runs afterwards, with whatever
// time budget is left, for claims recorded before the queue existed; those get
// migrated into the queue as they are seen, so the fallback drains itself.
//
// TIME BUDGET. Settles are sequential (each is a Circle transaction plus an
// inclusion wait) and the function window is 60s. Without a budget the loop is
// killed mid-claim with no checkpoint. It therefore stops cleanly at 45s and
// reports `truncated`; the next cron tick two minutes later picks up where it
// left off, because eligibility is derived from the ledger, not from position
// in a list.
//
// SINGLE FLIGHT. A manual run and the cron tick must not overlap - two sweeps
// would race each other's settles. One lock, held for the whole sweep; a
// second caller is told a sweep is already running and changes nothing.
//
// Auth: `authorization: Bearer ${CRON_SECRET}`, timing-safe compared. Vercel
// cron sends exactly that header (as a GET) when the CRON_SECRET env var
// exists, so GET and POST share one handler.
//
// Response JSON:
//   { swept: [...goalIds], settled, deferred, errors, truncated, skipped? }

import { timingSafeEqual } from "crypto";
import { isAddress, type Address, type Hex } from "viem";
import {
  settleRecordedClaim,
  SETTLE_UNPAYABLE_MESSAGE,
  type SettleClaimDeps,
} from "@/lib/server/agent/run";
import {
  addPendingSettlement,
  listDuePendingSettlements,
  removePendingSettlement,
  withLock,
} from "@/lib/server/agent/lock";
import {
  listLedgerGoalIds,
  readLedger,
  type LedgerEntry,
} from "@/lib/server/agent/ledger";
import { getCircleClient } from "@/lib/server/agent/wallet";
import { arcReader } from "@/lib/server/agent/spotter";
import { liveBuyDeps } from "@/lib/server/agent/x402";
import { requireEnv } from "@/lib/server/env";
import { errorMessage, jsonError } from "@/lib/server/http";

// One sweep can settle several pools, each a Circle transaction plus an
// inclusion wait; the default function window is not enough for that.
export const maxDuration = 60;

/** Stop cleanly with this much of the window left, so the response is written
 *  and the queue state is consistent instead of being killed mid-settle. */
const SWEEP_BUDGET_MS = 45_000;

/** Above maxDuration, so a killed sweep's lock always expires. */
const SWEEP_LOCK_TTL_MS = 75_000;
const SWEEP_LOCK = "agent:sweep";

/** How many due claims one sweep pulls from the queue. Comfortably more than
 *  the time budget can settle; the remainder is picked up next tick. */
const DUE_BATCH = 200;

/** Fallback horizon for claims recorded before the pending queue existed.
 *  Bounded on purpose: the queue is the real index, this is a migration path
 *  that drains itself as legacy claims are re-queued or settle. */
const FALLBACK_SCAN_LIMIT = 100;

interface SweepCounts {
  swept: string[];
  settled: number;
  deferred: number;
  errors: number;
  truncated: boolean;
}

function authorized(request: Request): boolean {
  const expected = Buffer.from(`Bearer ${requireEnv("CRON_SECRET")}`);
  const header = request.headers.get("authorization");
  if (header === null) return false;
  const provided = Buffer.from(header);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

type Eligibility =
  | { settle: true; poolId: bigint; participant: Address }
  | { settle: false };

/**
 * Decide whether a claim is worth a settle attempt, from its ledger alone.
 * Claims that are done or beyond recovery are dropped from the pending queue
 * here, which is what keeps the queue from growing without bound.
 */
async function eligibility(
  goalId: string,
  ledger: LedgerEntry[],
  nowMs: number,
): Promise<Eligibility> {
  // Only claims whose on-chain writes are in: no record, nothing to pay.
  if (!ledger.some((e) => e.kind === "record")) return { settle: false };
  // Already paid - the run loop's fast path would say "paid" too.
  if (ledger.some((e) => e.kind === "settle" && e.status === "settled")) {
    await removePendingSettlement(goalId);
    return { settle: false };
  }
  // Terminal: the pool settled without this claim; retrying cannot help.
  if (
    ledger.some(
      (e) =>
        e.kind === "error" &&
        e.stage === "settle" &&
        e.message === SETTLE_UNPAYABLE_MESSAGE,
    )
  ) {
    await removePendingSettlement(goalId);
    return { settle: false };
  }
  const plan = ledger.find((e) => e.kind === "plan");
  if (
    plan?.poolId === undefined ||
    !/^\d+$/.test(plan.poolId) ||
    plan.participant === undefined ||
    !isAddress(plan.participant)
  ) {
    // A claim planned before the pool linkage existed; the run route is
    // the only thing that can settle it.
    return { settle: false };
  }

  // The deferred entry already carries the moment this becomes settleable.
  // Honouring it costs nothing and saves an RPC round trip per claim that is
  // still inside its pool period; it also re-queues legacy claims so the
  // fallback scan stops finding them.
  const deferred = ledger.find(
    (e): e is Extract<LedgerEntry, { kind: "settle" }> =>
      e.kind === "settle" && e.status === "deferred",
  );
  const dueMs =
    deferred?.periodEndIso === undefined
      ? null
      : Date.parse(deferred.periodEndIso);
  if (dueMs !== null && Number.isFinite(dueMs)) {
    await addPendingSettlement(goalId, Math.floor(dueMs / 1000));
    if (dueMs > nowMs) return { settle: false };
  }

  return {
    settle: true,
    poolId: BigInt(plan.poolId),
    participant: plan.participant as Address,
  };
}

async function runSweep(): Promise<SweepCounts> {
  const deps: SettleClaimDeps = {
    spotter: { circle: getCircleClient(), reader: arcReader() },
    buy: liveBuyDeps(),
  };

  const startedAt = Date.now();
  const counts: SweepCounts = {
    swept: [],
    settled: 0,
    deferred: 0,
    errors: 0,
    truncated: false,
  };
  const seen = new Set<string>();

  const outOfTime = () => Date.now() - startedAt >= SWEEP_BUDGET_MS;

  const consider = async (rawGoalId: string): Promise<void> => {
    const goalId = rawGoalId.toLowerCase();
    if (seen.has(goalId)) return;
    seen.add(goalId);

    const ledger = await readLedger(goalId);
    const verdict = await eligibility(goalId, ledger, Date.now());
    if (!verdict.settle) return;

    counts.swept.push(goalId);
    const outcome = await settleRecordedClaim(deps, {
      goalId: goalId as Hex,
      poolId: verdict.poolId,
      participant: verdict.participant,
    });
    if (outcome.status === "settled") counts.settled += 1;
    else if (outcome.status === "deferred") counts.deferred += 1;
    else counts.errors += 1;
  };

  const due = await listDuePendingSettlements(
    Math.floor(Date.now() / 1000),
    DUE_BATCH,
  );
  for (const goalId of due) {
    if (outOfTime()) {
      counts.truncated = true;
      return counts;
    }
    await consider(goalId);
  }

  // Migration path for claims recorded before the pending queue existed.
  for (const { goalId } of await listLedgerGoalIds(FALLBACK_SCAN_LIMIT)) {
    if (outOfTime()) {
      counts.truncated = true;
      return counts;
    }
    await consider(goalId);
  }

  return counts;
}

async function sweep(): Promise<Response> {
  const outcome = await withLock(SWEEP_LOCK, SWEEP_LOCK_TTL_MS, runSweep);
  if (outcome.acquired) return Response.json(outcome.value);
  // Another sweep (a cron tick, or a manual run) holds the lock. Overlapping
  // sweeps would race each other's settles, so this one changes nothing and
  // says so.
  return Response.json({
    swept: [],
    settled: 0,
    deferred: 0,
    errors: 0,
    truncated: false,
    skipped: "a sweep is already running",
  });
}

async function handle(request: Request): Promise<Response> {
  try {
    if (!authorized(request)) {
      return jsonError(401, "Missing or invalid authorization bearer token");
    }
    return await sweep();
  } catch (err) {
    // Never hand the caller raw internals: cron sees a generic failure, the
    // detail goes to the server log where the operator can read it.
    console.error(`[agent/sweep] failed: ${errorMessage(err)}`);
    return jsonError(500, "The settlement sweep failed. See the server logs.");
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
