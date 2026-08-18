"use client";

// Persistent "where's my test money" affordance for signed-in users. It sits in
// the header note row and answers two things at a glance: how much spendable
// USDC the wallet holds, and how to get more in one tap. The balance shown is
// the ON-CHAIN Arc USDC (what actually pays gas and entry fees), not the in-app
// ledger, because that is the number that decides whether an action can run.
//
// Tapping "Get test USDC" runs the same grant-and-deliver chain the funding
// screen uses: it reuses the guarded /api/blink/topup and /api/balance/withdraw
// endpoints, adds no new money path, and honours their caps. On success the
// on-chain balance query is invalidated so the number visibly climbs.
//
// Honesty: the copy and the tooltip both state this is test USDC with no real
// value. Renders nothing for signed-out users rather than showing a zero.

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsdc } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { fetchWalletUsdc, useTestUsdcFunding } from "@/lib/faucet-funding";

type ChipState = "idle" | "done" | "fallback";

export default function TestUsdcChip() {
  const { authenticated, address } = useEmbeddedWallet();
  const queryClient = useQueryClient();
  const { phase, funding, fund } = useTestUsdcFunding();
  const [state, setState] = useState<ChipState>("idle");

  const balanceQuery = useQuery({
    queryKey: ["wallet-usdc", address],
    queryFn: () => fetchWalletUsdc(address as `0x${string}`),
    enabled: authenticated && address !== null,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });

  // Only for signed-in wallets. A signed-out visitor gets the sign-in note next
  // to this, not a misleading zero balance.
  if (!authenticated || address === null) return null;

  const run = async () => {
    setState("idle");
    const result = await fund(address);
    if (result.kind === "funded") {
      setState("done");
      await queryClient.invalidateQueries({
        queryKey: ["wallet-usdc", address],
      });
    } else {
      setState("fallback");
    }
  };

  const balance = balanceQuery.data;
  const label = funding
    ? phase === "moving"
      ? "Delivering..."
      : "Getting..."
    : "Get test USDC";

  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <span
        title="Spendable test USDC in your Arc wallet. Testnet only, no real value."
        className="inline-flex min-h-11 items-center rounded-lg border border-edge bg-surface-raised px-2 font-mono text-[11px] text-muted sm:px-3 sm:text-xs"
      >
        <span className="font-sans font-semibold uppercase tracking-wide">
          Balance
        </span>
        <span aria-hidden className="mx-1">
          ·
        </span>
        <span className="tabular-nums">
          {balance !== undefined ? formatUsdc(balance) : "--"} USDC
        </span>
      </span>
      <button
        type="button"
        disabled={funding}
        onClick={() => {
          void run();
        }}
        title="Grant yourself test USDC and deliver it to your wallet. Testnet only, no real value."
        className="inline-flex min-h-11 items-center rounded-lg border border-accent/50 px-2 text-[11px] font-semibold text-accent hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-60 sm:px-3 sm:text-xs"
      >
        {label}
      </button>
      {state === "done" ? (
        <span className="text-[11px] text-accent sm:text-xs" aria-live="polite">
          Added
        </span>
      ) : null}
      {state === "fallback" ? (
        <Link
          href="/dashboard"
          className="text-[11px] text-warning underline sm:text-xs"
        >
          faucet dry - fund on dashboard
        </Link>
      ) : null}
    </div>
  );
}
