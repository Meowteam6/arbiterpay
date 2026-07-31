"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import PoolCard from "@/components/PoolCard";
import { Badge, EmptyState, ErrorNote, PoolCardSkeleton } from "@/components/ui";
import { fetchPools } from "@/lib/contract";

export default function PoolsPage() {
  const poolsQuery = useQuery({
    queryKey: ["pools"],
    queryFn: fetchPools,
  });

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
      ) : (poolsQuery.data ?? []).length === 0 ? (
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
        <div className="grid gap-4 sm:grid-cols-2">
          {(poolsQuery.data ?? []).map((pool) => (
            <PoolCard key={pool.id.toString()} pool={pool} />
          ))}
        </div>
      )}
    </div>
  );
}
