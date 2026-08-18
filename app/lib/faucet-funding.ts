"use client";

// One-tap test-USDC funding for a cold wallet.
//
// WHY A CHAIN, NOT A SINGLE CALL
// GoHealthMe holds TWO different balances and they are not the same pot:
//
//   1. The in-app GoHealthMe ledger (a Redis counter per address). The faucet
//      at /api/blink/topup credits THIS. /api/balance reads it.
//   2. The on-chain Arc USDC in the wallet. Joining, funding and backing a pool
//      all sign a client-side writeContract, and Arc pays gas in USDC, so those
//      actions spend THIS. A wallet with zero on-chain USDC cannot send any
//      transaction, not even to join a free pool.
//
// The faucet only ever moves pot 1. It does not fund the wallet the join flow
// actually spends from, so claiming it and re-reading the on-chain balance
// would loop forever on an empty wallet. /api/balance/withdraw is the bridge:
// it debits pot 1 and the treasury sponsors the same amount of real Arc USDC
// into pot 2, waiting for the receipt before it answers. So the honest
// zero-detour path is: grant in-app -> move it onto Arc -> the wallet can now
// pay gas.
//
// GUARDRAILS ARE UNCHANGED. Both endpoints keep their own server-side caps:
// the faucet's per-address cooldown and global daily budget, and the
// withdrawal's per-address daily cap and treasury floor. This module only
// orchestrates the two existing calls; it never bypasses or raises a cap and
// adds no new money path. It is the exact pair of calls the dashboard balance
// card already exposes as two separate buttons, run back to back.

import { useCallback, useRef, useState } from "react";
import type { Address } from "viem";
import {
  erc20Abi,
  getArcPublicClient,
  USDC_ADDRESS,
} from "@/lib/contract";
import { WITHDRAW_DAILY_CAP_UUSDC } from "@/lib/money-guards";

/** Which leg of the chain is in flight, for an honest button label. */
export type FundingPhase = "idle" | "claiming" | "moving";

/**
 * Outcome of a funding attempt. `funded` is the ONLY success, and it is
 * reported only after the treasury transfer landed on Arc (the withdraw route
 * waits for a successful receipt before returning a tx hash), so a caller may
 * treat it as "the wallet now holds spendable USDC" and continue.
 */
export type FundingResult =
  | { kind: "funded"; movedUusdc: bigint }
  // Nothing was available to move onto Arc: the faucet was a same-window no-op
  // and the address held no prior in-app balance. Not an error, just nothing
  // happened.
  | { kind: "empty" }
  // A server cap said no (faucet budget/cooldown, or the withdraw daily cap).
  // Expected, not a fault; carry the server's own honest message.
  | { kind: "budget-exhausted"; message: string }
  | { kind: "error"; message: string };

interface TopupResponse {
  applied?: boolean;
  error?: string;
}
interface BalanceResponse {
  balanceUusdc?: string;
}
interface WithdrawResponse {
  txHash?: string;
  error?: string;
}

/**
 * Read the wallet's spendable on-chain Arc USDC balance, in 6-decimal base
 * units. This is the balance that pays gas and entry fees, distinct from the
 * in-app ledger balance /api/balance returns.
 */
