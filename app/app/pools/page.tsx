"use client";

// The pool list, ordered by what a visitor can act on: live pools lead
// (soonest-ending first, urgency sells), pools past their period but not yet
// settled sit behind them, settled history last. The phase split lives in
// lib/pool-lifecycle so this page, the pool detail, and goal matching can
// never disagree about which pools are joinable.

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import PoolCard from "@/components/PoolCard";
import { Badge, EmptyState, ErrorNote, PoolCardSkeleton } from "@/components/ui";
import { fetchPools, type PoolInfo } from "@/lib/contract";
import { groupPoolsByPhase, type PoolPhase } from "@/lib/pool-lifecycle";

function PoolGrid({ pools, phase }: { pools: PoolInfo[]; phase: PoolPhase }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {pools.map((pool) => (
        <PoolCard key={pool.id.toString()} pool={pool} phase={phase} />
      ))}
    </div>
  );
}

export default function PoolsPage() {
  // The clock is read alongside the fetch, not during render, so grouping
  // stays pure and every card is classified against one snapshot. The query
  // client disables focus refetches, so a polling interval keeps the phase
  // split honest while the tab sits open across a pool's period end.
  const poolsQuery = useQuery({
    queryKey: ["pools"],
    queryFn: async () => ({
      pools: await fetchPools(),
      asOfSeconds: BigInt(Math.floor(Date.now() / 1000)),
    }),
    refetchInterval: 45_000,
  });

  const grouped = useMemo(() => {
    if (poolsQuery.data === undefined) return null;
    return groupPoolsByPhase(poolsQuery.data.pools, poolsQuery.data.asOfSeconds);
  }, [poolsQuery.data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Bounty pools
            </h1>
            <Badge tone="warning">Arc Testnet</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            Live sponsor-funded pools on Arc testnet. Join with your wallet,
            hit the goal, get paid in USDC. USDC here is testnet only and has
            no real value.
          </p>
        </div>
        <Link
          href="/pools/create"
          className="rounded-xl bg-accent-strong px-4 py-2.5 text-sm font-semibold text-background hover:bg-accent"
        >
          Create pool
        </Link>
      </div>

      {poolsQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <PoolCardSkeleton />
          <PoolCardSkeleton />
          <PoolCardSkeleton />
        </div>
      ) : poolsQuery.isError ? (
        <ErrorNote
          title="Could not load pools"
          detail={
            poolsQuery.error instanceof Error
              ? poolsQuery.error.message
              : "Unknown error reading from Arc testnet."
          }
          onRetry={() => {
            void poolsQuery.refetch();
          }}
        />
      ) : grouped === null ||
        grouped.live.length + grouped.expired.length + grouped.settled.length ===
          0 ? (
        <EmptyState
          title="No pools yet"
          detail="Pools appear here the moment a sponsor creates one on Arc. Be the first to fund a bounty."
          action={
            <Link
              href="/pools/create"
              className="inline-block rounded-xl bg-accent-strong px-5 py-3 text-sm font-semibold text-background hover:bg-accent"
            >
              Create the first pool
            </Link>
          }
        />
      ) : (
        <div className="space-y-8">
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Live, open to join
            </p>
            {grouped.live.length === 0 ? (
              <p className="rounded-xl border border-dashed border-accent/30 bg-accent-deep/20 p-3 text-sm text-accent">
                No live pools right now. Create one and put a goal on the
                board.
              </p>
            ) : (
              <PoolGrid pools={grouped.live} phase="live" />
            )}
          </section>

          {grouped.expired.length > 0 ? (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                Ended, awaiting settlement
              </p>
              <PoolGrid pools={grouped.expired} phase="expired" />
            </section>
          ) : null}

          {grouped.settled.length > 0 ? (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                Settled
              </p>
              <PoolGrid pools={grouped.settled} phase="settled" />
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
