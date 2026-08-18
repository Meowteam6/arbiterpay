// POST /api/social/handle - claim (or re-claim) a handle for a wallet.
//
// A handle is public identity, and a wallet address is public, so the address
// in the body proves nothing on its own. The write is gated by an EIP-191
// signature that proves the caller controls THAT address (requireAddressSignature
// in lib/server/wallet-auth.ts, the same proof the Junction and Unlink routes
// use). Only after the signature verifies does the service-role client write -
// every anon/publishable-key path is SELECT-only by RLS, so this route is the
// single writer and the signature is its lock.
//
// Request JSON: { address, handle, emoji? }
// Response JSON: { profile: { address, handle, emoji } } on success.

import { claimHandle } from "@/lib/server/social-profile";
import { requireAddressSignature } from "@/lib/server/wallet-auth";
import {
  jsonError,
  newCorrelationId,
  readJsonBody,
  safeError,
} from "@/lib/server/http";

export async function POST(request: Request) {
  const cid = newCorrelationId("social-handle");
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Request body must be a JSON object.");
    }

    const { address, handle, emoji } = body;
    if (typeof address !== "string" || address === "") {
      return jsonError(400, "address must be a 0x address string");
    }
    if (typeof handle !== "string") {
      return jsonError(400, "handle must be a string");
    }
    if (emoji !== undefined && emoji !== null && typeof emoji !== "string") {
      return jsonError(400, "emoji must be a string when provided");
    }

    // The proof must be for THIS address, not merely some address.
    const auth = await requireAddressSignature(request, address);
    if (!auth.ok) {
      return jsonError(401, "Sign with the wallet you are claiming for.");
    }

    const result = await claimHandle({
      rawAddress: auth.address,
      rawHandle: handle,
      rawEmoji: emoji ?? null,
    });
    if (!result.ok) {
      return jsonError(result.status, result.reason);
    }
    return Response.json({ profile: result.profile });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