export async function fetchWalletUsdc(address: Address): Promise<bigint> {
  const client = getArcPublicClient();
  return (await client.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

/** Options for a funding attempt. */
export interface FundingOptions {
  /**
   * True when the app fired this attempt automatically (the first-block
   * auto-fund) rather than a user tapping for it. Automatic grants are charged
   * against the server's lower faucet reserve, so incidental page loads cannot
   * drain the budget a deliberate tap needs. Defaults to false (deliberate).
   */
  auto?: boolean;
}

/**
 * Grant test USDC and deliver it onto Arc so the wallet can transact.
 *
 * Steps, each against an existing guarded endpoint:
 *   1. POST /api/blink/topup   - grant into the in-app ledger (idempotent per
 *      address/day; a same-window repeat is a harmless no-op).
 *   2. GET  /api/balance       - how much in-app balance is now available.
 *   3. POST /api/balance/withdraw - move it onto Arc as real USDC.
 *
 * A faucet refusal is not fatal on its own: the address may still hold in-app
 * balance from an earlier grant that step 3 can deliver. Only when there is
 * nothing to move does a faucet refusal become the reported outcome.
 */
export async function runTestUsdcFunding(
  address: string,
  onPhase?: (phase: FundingPhase) => void,
  options: FundingOptions = {},
): Promise<FundingResult> {
  const auto = options.auto === true;
  // 1. Grant into the in-app ledger. Best-effort.
  onPhase?.("claiming");
  let faucetRefusal: string | null = null;
  try {
    const res = await fetch("/api/blink/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, auto }),
    });
    const body = (await res.json().catch(() => ({}))) as TopupResponse;
    if (res.status === 429) {
      // Cooldown or global budget. Hold it: if the address already has in-app
      // balance we can still move it onto Arc below.
      faucetRefusal = body.error ?? "The in-app faucet is not available right now.";
    } else if (!res.ok) {
      return {
        kind: "error",
        message: body.error ?? `The faucet responded with status ${res.status}.`,
      };
    }
  } catch {
    return { kind: "error", message: "Could not reach the in-app faucet." };
  }

  // 2. How much in-app balance is there to deliver onto Arc?
  let inApp: bigint;
  try {
    const res = await fetch(`/api/balance?address=${address}`);
    if (!res.ok) {
      return {
        kind: "error",
        message: `The balance feed responded with status ${res.status}.`,
      };
    }
    const body = (await res.json()) as BalanceResponse;
    inApp = BigInt(body.balanceUusdc ?? "0");
  } catch {
    return { kind: "error", message: "Could not read your in-app balance." };
  }

  if (inApp <= 0n) {
    // Nothing to move. If the faucet refused, that refusal is the reason.
    return faucetRefusal !== null
      ? { kind: "budget-exhausted", message: faucetRefusal }
      : { kind: "empty" };
  }

  // 3. Deliver it onto Arc. The server caps a single address per day, so move
  //    at most that cap; the rest waits for the next window.
  onPhase?.("moving");
  const amount =
    inApp > WITHDRAW_DAILY_CAP_UUSDC ? WITHDRAW_DAILY_CAP_UUSDC : inApp;
  try {
    const res = await fetch("/api/balance/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address,
        amountUusdc: amount.toString(),
        ref: crypto.randomUUID(),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as WithdrawResponse;
    if (res.status === 429) {
      return {
        kind: "budget-exhausted",
        message:
          body.error ?? "The daily transfer limit was reached. Nothing moved.",
      };
    }
    if (!res.ok || typeof body.txHash !== "string") {
      return {
        kind: "error",
        message: body.error ?? `The move to Arc failed with status ${res.status}.`,
      };
    }
    // The withdraw route only returns a tx hash after the transfer landed, so
    // the wallet genuinely holds this much more spendable USDC now.
    return { kind: "funded", movedUusdc: amount };
  } catch {
    return { kind: "error", message: "Could not move your balance onto Arc." };
  }
}

export interface UseTestUsdcFunding {
  phase: FundingPhase;
  funding: boolean;
  /** Run the grant-and-deliver chain once. Serialised: a second call while one
   *  is in flight is refused rather than double-spending a grant. Pass
   *  { auto: true } for an app-fired attempt so it draws the lower reserve. */
  fund: (address: string, options?: FundingOptions) => Promise<FundingResult>;
}

/**
 * React wrapper over runTestUsdcFunding that exposes the in-flight phase for a
 * button label and guards against overlapping attempts. `fund` is stable, so it
 * is safe as a hook-effect dependency.
 */
export function useTestUsdcFunding(): UseTestUsdcFunding {
  const [phase, setPhase] = useState<FundingPhase>("idle");
  const inFlight = useRef(false);

  const fund = useCallback(
    async (
      address: string,
      options?: FundingOptions,
    ): Promise<FundingResult> => {
      if (inFlight.current) {
        return {
          kind: "error",
          message: "A funding attempt is already in progress.",
        };
      }
      inFlight.current = true;
      setPhase("claiming");
      try {
        return await runTestUsdcFunding(address, setPhase, options);
      } finally {
        setPhase("idle");
        inFlight.current = false;
      }
    },
    [],
  );

  return { phase, funding: phase !== "idle", fund };
}
