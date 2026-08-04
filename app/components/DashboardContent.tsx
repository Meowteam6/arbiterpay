"use client";

// The signed-in home. Joined pools lead - for a fresh account that means the
// Browse-pools empty state is the first thing on screen, not a zero balance.
// The streak card renders only when wearable data can exist, and the balance
// card sits below the goal content because funding is secondary to progress.
//
// Two silences fixed here. The connect button used to swallow its failure into
// console.error, so a provider outage read as a dead button; it now says what
// went wrong, and when the provider is the problem it stops offering a connect
// flow that cannot succeed. And a verified claim waiting on its pool period
// used to look identical to one still being judged, with nothing on screen
// saying when the money arrives - the chain already knows, so the card says it.

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BalanceCard from "@/components/BalanceCard";
import Countdown from "@/components/Countdown";
import { Badge, EmptyState, ErrorNote, Skeleton, TAP_TARGET } from "@/components/ui";
import {
  displayGoalSpec,
  evidenceTypeOf,
  fetchParticipant,
  fetchPools,
  formatUsdc,
  type ParticipantInfo,
  type PoolInfo,
} from "@/lib/contract";
import {
  fetchProviderState,
  providerConnected,
  providerDownReason,
  providerQueryKey,
} from "@/lib/wearable-provider";
import { useEmbeddedWallet } from "@/lib/wallet";

interface JoinedPool {
  pool: PoolInfo;
  participant: ParticipantInfo;
}

