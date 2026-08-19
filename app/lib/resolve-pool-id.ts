import { decodeEventLog } from "viem";
import {
  getArcPublicClient,
  getHealthPoolsAddress,
  healthPoolsAbi,
} from "@/lib/contract";

/**
 * Read the new pool id out of a createPool deposit receipt by decoding the
 * PoolCreated event. Falls back to the post-tx poolCount (ids run 1..count) if
 * the log cannot be decoded, so a redirect still lands somewhere useful.
 *
 * Shared by the sponsor create-pool funnel (CreatePool) and the peer-challenge
 * create funnel (CreateChallenge): both call createPool through the same
 * useUsdcDeposit chokepoint and need the resulting pool id to route the user
 * onward, so the resolution lives in one place rather than being duplicated.
 */
export async function resolveNewPoolId(
  depositHash: `0x${string}`,
): Promise<bigint> {
  const address = getHealthPoolsAddress();
  if (address === null) {
    throw new Error("HealthPools contract address is not configured.");
  }
  const client = getArcPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: depositHash });

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: healthPoolsAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "PoolCreated") {
        return decoded.args.poolId;
      }
    } catch {
      // Not the event we want; keep scanning.
    }
  }

  const count = await client.readContract({
    address,
    abi: healthPoolsAbi,
    functionName: "poolCount",
  });
  return count;
}
