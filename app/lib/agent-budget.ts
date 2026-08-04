// SPOTTER's balance, read once and shared.
//
// The agent buys every verification out of this wallet under a per-claim cap,
// so an empty balance is not a cosmetic detail: claims stop dead at the buy
// step. The header strip and the claim surfaces both read it through here so
// there is one request per page and one definition of "out of budget" - a user
// whose claim fails because the agent is broke has to be able to see why, and
// two components disagreeing about the threshold would be worse than silence.

import { toUsd2 } from "@/lib/agent-receipt";

export interface AgentWallet {
  address: string | null;
  /** Whole-USD string exactly as the wallet route reported it; null when the
   *  route answered without one (agent not configured). */
  balanceUsd: string | null;
  explorerUrl: string | null;
}

export const AGENT_WALLET_QUERY_KEY = ["agent-wallet"] as const;

export function parseAgentWallet(payload: unknown): AgentWallet {
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  return {
    address: typeof record.address === "string" ? record.address : null,
    balanceUsd:
      typeof record.balanceUsd === "string" ? record.balanceUsd : null,
    explorerUrl:
      typeof record.explorerUrl === "string" ? record.explorerUrl : null,
  };
}

/**
 * Out of budget: the wallet answered and holds less than a cent. A balance
 * that rounds to 0.00 cannot cover any priced step, so the honest reading is
 * that nothing will be verified until it is topped up. An unknown balance
 * (null) is never called broke.
 */
export function agentIsBroke(balanceUsd: string | null): boolean {
  return balanceUsd !== null && toUsd2(balanceUsd) === "0.00";
}

/**
 * Read the agent's wallet. Resolves to null rather than throwing when the
 * route is unavailable: an unconfigured agent must render as nothing, never as
 * a fabricated balance.
 */
export async function fetchAgentWallet(): Promise<AgentWallet | null> {
  try {
    const res = await fetch("/api/agent/wallet");
    if (!res.ok) return null;
    return parseAgentWallet(await res.json());
  } catch {
    return null;
  }
}
