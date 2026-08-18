"use client";

// The sponsor console. A sponsor signs in, creates and funds health-goal pools,
// and sees what their USDC bought — in aggregate only. Three things govern it:
//
//   1. Reuse, not reinvention: pool creation runs through the existing
//      CreatePool form and top-ups through the existing FundPool component, both
//      unchanged. This file only adds the console shell, the sponsor's own-pool
//      filter, and the privacy-safe outcome view.
//   2. k-anonymity floor (lib/sponsor-metrics): every outcome figure — per pool
//      and across the portfolio — is withheld unless it derives from at least
//      five participants. Sponsor capital (balances, the sponsor's own funding)
//      is always shown; it is not participant data.
//   3. No participant identity leaves the chain read: on-chain events are
//      reduced to counts and USDC sums keyed by pool id (lib/sponsor-data), and
//      no participant wallet or handle is ever rendered next to a health label.
//
// LEGAL-GATED and deliberately kept OUT of the copy here: any insurer /
// UnitedHealth "pays for behavior -> fewer claims" ROI framing, and any HIPAA /
// covered-entity claim. Those change the regulatory posture of the product and
// are held for legal review, not written into console UI.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import CreatePool from "@/components/CreatePool";
import SponsorPoolOutcome from "@/components/SponsorPoolOutcome";
import {
  Badge,
  EmptyState,
  ErrorNote,
  Money,
  PoolCardSkeleton,
  Stat,
  TAP_TARGET,
} from "@/components/ui";
import { fetchPools, formatUsdc, type PoolInfo } from "@/lib/contract";
import {
  fetchPoolEventTotals,
  toPoolAggregate,
  type PoolEventTotals,
} from "@/lib/sponsor-data";
import {
  portfolioAggregate,
  portfolioDisplay,
  type PoolAggregate,
} from "@/lib/sponsor-metrics";
import { useEmbeddedWallet } from "@/lib/wallet";

const PRIVACY_LINE =
  "Outcomes here are aggregate only. SPOTTER verifies each goal in a confidential enclave, and only the verdict ever leaves it — no sponsor sees a participant's health data, and no figure is shown that could point at one person.";

interface ConsoleData {
  pools: PoolInfo[];
  totals: Record<string, PoolEventTotals>;
  asOfSeconds: bigint;
}

/** A withheld count reads as "Fewer than 5", never as a misleading exact zero. */
function CountValue({ value }: { value: number | null }) {
  return <>{value !== null ? value.toLocaleString("en-US") : "Fewer than 5"}</>;
}

/** A withheld money total reads as held, never as a false zero. */
function MoneyValue({ usd }: { usd: string | null }) {
  return usd !== null ? <Money usd={usd} /> : <span className="text-muted">Held</span>;
}

