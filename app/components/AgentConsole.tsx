"use client";

// The /agent page: Circle's mandatory proof 3 as a product page. Identity
// card first - the wallet address in mono at display size, the live balance,
// and the block-explorer link - then the feed of claims SPOTTER has touched.
// The feed is public and deliberately redacted server-side: money facts,
// statuses, and tx hashes only, never the model's prose about anyone's
// medical documents.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { arcTxUrl } from "@/lib/chains";
import { toUsd2 } from "@/lib/agent-receipt";
import type { PublicFeedClaim } from "@/lib/server/agent/feed-view";
import { settleMomentLine } from "@/components/AgentReceipt";
import { EmptyState, Money, Skeleton } from "@/components/ui";

// Where the empty state sends a first-time visitor. Pool 13 is picked
// deliberately: it is a [doc] pool with bountyModel = 1 (pro-rata split) and a
// funded balance, so a verified claim actually pays. The live bountyModel = 0
// pools were created with entryFee = 0, which makes totalOwed zero and settles
// to nobody - never point this at one of those. Verify the pool is still
// unsettled with periodEnd in the future before a demo.
const CLAIMABLE_POOL_ID = 13;

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
        <span className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted">
          {shortGoal(claim.goalId)}
          {claim.selfReported ? (
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-warning">
              self-reported
            </span>
          ) : null}
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
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
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
            {/* Precise about whose money moves, on both sides. Pay side:
             *  settle() pays achievers out of the pool balance held by
             *  HealthPools (_payAchievers decrements p.balance and _push
             *  transfers from the contract), so the bounty never comes out of
             *  this wallet - it covers gas only. Buy side: verification is NOT
             *  bought with this wallet either. x402.ts uses a separate spend
             *  key (X402_PRIVATE_KEY) because GatewayClient needs a raw private
             *  key, and with that key unset the purchase is metered/prepaid
             *  under an API key instead. Naming this wallet as the buyer would
             *  repeat the same "whose money" error this copy exists to fix. */}
            <p className="mt-4 text-sm text-muted">
              This wallet pays the gas and calls settle(). The bounty is the
              sponsor's USDC, released from the pool — not from here.
              Verification is bought separately, under a hard per-claim cap.
              Nobody signs for any of it.
            </p>
          </>
        ) : (
          <p className="mt-4 text-sm text-muted">
            The agent wallet is not configured. Set the CIRCLE_* variables and
            run the provisioning script.
          </p>
        )}
          </div>
          <div className="shrink-0 self-center sm:self-start">
            <div className="otter-float w-36 overflow-hidden rounded-2xl border border-edge bg-surface-raised sm:w-44">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/spotter/spotter-watching.png"
                alt="SPOTTER, the otter, watching the ledger"
                className="aspect-square w-full object-cover"
              />
            </div>
            <p className="mt-2 text-center text-xs uppercase tracking-wide text-muted">
              on the clock
            </p>
          </div>
        </div>
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
            detail="Join a pool, upload a record, and SPOTTER buys the verification and pays out here."
            action={
              <Link
                href={`/pools/${CLAIMABLE_POOL_ID}`}
                className="inline-flex min-h-11 items-center rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-background hover:bg-accent"
              >
                Give it something to verify
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}
