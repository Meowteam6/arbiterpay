"use client";

// SPOTTER's balance in the header: the agent's falling balance sits beside
// the human's rising one. Reads the wallet route only; renders nothing when
// the agent is not configured rather than faking a number.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toUsd2 } from "@/lib/agent-receipt";

interface WalletResponse {
  address?: string;
  balanceUsd?: string;
  error?: string;
}

export default function AgentStrip() {
  const { data } = useQuery({
    queryKey: ["agent-wallet"],
    queryFn: async (): Promise<WalletResponse | null> => {
      const res = await fetch("/api/agent/wallet");
      if (!res.ok) return null;
      return (await res.json()) as WalletResponse;
    },
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  if (data === null || data === undefined || data.balanceUsd === undefined) {
    return null;
  }

  const balance = toUsd2(data.balanceUsd);
  const broke = balance === "0.00";

  return (
    <Link
      href="/agent"
      title="SPOTTER's wallet"
      className={`hidden items-center gap-1 rounded-lg border px-3 py-2 font-mono text-xs sm:inline-flex ${
        broke
          ? "border-warning/40 text-warning"
          : "border-edge text-muted hover:text-foreground"
      }`}
    >
      <span className="font-semibold">SPOTTER</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{balance} USDC</span>
      {broke ? (
        <span className="hidden lg:inline">
          · out of budget. not verifying anything until topped up.
        </span>
      ) : null}
    </Link>
  );
}
