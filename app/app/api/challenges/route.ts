// POST /api/challenges - mint the shareable challenge link for a pool.
//
// A challenge IS a pool: the client has already created the pool on-chain
// (challenger-funded, entryFee 0, split-pot) through the same useUsdcDeposit
// funnel the sponsor create flow uses. This route writes the one off-chain row
// that makes the pool "aimed at a person" - an unguessable invite token plus
// the challenger's framing text - and returns the token so the client can
// reveal the link.
//
// TWO PROOFS GATE THE WRITE, because a wallet address and a pool id are both
// public and neither proves authorship on its own:
//   1. An EIP-191 signature proving the caller controls `address`
//      (requireAddressSignature, the same proof the handle/junction/unlink
//      routes use). Only after it verifies does the service-role client write.
//   2. An on-chain read proving that same address is the pool's creator. Without
//      it, anyone could mint a challenge link pointing at somebody else's pool.
//
// Request JSON: { address, poolId, targetHandle?, message? }
// Response JSON: { challenge: { inviteToken, poolId }, sharePath } on success.

import { getAddress } from "viem";
import { fetchPool } from "@/lib/contract";
import { poolCanPay } from "@/lib/pool-lifecycle";
import { createChallenge } from "@/lib/server/challenges";
import { requireAddressSignature } from "@/lib/server/wallet-auth";
import {
  jsonError,
  newCorrelationId,
  readJsonBody,
  safeError,
} from "@/lib/server/http";

/** Parse a pool id from the JSON body (number or decimal string) into a
 *  positive bigint, or null when it is not a usable id. */
function parsePoolId(raw: unknown): bigint | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return BigInt(raw);
  }
  if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    const value = BigInt(raw.trim());
    return value > 0n ? value : null;
  }
  return null;
}

export async function POST(request: Request) {
  const cid = newCorrelationId("challenges-create");
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Request body must be a JSON object.");
    }

    const { address, poolId, targetHandle, message } = body;
    if (typeof address !== "string" || address === "") {
      return jsonError(400, "address must be a 0x address string");
    }
    const poolIdValue = parsePoolId(poolId);
    if (poolIdValue === null) {
      return jsonError(400, "poolId must be a positive integer");
    }
    if (
      targetHandle !== undefined &&
      targetHandle !== null &&
      typeof targetHandle !== "string"
    ) {
      return jsonError(400, "targetHandle must be a string when provided");
    }
    if (
      message !== undefined &&
      message !== null &&
      typeof message !== "string"
    ) {
      return jsonError(400, "message must be a string when provided");
    }

    // Proof 1: the signature must be for THIS address, not merely some address.
    const auth = await requireAddressSignature(request, address);
    if (!auth.ok) {
      return jsonError(401, "Sign with the wallet that created this pool.");
    }

    // Proof 2: that address must be the pool's on-chain creator. A missing or
    // unreadable pool fails closed rather than minting a link to nothing.
    let creator: string;
    let canPay: boolean;
    try {
      const pool = await fetchPool(poolIdValue);
      creator = getAddress(pool.creator);
      canPay = poolCanPay(pool);
    } catch {
      return jsonError(404, "That pool could not be found on Arc.");
    }
    if (creator !== auth.address) {
      return jsonError(
        403,
        "Only the wallet that created this pool can send a challenge for it.",
      );
    }
    // A challenge that cannot pay its target is not worth minting a link for.
    // The create form always builds a payable pool (split-pot); this is the
    // backstop against a hand-built request pointing at a dead pool.
    if (!canPay) {
      return jsonError(
        409,
        "This pool cannot pay out, so it cannot be sent as a challenge.",
      );
    }

    const result = await createChallenge({
      rawChallengerAddress: auth.address,
      poolId: poolIdValue,
      rawTargetHandle: targetHandle ?? null,
      rawMessage: message ?? null,
    });
    if (!result.ok) {
      return jsonError(result.status, result.reason);
    }

    return Response.json({
      challenge: {
        inviteToken: result.challenge.inviteToken,
        poolId: result.challenge.poolId,
      },
      sharePath: `/c/${result.challenge.inviteToken}`,
    });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
