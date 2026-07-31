// GET/POST /api/agent/sweep - settle every recorded claim whose pool period
// has ended, driven by Vercel cron (app/vercel.json, every two minutes).
//
// Why this exists: the run route only settles while a browser is polling it.
// A participant whose pool ends after they close the tab would otherwise
// never be paid - the exact "manual checkout" failure the agent exists to
// remove. The sweep reads SPOTTER's own ledger index, finds claims that are
// recorded but not settled, and drives the SAME settle block the run loop
// uses (settleRecordedClaim), so both paths append identical ledger entries
// and both assert on the AchieverPaid payout, never on transaction success.
//
// Each claim's pool linkage (poolId + participant) is stored in its plan
// entry at plan time, which is what makes this route self-sufficient: no
// request body, no chain scan, just the ledger.
//
// Concurrency: settleRecordedClaim serializes per goalId within a process,
// and its already-settled branch reconciles against the pool's AchieverPaid
// log - one settle() pays every eligible achiever at once, so claims in the
// same pool (or a race with the browser-driven run route on another
// instance) converge on the recorded payout instead of a false failure.
//
// Auth: `authorization: Bearer ${CRON_SECRET}`, timing-safe compared. Vercel
// cron sends exactly that header (as a GET) when the CRON_SECRET env var
// exists, so GET and POST share one handler.
//
// Response JSON: { swept: [...goalIds], settled: n, deferred: n, errors: n }

import { timingSafeEqual } from "crypto";
import { isAddress, type Address, type Hex } from "viem";
import {
  settleRecordedClaim,
  SETTLE_UNPAYABLE_MESSAGE,
  type SettleClaimDeps,
} from "@/lib/server/agent/run";
import { listLedgerGoalIds, readLedger } from "@/lib/server/agent/ledger";
import { getCircleClient } from "@/lib/server/agent/wallet";
import { arcReader } from "@/lib/server/agent/spotter";
import { liveBuyDeps } from "@/lib/server/agent/x402";
import { requireEnv } from "@/lib/server/env";
import { errorMessage, jsonError } from "@/lib/server/http";

// One sweep can settle several pools, each a Circle transaction plus an
// inclusion wait; the default function window is not enough for that.
export const maxDuration = 60;

/** How many claims (newest first) one sweep considers. Generous next to the
 *  demo's claim count; a claim beyond this horizon is settled the moment it
 *  is polled through the run route instead, or by the AchieverPaid
 *  reconciliation once its pool settles through any other claim. Revisit
 *  with a pending-settlement index if claim volume ever approaches this. */
const SWEEP_LIMIT = 500;

function authorized(request: Request): boolean {
  const expected = Buffer.from(`Bearer ${requireEnv("CRON_SECRET")}`);
  const header = request.headers.get("authorization");
  if (header === null) return false;
  const provided = Buffer.from(header);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

async function sweep(): Promise<Response> {
  const deps: SettleClaimDeps = {
    spotter: { circle: getCircleClient(), reader: arcReader() },
    buy: liveBuyDeps(),
  };

  const index = await listLedgerGoalIds(SWEEP_LIMIT);
  const swept: string[] = [];
  let settled = 0;
  let deferred = 0;
  let errors = 0;

  for (const { goalId } of index) {
    const ledger = await readLedger(goalId);
    // Only claims whose on-chain writes are in: no record, nothing to pay.
    if (!ledger.some((e) => e.kind === "record")) continue;
    // Already paid - the run loop's fast path would say "paid" too.
    if (ledger.some((e) => e.kind === "settle" && e.status === "settled")) {
      continue;
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
      continue;
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
      continue;
    }

    swept.push(goalId);
    const outcome = await settleRecordedClaim(deps, {
      goalId: goalId as Hex,
      poolId: BigInt(plan.poolId),
      participant: plan.participant as Address,
    });
    if (outcome.status === "settled") settled += 1;
    else if (outcome.status === "deferred") deferred += 1;
    else errors += 1;
  }

  return Response.json({ swept, settled, deferred, errors });
}

async function handle(request: Request): Promise<Response> {
  try {
    if (!authorized(request)) {
      return jsonError(401, "Missing or invalid authorization bearer token");
    }
    return await sweep();
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
