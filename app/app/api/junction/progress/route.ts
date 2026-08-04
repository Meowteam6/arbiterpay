// GET /api/junction/progress?address=0x...&threshold=75&goalDays=7
//   optional: &start=<unixSeconds>&end=<unixSeconds>  (a pool's period window)
// Returns the address's streak from connected Junction data:
//   { connected, metric, streakDays, targetDays, lastSync }
// When start/end are given, progress is scoped to that pool period (counting
// from the goal's start), and targetDays is the period length in days.
// connected=false (rather than 404) when no provider is linked yet.
//
// AUTH: the caller must prove control of `address` with a fresh wallet
// signature (see lib/server/wallet-auth.ts for the header contract). The
// streak, the metric label, and the last sync time are all derived from that
// person's sleep data, and a wallet address is public — it is on chain and in
// this app's own participant lists — so possession of one cannot be treated as
// permission to read their health history. The response shape is unchanged, so
// the dashboard works as-is once it signs.

import { type NextRequest } from "next/server";
import { isAddress } from "viem";
import { getProgress, isConnected } from "@/lib/server/junction";
import { jsonError } from "@/lib/server/http";
import { requireAddressSignature } from "@/lib/server/wallet-auth";

/**
 * Upstream failures are logged with detail and answered without any. The
 * Junction error text carries the request path, the account state, and the
 * provider's own message; none of that belongs in a response to a caller who
 * may not even be the account holder.
 */
function upstreamFailure(err: unknown): Response {
  console.error("[junction/progress] upstream request failed", err);
  return jsonError(502, "Health data is temporarily unavailable");
}

function parsePositiveInt(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 100) return null;
  return n;
}

function unixToISO(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const address = params.get("address");
    if (address === null || !isAddress(address)) {
      return jsonError(400, "Query param address must be a valid 0x address");
    }

    const auth = await requireAddressSignature(request, address);
    if (!auth.ok) {
      return jsonError(401, `Wallet signature required: ${auth.reason}`);
    }

    const threshold = parsePositiveInt(params.get("threshold"), 75);
    const goalDays = parsePositiveInt(params.get("goalDays"), 7);
    if (threshold === null || goalDays === null) {
      return jsonError(400, "threshold and goalDays must be integers in 1..100");
    }

    // Optional pool window (unix seconds). When present, scope to the period.
    const startSec = Number(params.get("start"));
    const endSec = Number(params.get("end"));
    const hasWindow =
      Number.isFinite(startSec) && startSec > 0 && Number.isFinite(endSec) && endSec > startSec;
    const windowStartISO = hasWindow ? unixToISO(startSec) : undefined;
    const windowEndISO = hasWindow ? unixToISO(endSec) : undefined;
    const targetDays = hasWindow
      ? Math.floor((endSec - startSec) / 86400) + 1
      : goalDays;

    if (!(await isConnected(address))) {
      return Response.json({
        connected: false,
        metric: null,
        streakDays: null,
        targetDays,
        lastSync: null,
      });
    }

    const progress = await getProgress(
      address,
      threshold,
      goalDays,
      windowStartISO,
      windowEndISO,
    );
    return Response.json({
      connected: true,
      metric: hasWindow
        ? `Sleep score ≥ ${threshold} · since ${windowStartISO}`
        : `Sleep score ≥ ${threshold}`,
      streakDays: progress.streakDays,
      targetDays,
      lastSync: progress.days[0]?.date ?? null,
    });
  } catch (err) {
    return upstreamFailure(err);
  }
}
