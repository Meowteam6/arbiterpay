// Read-only view of the treasury's Arc USDC balance.
//
// WHY IT LIVES HERE
// Two money routes (the faucet and the balance withdrawal) must refuse rather
// than drain the treasury, so both need its balance. This is deliberately NOT
// in lib/server/treasury.ts: that module holds the signer and can move funds,
// while nothing in this file can. Keeping the read separate means the floor
// check cannot accidentally acquire the ability to spend.
//
// The address is derived from the same TREASURY_PRIVATE_KEY the signer uses,
// so the floor is always measured against the wallet that will actually pay.
// There is no TREASURY_ADDRESS env var to drift out of sync.
//
// `_money` is a Next private folder: the App Router opts the folder and its
// contents out of routing, so nothing here is reachable over HTTP.
// Server only.

import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_ADDRESS, erc20Abi, getArcPublicClient } from "@/lib/contract";
import { requireEnv } from "@/lib/server/env";

/** Treasury EOA that pays out Arc USDC, derived from the signing key. */
export function treasuryAddress(): Address {
  const key = requireEnv("TREASURY_PRIVATE_KEY");
  const normalized = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  return privateKeyToAccount(normalized).address;
}

/**
 * Current treasury USDC balance in uUSDC (6 decimals), read from Arc testnet.
 *
 * Throws when the key is missing or the RPC is unreachable. Callers must let
 * that fail the request: a money route that cannot see the treasury balance
 * has no business moving money, and failing closed is the point of the floor.
 */
export async function treasuryUsdcBalanceUusdc(): Promise<bigint> {
  return await getArcPublicClient().readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [treasuryAddress()],
  });
}
