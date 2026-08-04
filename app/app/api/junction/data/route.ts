// GET /api/junction/data?address=0x...&days=7
// Recent per-day sleep + activity from the linked provider, for the dashboard
// demo display. { connected, sleep[], activity[] }.
//
// AUTH: the caller must prove control of `address` with a fresh wallet
// signature (see lib/server/wallet-auth.ts for the header contract). This
// route returns somebody's per-day sleep scores, sleep hours, and step counts
// keyed on a wallet address — a value that is public on chain and visible in
// this app's own participant lists. Without the signature, reading a stranger's
// health history took nothing more than copying their address out of a pool.
// The response shape is unchanged, so the dashboard works as-is once it signs.

import { type NextRequest } from "next/server";
import { isAddress } from "viem";
import { getRecent, isConnected } from "@/lib/server/junction";
import { jsonError } from "@/lib/server/http";
import { requireAddressSignature } from "@/lib/server/wallet-auth";

/**
 * Upstream failures are logged with detail and answered without any. The
 * Junction error text carries the request path, the account state, and the
 * provider's own message; none of that belongs in a response to a caller who
 * may not even be the account holder.
 */
function upstreamFailure(err: unknown): Response {
  console.error("[junction/data] upstream request failed", err);
  return jsonError(502, "Health data is temporarily unavailable");
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

    const daysRaw = Number(params.get("days") ?? 7);
    const days = Number.isInteger(daysRaw) && daysRaw > 0 && daysRaw <= 30 ? daysRaw : 7;

    if (!(await isConnected(address))) {
      return Response.json({ connected: false, sleep: [], activity: [] });
    }
    const recent = await getRecent(address, days);
    return Response.json({ connected: true, ...recent });
  } catch (err) {
    return upstreamFailure(err);
  }
}
