// POST /api/challenges/invited - the dares aimed at YOUR handle, in the app.
//
// Before this route the only way to discover a challenge someone aimed at you
// was the /c/[token] link they texted you. This is the in-app path: the caller
// proves they control a wallet, we resolve that wallet to its claimed handle,
// and we return the challenges whose target is that handle - each with the
// invite token that unlocks it on the landing.
//
// PRIVACY IS THE WHOLE POINT. An invite token is a capability: whoever holds it
// can read the health-adjacent goal on the /c/[token] landing, and the
// handle -> dare linkage is itself sensitive. So this route hands tokens to
// exactly one party - the signature-verified owner of the target handle:
//   1. requireAddressSignature proves the caller controls `address` (an address
//      alone is public and proves nothing).
//   2. getProfileByAddress binds that verified address to its claimed handle.
//      Handles are unique per address and claimed through a signed write, so
//      controlling the address IS owning the handle.
//   3. Only then does the service-role read return that handle's invites.
// A caller with no claimed handle cannot be targeted by handle, so they get an
// empty list rather than a probe into the table.
//
// Request JSON: { address }
// Response JSON: { invites: [{ poolId, inviteToken, challengerAddress, message }] }

import { getProfileByAddress } from "@/lib/server/social-profile";
import { getChallengesForTargetHandle } from "@/lib/server/challenges";
import { requireAddressSignature } from "@/lib/server/wallet-auth";
import {
  jsonError,
  newCorrelationId,
  readJsonBody,
  safeError,
} from "@/lib/server/http";

// Offline EIP-191 recovery (viem) plus the Supabase reads want the Node runtime.
export const runtime = "nodejs";

export async function POST(request: Request) {
  const cid = newCorrelationId("challenges-invited");
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Request body must be a JSON object.");
    }

    const { address } = body;
    if (typeof address !== "string" || address === "") {
      return jsonError(400, "address must be a 0x address string");
    }

    // The proof must be for THIS address, not merely some address - otherwise a
    // caller could sign for their own wallet and read another handle's tokens.
    const auth = await requireAddressSignature(request, address);
    if (!auth.ok) {
      return jsonError(401, "Sign with your wallet to see the dares aimed at you.");
    }

    // No claimed handle means nobody could have targeted this wallet by handle.
    // Return an empty list, never an error - the section simply stays hidden.
    const profile = await getProfileByAddress(auth.address);
    if (profile === null) {
      return Response.json({ invites: [] });
    }

    const invites = await getChallengesForTargetHandle(profile.handle);
    return Response.json({ invites });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
