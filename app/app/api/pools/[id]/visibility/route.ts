// POST /api/pools/[id]/visibility - set a pool public or private.
//
// The visibility flag is owner-owned and mutable, so the write is gated exactly
// like the challenge mint (see /api/challenges): a wallet address and a pool id
// are both public, so neither proves authorship on its own.
//   1. An EIP-191 signature proving the caller controls `address`
//      (requireAddressSignature). Only after it verifies does anything write.
//   2. An on-chain read proving that same address is the pool's creator.
// A private write mints (or reuses) an unguessable share token; the response
// carries the /p/[token] path so the owner can hand out the private link.
//
// Request JSON: { address, visibility: "public" | "private" }
// Response JSON: { visibility, sharePath } - sharePath is /p/<token> when the
// pool is now private, else null.

import { getAddress } from "viem";
import { fetchPool } from "@/lib/contract";
import {
  setPoolVisibility,
  type PoolVisibility,
} from "@/lib/server/pool-visibility";
import { requireAddressSignature } from "@/lib/server/wallet-auth";
import {
  jsonError,
  newCorrelationId,
  readJsonBody,
  safeError,
} from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** Parse a route id into a positive bigint, or null when it is not a usable id. */
function parsePoolId(raw: string): bigint | null {
  if (!/^[0-9]+$/.test(raw.trim())) return null;
  const value = BigInt(raw.trim());
  return value > 0n ? value : null;
}

export async function POST(request: Request, ctx: Ctx) {
  const cid = newCorrelationId("pool-visibility-set");
  try {
    const { id } = await ctx.params;
    const poolId = parsePoolId(id);
    if (poolId === null) {
      return jsonError(400, "poolId must be a positive integer");
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Request body must be a JSON object.");
    }

    const { address, visibility } = body;
    if (typeof address !== "string" || address === "") {
      return jsonError(400, "address must be a 0x address string");
    }
    if (visibility !== "public" && visibility !== "private") {
      return jsonError(400, 'visibility must be "public" or "private"');
    }

    // Proof 1: the signature must be for THIS address, not merely some address.
    const auth = await requireAddressSignature(request, address);
    if (!auth.ok) {
      return jsonError(401, "Sign with the wallet that created this pool.");
    }

    // Proof 2: that address must be the pool's on-chain creator. A missing or
    // unreadable pool fails closed rather than writing a flag for nothing.
    let creator: string;
    try {
      const pool = await fetchPool(poolId);
      creator = getAddress(pool.creator);
    } catch {
      return jsonError(404, "That pool could not be found on Arc.");
    }
    if (creator !== auth.address) {
      return jsonError(
        403,
        "Only the wallet that created this pool can change its visibility.",
      );
    }

    const result = await setPoolVisibility({
      poolId,
      ownerAddress: auth.address,
      visibility: visibility as PoolVisibility,
    });
    if (!result.ok) {
      return jsonError(result.status, result.reason);
    }

    return Response.json({
      visibility: result.visibility,
      sharePath:
        result.visibility === "private" && result.shareToken !== null
          ? `/p/${result.shareToken}`
          : null,
    });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