function PortfolioSummary({ aggregates }: { aggregates: PoolAggregate[] }) {
  const totals = useMemo(() => portfolioAggregate(aggregates), [aggregates]);
  const d = useMemo(() => portfolioDisplay(totals), [totals]);

  return (
    <section className="space-y-4 rounded-2xl border border-edge bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Your pools at a glance</h2>
        <Badge tone="muted">
          {d.poolCount} {d.poolCount === 1 ? "pool" : "pools"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="In your pools"
          value={<Money usd={formatUsdc(d.totalBalanceUsdc)} />}
        />
        <Stat
          label="You funded"
          value={<Money usd={formatUsdc(d.totalToppedUpUsdc)} />}
        />
        <Stat
          label="Paid to achievers"
          value={
            <MoneyValue
              usd={d.totalPaidUsdc !== null ? formatUsdc(d.totalPaidUsdc) : null}
            />
          }
        />
        <Stat label="Participants" value={<CountValue value={d.totalJoined} />} />
        <Stat
          label="Verified completions"
          value={<CountValue value={d.totalCompletions} />}
        />
      </div>

      <p className="text-xs leading-relaxed text-muted">{PRIVACY_LINE}</p>
    </section>
  );
}

export default function SponsorConsole() {
  const { ready, authenticated, address, login } = useEmbeddedWallet();
  const [showCreate, setShowCreate] = useState(false);

  // Address-independent: the whole board plus its event totals in one snapshot,
  // then filtered to the signed-in sponsor's own pools below. Keeping the query
  // key stable lets it share cache across sign-ins and matches the pools page's
  // 45s poll so the phase split and balances stay honest while the tab is open.
  const consoleQuery = useQuery<ConsoleData>({
    queryKey: ["sponsor-console"],
    queryFn: async () => {
      const [pools, totals] = await Promise.all([
        fetchPools(),
        fetchPoolEventTotals(),
      ]);
      return {
        pools,
        totals,
        asOfSeconds: BigInt(Math.floor(Date.now() / 1000)),
      };
    },
    refetchInterval: 45_000,
    enabled: authenticated && address !== null,
  });

  const myPools = useMemo(() => {
    if (consoleQuery.data === undefined || address === null) return [];
    const mine = address.toLowerCase();
    return consoleQuery.data.pools.filter(
      (pool) => pool.creator.toLowerCase() === mine,
    );
  }, [consoleQuery.data, address]);

  const aggregates = useMemo(
    () =>
      myPools.map((pool) =>
        toPoolAggregate(pool, consoleQuery.data?.totals[pool.id.toString()]),
      ),
    [myPools, consoleQuery.data],
  );

  const createPanel = (
    <div className="space-y-3">
      {showCreate ? (
        <div className="rounded-2xl border border-edge bg-surface p-5">
          <CreatePool />
          <button
            type="button"
            onClick={() => setShowCreate(false)}
            className="mt-4 text-sm font-medium text-muted hover:text-foreground"
          >
            Hide the form
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className={`rounded-xl bg-accent-strong font-semibold text-background hover:bg-accent ${TAP_TARGET}`}
        >
          Create a pool
        </button>
      )}
    </div>
  );

  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Sponsor console
        </h1>
        <Badge tone="warning">Arc Testnet</Badge>
      </div>
      <p className="text-sm text-muted">
        Put USDC on a health goal, top it up as it fills, and watch what it
        buys. Every outcome below is aggregate only, and nobody ever sees a
        participant&apos;s health data. Testnet USDC has no real value.
      </p>
    </div>
  );

  if (!ready) {
    return (
      <div className="space-y-6">
        {header}
        <div className="grid gap-4 sm:grid-cols-2">
          <PoolCardSkeleton />
          <PoolCardSkeleton />
        </div>
      </div>
    );
  }

  if (!authenticated || address === null) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          title="Sign in to run a pool"
          detail="Creating and funding a bounty pulls USDC from your wallet, so the console opens once you sign in. Your pools and their aggregate outcomes live here."
          action={
            <button
              type="button"
              onClick={login}
              className="rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
            >
              Sign in
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {header}
        <Link
          href="/pools"
          className="text-sm font-medium text-muted underline hover:text-foreground"
        >
          Browse all pools
        </Link>
      </div>

      {createPanel}

      {consoleQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <PoolCardSkeleton />
          <PoolCardSkeleton />
        </div>
      ) : consoleQuery.isError ? (
        <ErrorNote
          title="Could not load your pools"
          detail={
            consoleQuery.error instanceof Error
              ? consoleQuery.error.message
              : "Unknown error reading from Arc testnet."
          }
          onRetry={() => {
            void consoleQuery.refetch();
          }}
        />
      ) : myPools.length === 0 ? (
        <EmptyState
          title="You have not funded a pool yet"
          detail="Create your first bounty pool and it will show up here with its aggregate outcomes as people join and get verified."
        />
      ) : (
        <>
          <PortfolioSummary aggregates={aggregates} />
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Your pools</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {myPools.map((pool, i) => (
                <SponsorPoolOutcome
                  key={pool.id.toString()}
                  pool={pool}
                  aggregate={aggregates[i]}
                  nowSeconds={consoleQuery.data?.asOfSeconds ?? 0n}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
