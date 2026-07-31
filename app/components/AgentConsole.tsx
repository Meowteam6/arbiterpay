"use client";

// The /agent page: Circle's mandatory proof 3 as a product page. Identity
// card first - the wallet address in mono at display size, the live balance,
// and the block-explorer link - then the feed of claims SPOTTER has touched.
// The feed is public and deliberately redacted server-side: money facts,
// statuses, and tx hashes only, never the model's prose about anyone's
// medical documents.

import { useQuery } from "@tanstack/react-query";
import { arcTxUrl } from "@/lib/chains";
import { toUsd2 } from "@/lib/agent-receipt";
import type { PublicFeedClaim } from "@/lib/server/agent/feed-view";
import { settleMomentLine } from "@/components/AgentReceipt";
import { EmptyState, Money, Skeleton } from "@/components/ui";

interface WalletResponse {
  address?: string;
  blockchain?: string;
  balanceUsd?: string;
  explorerUrl?: string;
  error?: string;
}

function shortGoal(goalId: string): string {
  return `${goalId.slice(0, 10)}…${goalId.slice(-6)}`;
}

function ClaimCard({ claim }: { claim: PublicFeedClaim }) {
  const settle = claim.settle;
  const deferredLine =
    settle !== null &&
    settle.status === "deferred" &&
    settle.periodEndIso !== null
      ? settleMomentLine(new Date(settle.periodEndIso))
      : null;

  return (
    <li className="rounded-xl border border-edge bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-xs text-muted">
          {shortGoal(claim.goalId)}
        </span>
        <span className="text-xs text-muted">
          {new Date(claim.at).toLocaleString()}
        </span>
      </div>
      <div className="mt-2 space-y-1 text-sm">
        {claim.spends.map((spend, index) => (
          <p key={index} className="flex items-baseline justify-between gap-3">
            <span>
              {spend.label}
              <span className="ml-2 text-xs text-muted">
                {spend.settlement === "x402" ? "paid via x402" : "metered"}
              </span>
            </span>
            <Money usd={toUsd2(spend.amountUsd)} size="sm" />
          </p>
        ))}
        {claim.decision !== null ? (
          <p>
            <span className="text-xs uppercase tracking-wide text-muted">
              decision
            </span>{" "}
            <span
              className={
                claim.decision === "pay" ? "text-accent" : "text-warning"
              }
            >
              {claim.decision}
            </span>
          </p>
        ) : null}
        {settle !== null &&
        settle.status === "settled" &&
        settle.paidUsd !== null ? (
          <p className="flex items-baseline justify-between gap-3">
            <span className="text-accent">
              paid <Money usd={toUsd2(settle.paidUsd)} sign="+" size="sm" />
            </span>
            {settle.txHash !== null ? (
              <a
                href={arcTxUrl(settle.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent underline"
              >
                settle tx
              </a>
            ) : null}
          </p>
        ) : deferredLine !== null ? (
          <p className="text-xs text-muted">{deferredLine}</p>
        ) : null}
      </div>
    </li>
  );
}

export default function AgentConsole() {
  const wallet = useQuery({
    queryKey: ["agent-wallet"],
    queryFn: async (): Promise<WalletResponse | null> => {
      const res = await fetch("/api/agent/wallet");
      if (!res.ok) return null;
      return (await res.json()) as WalletResponse;
    },
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  const feed = useQuery({
    queryKey: ["agent-feed"],
    queryFn: async (): Promise<PublicFeedClaim[]> => {
      const res = await fetch("/api/agent/feed");
      if (!res.ok) return [];
      const body = (await res.json()) as { claims?: PublicFeedClaim[] };
      return body.claims ?? [];
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-edge bg-surface p-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted">
          SPOTTER — settlement agent
        </p>
        {wallet.isPending ? (
          <Skeleton className="mt-4 h-10 w-3/4" />
        ) : wallet.data?.address !== undefined ? (
          <>
            <p className="mt-4 break-all font-mono text-2xl font-semibold leading-tight sm:text-3xl">
              {wallet.data.address}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              {wallet.data.balanceUsd !== undefined ? (
                <Money usd={toUsd2(wallet.data.balanceUsd)} size="lg" />
              ) : null}
              <span className="text-xs uppercase tracking-wide text-muted">
                {wallet.data.blockchain ?? "ARC-TESTNET"} · chain id 5042002
              </span>
              {wallet.data.explorerUrl !== undefined ? (
                <a
                  href={wallet.data.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-accent underline"
                >
                  View on Arcscan
                </a>
              ) : null}
            </div>
            <p className="mt-4 text-sm text-muted">
              This wallet buys the verification each claim needs and pays
              achievers from its own balance. Nobody signs for it.
            </p>
          </>
        ) : (
          <p className="mt-4 text-sm text-muted">
            The agent wallet is not configured. Set the CIRCLE_* variables and
            run the provisioning script.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent claims</h2>
        {feed.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : feed.data !== undefined && feed.data.length > 0 ? (
          <ol className="space-y-3">
            {feed.data.map((claim) => (
              <ClaimCard key={claim.goalId} claim={claim} />
            ))}
          </ol>
        ) : (
          <EmptyState
            title="SPOTTER has done nothing yet."
            detail="Give it something to verify."
          />
        )}
      </section>
    </div>
  );
}
