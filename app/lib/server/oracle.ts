// Oracle signer for HealthPools on Arc testnet (server only).
//
// Arc testnet config (from docs.arc.io, captured in the build plan):
//   chain id 5042002, native gas token is USDC (18 decimals as gas). The RPC
//   endpoints and the shared fallback client live in lib/server/arc-client.ts;
//   this module builds no client of its own, because a per-call client against
//   a single endpoint is what made a rate-limited RPC look like a broken app.
//
// The recordResult ABI below matches the design-freeze interface in the
// build plan: recordResult(poolId, user, verdict, multiplierBps), oracle
// signer only. If the contract agent changes parameter types this snippet
// must be updated to match the deployed ABI.

import { type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcPublicClient, arcWalletClient } from "@/lib/server/arc-client";
import { requireEnv } from "@/lib/server/env";

const HEALTH_POOLS_ABI = [
  {
    type: "function",
    name: "recordResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "user", type: "address" },
      { name: "verdict", type: "bool" },
      // MUST be uint16 to match HealthPools.recordResult on-chain; uint256 here
      // produces a different 4-byte selector and the call reverts (no match).
      { name: "multiplierBps", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

export const BASE_MULTIPLIER_BPS = 10_000n;
export const COMEBACK_BONUS_BPS = 2_500n;
export const MULTIPLIER_CAP_BPS = 30_000n;
export const COMEBACK_THRESHOLD = 60;

function oracleAccount() {
  const pk = requireEnv("ORACLE_SIGNER_PRIVATE_KEY");
  const normalized = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  return privateKeyToAccount(normalized);
}

/**
 * Derive the payout multiplier in basis points.
 * Base 1x (10000). Comeback bonus +2500 when the week preceding the
 * current streak window averaged below 60. Capped at 3x (30000),
 * matching the contract's trailing-baseline cap.
 */
export function deriveMultiplierBps(baselineWeekAvg: number | null): bigint {
  let bps = BASE_MULTIPLIER_BPS;
  if (baselineWeekAvg !== null && baselineWeekAvg < COMEBACK_THRESHOLD) {
    bps += COMEBACK_BONUS_BPS;
  }
  return bps > MULTIPLIER_CAP_BPS ? MULTIPLIER_CAP_BPS : bps;
}

/**
 * Submit recordResult(poolId, user, verdict, multiplierBps) to HealthPools
 * on Arc testnet and wait for inclusion. Returns the tx hash.
 */
export async function recordResult(
  poolId: bigint,
  user: Address,
  verdict: boolean,
  multiplierBps: bigint,
): Promise<Hex> {
  const contract = requireEnv("HEALTH_POOLS_ADDRESS") as Address;
  const account = oracleAccount();
  const wallet = arcWalletClient(account);
  const publicClient = arcPublicClient();

  // simulate first so revert reasons surface as readable errors
  const { request } = await publicClient.simulateContract({
    account,
    address: contract,
    abi: HEALTH_POOLS_ABI,
    functionName: "recordResult",
    // multiplierBps is uint16 on-chain (<= 30000); viem types it as number.
    args: [poolId, user, verdict, Number(multiplierBps)],
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`recordResult tx ${hash} reverted on Arc testnet`);
  }
  return hash;
}
