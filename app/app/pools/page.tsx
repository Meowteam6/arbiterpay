"use client";

// The pool list, ordered by what a visitor can act on: live pools lead
// (soonest-ending first, urgency sells), pools past their period but not yet
// settled sit behind them, settled history last. The phase split lives in
// lib/pool-lifecycle so this page, the pool detail, and goal matching can
// never disagree about which pools are joinable.
//
// Two things the phase split alone cannot say, both of which were lying to
// visitors, live in lib/pool-availability:
//   - An expired pool nobody joined is not "awaiting settlement". settle() has
//     nobody to pay, so it would sit under that heading forever promising a
//     payout that will never come. Participant counts come off the chain.
//   - A wearable goal cannot be verified while the wearable provider refuses
//     us, and its entry fee is real money paid up front. Those pools come out
//     of the joinable group for as long as the provider stays down; the state
//     is read from the junction route, never hard-coded to a pool id.

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import PoolCard from "@/components/PoolCard";
import {
  Badge,
  EmptyState,
  ErrorNote,
  PoolCardSkeleton,
  TAP_TARGET,
} from "@/components/ui";
import { fetchParticipants, fetchPools, type PoolInfo } from "@/lib/contract";
import { fetchPoolVisibilities } from "@/lib/pool-visibility-client";
import {
  groupPoolsByPhase,
  poolCanPay,
  type PoolPhase,
} from "@/lib/pool-lifecycle";
import {
  splitByVerifiability,
  splitExpiredPools,
} from "@/lib/pool-availability";
import {
  fetchProviderState,
  providerDownReason,
  providerQueryKey,
} from "@/lib/wearable-provider";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useWalletAuth } from "@/lib/useWalletAuth";

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
  const { address } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();

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

  // Drop pools that structurally cannot pay before anything else, so they never
  // reach the joinable list. Two such pools were live and sorted to the top of
  // the page advertising the largest bounties on it, the worst thing to hand a
  // first-time visitor: they would join, upload, verify, and be paid nothing by
  // a transaction that succeeds.
  const payablePools = useMemo(
    () => poolsQuery.data?.pools.filter(poolCanPay) ?? null,
    [poolsQuery.data],
  );
  const payableIds = useMemo(
    () => (payablePools ?? []).map((pool) => pool.id.toString()),
    [payablePools],
  );

  // Private pools - a person-aimed challenge, or a sponsor pool the owner marked
  // private - must never appear on the public board even when live and payable.
  // Visibility is the MUTABLE, owner-owned flag resolved server-side (store
  // first, initiative default), fetched here for exactly the payable ids. It is
  // no longer the immutable on-chain initiative: a challenge the owner opened up
  // now shows, a sponsor pool the owner locked down now hides. An id the route
  // does not answer for is absent from the map, so the "=== public" filter below
  // drops it - a pool of unknown visibility is never listed.
  const visibilityQuery = useQuery({
    queryKey: ["pool-visibility", payableIds.join(",")],
    queryFn: () => fetchPoolVisibilities(payableIds),
    enabled: payablePools !== null,
    staleTime: 30_000,
  });

  const grouped = useMemo(() => {
    if (
      payablePools === null ||
      poolsQuery.data === undefined ||
      visibilityQuery.data === undefined
    ) {
      return null;
    }
    const visibility = visibilityQuery.data;
    const publicPools = payablePools.filter(
      (pool) => visibility[pool.id.toString()] === "public",
    );
    return groupPoolsByPhase(publicPools, poolsQuery.data.asOfSeconds);
  }, [payablePools, poolsQuery.data, visibilityQuery.data]);

  // Only expired pools need a head count: it is what separates "settlement
  // still has work to do here" from "this can never pay anyone". Live and
  // settled pools are unaffected, so the read stays small.
  const expiredIds = useMemo(
    () => (grouped?.expired ?? []).map((pool) => pool.id.toString()),
    [grouped],
  );

  const countsQuery = useQuery({
    queryKey: ["expired-participant-counts", expiredIds.join(",")],
    queryFn: async (): Promise<Record<string, number>> => {
      const counted = await Promise.all(
        expiredIds.map(async (poolId) => {
          const participants = await fetchParticipants(BigInt(poolId));
          return [poolId, participants.length] as const;
        }),
      );
      return Object.fromEntries(counted);
    },
    enabled: expiredIds.length > 0,
    staleTime: 5 * 60_000,
  });

  // Shares one query key with the dashboard and the pool page: same endpoint,
  // one request per address. Without a wallet there is nobody to ask about, so
  // the check stays disabled and nothing is held back on a guess.
  //
  // cachedOnly: browsing a list of pools is not a request to unlock private
  // data, so this never opens a wallet prompt. Unsigned reads report as "not
  // known", which leaves every goal on the board.
  const providerQuery = useQuery({
    queryKey: providerQueryKey(address),
    queryFn: () => {
      if (address === null) throw new Error("No wallet connected.");
      return fetchProviderState(address, (options) =>
        requestAuth({ ...options, cachedOnly: true }),
      );
    },
    enabled: address !== null,
    retry: false,
  });
  const providerDown = providerDownReason(providerQuery.data);

  const liveSplit = splitByVerifiability(
    grouped?.live ?? [],
    providerDown !== null,
  );
  const expiredSplit = splitExpiredPools(
    grouped?.expired ?? [],
    (pool) => countsQuery.data?.[pool.id.toString()] ?? null,
  );

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
        <div className="flex flex-wrap gap-2">
          <Link
            href="/challenge/new"
            className={`rounded-xl border border-accent/50 bg-accent-deep/30 font-semibold text-accent hover:bg-accent-deep/50 ${TAP_TARGET}`}
          >
            Challenge a friend
          </Link>
          <Link
            href="/pools/create"
            className={`rounded-xl bg-accent-strong font-semibold text-background hover:bg-accent ${TAP_TARGET}`}
          >
            Create pool
          </Link>
        </div>
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
      ) : visibilityQuery.isError ? (
        // Without the visibility flags the board cannot tell public from private
        // pools, and showing everything would leak a private dare. Surface the
        // error and offer a retry rather than render a fake-empty or fake-full
        // board.
        <ErrorNote
          title="Could not load pools"
          detail={
            visibilityQuery.error instanceof Error
              ? visibilityQuery.error.message
              : "Could not check which pools are public."
          }
          onRetry={() => {
            void visibilityQuery.refetch();
          }}
        />
      ) : grouped === null ? (
        // Pools are in; the visibility flags are still resolving. Hold on
        // skeletons rather than flashing an empty board.
        <div className="grid gap-4 sm:grid-cols-2">
          <PoolCardSkeleton />
          <PoolCardSkeleton />
          <PoolCardSkeleton />
        </div>
      ) : grouped.live.length +
          grouped.expired.length +
          grouped.settled.length ===
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
            {liveSplit.verifiable.length === 0 ? (
              <p className="rounded-xl border border-dashed border-accent/30 bg-accent-deep/20 p-3 text-sm text-accent">
                {grouped.live.length === 0
                  ? "No live pools right now. Create one and put a goal on the board."
                  : "Every live pool right now is a wearable goal, and none of them can be verified until the provider is back. Create a document-verified pool and put a goal on the board."}
              </p>
            ) : (
              <PoolGrid pools={liveSplit.verifiable} phase="live" />
            )}
          </section>

          {providerDown !== null && liveSplit.unverifiable.length > 0 ? (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-warning">
                Wearable goals - not joinable right now
              </p>
              <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground/80">
                {providerDown} The entry fee is real money, so these are held
                back until SPOTTER can check them again. Document-verified pools
                run through the confidential attester and are unaffected.
              </p>
              {/* Dimmed and moved out of the joinable group, but still
                  readable: the pool page repeats the reason and withholds the
                  join action there too. */}
              <div className="opacity-60">
                <PoolGrid pools={liveSplit.unverifiable} phase="live" />
              </div>
            </section>
          ) : null}

          {expiredSplit.awaitingSettlement.length > 0 ? (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                Ended, awaiting settlement
              </p>
              <PoolGrid
                pools={expiredSplit.awaitingSettlement}
                phase="expired"
              />
            </section>
          ) : null}

          {expiredSplit.closedEmpty.length > 0 ? (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                Closed, nobody joined
              </p>
              <p className="text-sm text-muted">
                Their period ended with no participants on record. settle() has
                nobody to pay in these, so nothing is pending - they stay here
                as history.
              </p>
              <PoolGrid pools={expiredSplit.closedEmpty} phase="expired" />
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
