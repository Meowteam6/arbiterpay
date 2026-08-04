"use client";

// SPOTTER's balance in the header: the agent's falling balance sits beside
// the human's rising one. Reads the wallet route only; renders nothing when
// the agent is not configured rather than faking a number.
//
// The out-of-budget state reaches phones now. It used to be hidden below sm
// with its explanation hidden below lg, so the one state a user genuinely
// needs explained - their claim failing because the agent ran dry - was
// invisible on the device most of them hold. The agent runs a few USDC against
// a 1.00 per-claim cap, so running dry is a matter of when, not if.
//
// Below sm the chip appears ONLY when the agent is broke, and compactly.
// Measured at 375px: the header is wordmark + a scrollable nav strip + auth
// controls with nothing to spare, and carrying the healthy balance there
// squeezes the nav to ~51px, which trades working navigation for a number
// nobody needs. The stoppage is worth that space; the balance is not. Wider
// screens get the balance, and then the full sentence, as the room appears.
// The accessible name always carries the whole thing, and PoolDetail repeats
// it in full beside the claim, which is where it actually bites.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AGENT_WALLET_QUERY_KEY,
  agentIsBroke,
  fetchAgentWallet,
} from "@/lib/agent-budget";
import { toUsd2 } from "@/lib/agent-receipt";

export const OUT_OF_BUDGET_LINE =
  "out of budget. not verifying anything until topped up.";

export default function AgentStrip() {
  const { data } = useQuery({
    queryKey: AGENT_WALLET_QUERY_KEY,
    queryFn: fetchAgentWallet,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  if (data === null || data === undefined || data.balanceUsd === null) {
    return null;
  }

  const balance = toUsd2(data.balanceUsd);
  const broke = agentIsBroke(data.balanceUsd);

  return (
    <Link
      href="/agent"
      title={
        broke
          ? `SPOTTER holds ${balance} USDC - ${OUT_OF_BUDGET_LINE}`
          : "SPOTTER's wallet"
      }
      aria-label={
        broke
          ? `SPOTTER holds ${balance} USDC and is ${OUT_OF_BUDGET_LINE}`
          : `SPOTTER holds ${balance} USDC`
      }
      className={`min-h-11 items-center gap-1 rounded-lg border px-2 font-mono text-[11px] sm:px-3 sm:text-xs ${
        broke
          ? "inline-flex border-warning/40 text-warning"
          : "hidden border-edge text-muted hover:text-foreground sm:inline-flex"
      }`}
    >
      <span className="font-semibold">SPOTTER</span>
      {broke ? (
        <>
          {/* Phone: the balance is not the news, the stoppage is. */}
          <span className="sm:hidden">dry</span>
          <span aria-hidden className="hidden sm:inline">
            ·
          </span>
          <span className="hidden tabular-nums sm:inline">{balance} USDC</span>
          <span aria-hidden className="hidden sm:inline">
            ·
          </span>
          <span className="hidden sm:inline lg:hidden">out of budget</span>
          <span className="hidden lg:inline">{OUT_OF_BUDGET_LINE}</span>
        </>
      ) : (
        <>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{balance} USDC</span>
        </>
      )}
    </Link>
  );
}