/** Open Junction Link to connect a provider (WHOOP, Oura, Fitbit, Garmin…). */
async function connectHealthData(address: `0x${string}`): Promise<void> {
  const res = await fetch("/api/junction/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!res.ok) throw new Error(`Link token request failed (${res.status}).`);
  const { linkUrl } = (await res.json()) as { linkUrl?: string };
  if (typeof linkUrl === "string") window.open(linkUrl, "_blank", "noopener");
}

async function fetchJoinedPools(address: `0x${string}`): Promise<JoinedPool[]> {
  const pools = await fetchPools();
  const participants = await Promise.all(
    pools.map((pool) => fetchParticipant(pool.id, address)),
  );
  return pools
    .map((pool, i) => ({ pool, participant: participants[i] }))
    .filter((entry) => entry.participant.joined);
}

function resultLabel(p: ParticipantInfo): { text: string; tone: "accent" | "muted" | "warning" } {
  if (!p.resultRecorded) return { text: "Pending verification", tone: "warning" };
  if (p.verdict) {
    const multiplier = (p.multiplierBps / 10_000).toFixed(2);
    return { text: `Achieved at ${multiplier}x`, tone: "accent" };
  }
  return { text: "Goal missed", tone: "muted" };
}

/** A verified result on a pool that has not settled yet: the money is owed and
 *  is waiting on the clock, nothing else. The chain alone says this - the
 *  participant's verdict is recorded and the pool is unsettled - so no ledger
 *  read is needed to tell someone when to come back. */
function deferredUntil(entry: JoinedPool): bigint | null {
  const { pool, participant } = entry;
  if (pool.settled) return null;
  if (!participant.resultRecorded || !participant.verdict) return null;
  return pool.periodEnd;
}

function formatSettleMoment(periodEnd: bigint): string {
  return new Date(Number(periodEnd) * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ConnectButton({
  address,
  label = "Connect health data",
  secondary = false,
}: {
  address: `0x${string}`;
  label?: string;
  secondary?: boolean;
}) {
  // The failure used to go to console.error only, which made the button look
  // dead to anyone whose connect flow could not start. It is a money-adjacent
  // path (no wearable, no verification, no payout), so it reports.
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  return (
    <>
      <button
        type="button"
        disabled={opening}
        onClick={() => {
          setError(null);
          setOpening(true);
          void connectHealthData(address)
            .catch((err: unknown) => {
              setError(
                err instanceof Error
                  ? err.message
                  : "Could not open the connect flow.",
              );
            })
            .finally(() => setOpening(false));
        }}
        className={`mt-3 rounded-xl font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${TAP_TARGET} ${
          secondary
            ? "border border-edge text-foreground hover:border-accent/50"
            : "bg-accent-strong text-background hover:bg-accent"
        }`}
      >
        {opening ? "Opening the connect flow" : label}
      </button>
      {error !== null ? (
        <div className="mt-3">
          <ErrorNote
            title="Could not start the connect flow"
            detail={`${error} Nothing was connected and nothing was charged.`}
            onRetry={() => setError(null)}
          />
        </div>
      ) : null}
    </>
  );
}

function StreakCard({
  address,
  pool,
}: {
  address: `0x${string}`;
  pool?: PoolInfo;
}) {
  const healthQuery = useQuery({
    queryKey: providerQueryKey(address, pool?.id),
    queryFn: () => fetchProviderState(address, pool),
    retry: false,
  });

  const state = healthQuery.data;
  const downReason = providerDownReason(state);
  const progress = state?.kind === "ok" ? state.progress : null;

  return (
    <section className="rounded-2xl border border-edge bg-surface p-5">
      <h2 className="text-lg font-semibold">Streak progress</h2>
      {healthQuery.isLoading ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      ) : downReason !== null ? (
        // No connect button here on purpose: while the provider is refusing
        // us, the connect call fails too, so offering it is a loop with no
        // exit. Document-verified pools still work, so point at those.
        <>
          <p className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-foreground/80">
            {downReason} Connecting a device would not change it, so there is
            nothing for you to do here right now.
          </p>
          <Link
            href="/pools"
            className={`mt-3 rounded-xl border border-edge font-semibold text-foreground hover:border-accent/50 ${TAP_TARGET}`}
          >
            Find a goal you can still prove
          </Link>
        </>
      ) : !providerConnected(state) ? (
        <>
          <p className="mt-3 rounded-xl border border-dashed border-edge p-4 text-sm text-muted">
            No wearable connected yet. Link a provider (WHOOP, Oura, Fitbit,
            Garmin…) to start tracking your streak toward the bounty.
          </p>
          <ConnectButton address={address} />
        </>
      ) : (
        <div className="mt-3">
          <p className="text-3xl font-bold text-accent">
            {progress?.streakDays ?? 0}
            <span className="text-lg font-semibold text-foreground">
              {progress?.targetDays !== null && progress?.targetDays !== undefined
                ? ` of ${progress.targetDays} days`
                : " days"}
            </span>
          </p>
          <p className="mt-1 text-sm text-muted">
            {progress?.metric ?? "Verified streak"}
            {progress?.lastSync !== null && progress?.lastSync !== undefined
              ? ` · last sync ${progress.lastSync}`
              : ""}
          </p>
          <ConnectButton
            address={address}
            label="Connect / switch provider"
            secondary
          />
        </div>
      )}
    </section>
  );
}

interface RecentData {
  connected: boolean;
  sleep: Array<{ date: string; score: number | null; hours: number | null }>;
  activity: Array<{ date: string; steps: number | null }>;
}

async function fetchRecentData(address: `0x${string}`): Promise<RecentData> {
  const res = await fetch(`/api/junction/data?address=${address}`);
  if (!res.ok) throw new Error(`Recent data feed responded ${res.status}.`);
  const j = (await res.json()) as Partial<RecentData>;
  return {
    connected: j.connected === true,
    sleep: Array.isArray(j.sleep) ? j.sleep : [],
    activity: Array.isArray(j.activity) ? j.activity : [],
  };
}

/** Shows the latest few days pulled from the linked provider (demo proof). */
function RecentDataCard({ address }: { address: `0x${string}` }) {
  const recentQuery = useQuery({
    queryKey: ["junction-data", address],
    queryFn: () => fetchRecentData(address),
    retry: false,
  });

  const data = recentQuery.data;
  if (
    recentQuery.isLoading ||
    data === undefined ||
    !data.connected ||
    (data.sleep.length === 0 && data.activity.length === 0)
  ) {
    return null; // only render once a provider is linked and data exists
  }

  return (
    <section className="rounded-2xl border border-edge bg-surface p-5">
      <h2 className="text-lg font-semibold">Latest synced data</h2>
      <p className="mt-1 text-sm text-muted">
        Pulled live from your linked provider via Junction.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {data.sleep.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-muted">Sleep</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {data.sleep.slice(0, 7).map((d) => (
                <li key={`s-${d.date}`} className="flex justify-between">
                  <span className="text-muted">{d.date}</span>
                  <span className="font-medium">
                    {d.hours !== null ? `${d.hours}h` : "—"}
                    {d.score !== null ? ` · score ${d.score}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.activity.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-muted">Steps</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {data.activity.slice(0, 7).map((d) => (
                <li key={`a-${d.date}`} className="flex justify-between">
                  <span className="text-muted">{d.date}</span>
                  <span className="font-medium">
                    {d.steps !== null ? d.steps.toLocaleString() : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

export default function DashboardContent() {
  const { ready, authenticated, address, login } = useEmbeddedWallet();

  const joinedQuery = useQuery({
    queryKey: ["joined-pools", address],
    queryFn: () => {
      if (address === null) throw new Error("No wallet address.");
      return fetchJoinedPools(address);
    },
    enabled: address !== null,
  });

  // The streak card only makes sense when wearable data can exist: either a
  // provider is already linked or the user has skin in a wearable pool. For
  // everyone else (document goals, fresh accounts) it is noise. The key
  // matches StreakCard's no-pool query exactly so the cache serves both
  // instead of fetching the same endpoint twice per dashboard load.
  const connectionQuery = useQuery({
    queryKey: providerQueryKey(address),
    queryFn: () => {
      if (address === null) throw new Error("No wallet address.");
      return fetchProviderState(address);
    },
    enabled: address !== null,
    retry: false,
  });

  if (!ready) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (!authenticated || address === null) {
    return (
      <EmptyState
        title="Sign in to see your goals"
        detail="Your joined pools, streak progress, and payouts live here once you sign in."
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
    );
  }

  const wearableConnected = providerConnected(connectionQuery.data);
  const wearablePool = (joinedQuery.data ?? []).find(
    ({ pool }) => evidenceTypeOf(pool.goalSpec) === "wearable",
  )?.pool;

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Joined pools</h2>
        {joinedQuery.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : joinedQuery.isError ? (
          <ErrorNote
            title="Could not load your pools"
            detail={
              joinedQuery.error instanceof Error
                ? joinedQuery.error.message
                : "Unknown error reading from Arc testnet."
            }
            onRetry={() => {
              void joinedQuery.refetch();
            }}
          />
        ) : (joinedQuery.data ?? []).length === 0 ? (
          <EmptyState
            title="Nothing on the line yet"
            detail="Pick a goal somebody else's USDC is staked on. One wallet, one entry, and SPOTTER pays the moment you prove it."
            action={
              <Link
                href="/pools"
                className="inline-block rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
              >
                Browse pools
              </Link>
            }
          />
        ) : (
          (joinedQuery.data ?? []).map((entry) => {
            const { pool, participant } = entry;
            const result = resultLabel(participant);
            const settlesAt = deferredUntil(entry);
            return (
              <Link
                key={pool.id.toString()}
                href={`/pools/${pool.id.toString()}`}
                className="block rounded-2xl border border-edge bg-surface p-5 transition-colors hover:border-accent/50"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge>{pool.initiative}</Badge>
                  <Badge tone={result.tone}>{result.text}</Badge>
                </div>
                <h3 className="mt-3 text-lg font-semibold leading-snug">
                  {displayGoalSpec(pool.goalSpec)}
                </h3>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
                  <span>
                    Bounty pool{" "}
                    <span className="font-semibold text-accent">
                      {formatUsdc(pool.balance)} USDC
                    </span>
                  </span>
                  <span>
                    Backed with{" "}
                    <span className="font-semibold text-foreground">
                      {formatUsdc(participant.backingTotal)} USDC
                    </span>
                  </span>
                  <Countdown
                    periodStart={pool.periodStart}
                    periodEnd={pool.periodEnd}
                  />
                </div>
                {settlesAt !== null ? (
                  <p className="mt-3 rounded-xl border border-dashed border-accent/30 bg-accent-deep/20 p-3 text-sm text-accent">
                    Verified and recorded on-chain. SPOTTER settles this when
                    the pool period ends at {formatSettleMoment(settlesAt)} (
                    <Countdown periodStart={0n} periodEnd={settlesAt} />
                    ) - no human involved, nothing for you to do.
                  </p>
                ) : null}
              </Link>
            );
          })
        )}
      </section>

      {wearableConnected || wearablePool !== undefined ? (
        <StreakCard address={address} pool={wearablePool} />
      ) : null}
      <RecentDataCard address={address} />
      <BalanceCard address={address} />
    </div>
  );
}
