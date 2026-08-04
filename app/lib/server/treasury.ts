// Treasury signer for sponsoring Arc USDC from a user's GoHealthMe balance
// (server only).
//
// The HealthPools contract pulls USDC from msg.sender, so the treasury cannot
// join or fund a pool on a user's behalf without making the treasury the
// participant. Instead, when a user draws on their GoHealthMe balance (funded
// via Blink on Base Sepolia), the treasury delivers the same amount of spendable
// USDC to the user's Arc wallet, and the existing join/fund/back flows pull from
// it unchanged. The balance ledger is debited first; this transfer settles it.
//
// Arc testnet: chain id 5042002, USDC ERC-20 at 0x3600..., 6 decimals. The
// GoHealthMe balance unit (uUSDC) maps 1:1 to this token's base units.
//
// Chain access goes through the shared fallback client in
// lib/server/arc-client.ts. This is a money path: a transfer that cannot reach
// the one hard-coded endpoint is a user whose balance was already debited.

import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_ADDRESS } from "@/lib/contract";
import { arcPublicClient, arcWalletClient } from "@/lib/server/arc-client";
import { requireEnv } from "@/lib/server/env";

const USDC_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function treasuryAccount() {
  const pk = requireEnv("TREASURY_PRIVATE_KEY");
  const normalized = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  return privateKeyToAccount(normalized);
}

/**
 * Transfer amountUusdc (6-decimal micro-USDC) of the Arc USDC ERC-20 from the
 * treasury to the recipient and wait for inclusion. Returns the tx hash. A
 * debit of N uUSDC on the ledger delivers N uUSDC of spendable Arc USDC.
 */
export async function sponsorUsdc(
  to: Address,
  amountUusdc: bigint,
): Promise<Hex> {
  if (amountUusdc <= 0n) {
    throw new Error("Sponsor amount must be greater than zero.");
  }

  const account = treasuryAccount();
  const wallet = arcWalletClient(account);
  const publicClient = arcPublicClient();

  // simulate first so revert reasons surface as readable errors
  const { request } = await publicClient.simulateContract({
    account,
    address: USDC_ADDRESS,
    abi: USDC_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, amountUusdc],
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Treasury USDC transfer tx ${hash} reverted on Arc testnet`);
  }
  return hash;
}
