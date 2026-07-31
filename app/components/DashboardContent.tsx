"use client";

// The signed-in home. Joined pools lead - for a fresh account that means the
// Browse-pools empty state is the first thing on screen, not a zero balance.
// The streak card renders only when wearable data can exist, and the balance
// card sits below the goal content because funding is secondary to progress.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import BalanceCard from "@/components/BalanceCard";
import Countdown from "@/components/Countdown";
import { Badge, EmptyState, ErrorNote, Skeleton } from "@/components/ui";
import {
  displayGoalSpec,
  evidenceTypeOf,
  fetchParticipant,
  fetchPools,
  formatUsdc,
  type ParticipantInfo,
  type PoolInfo,
} from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";

interface JoinedPool {
  pool: PoolInfo;
  participant: ParticipantInfo;
}

interface HealthProgress {
  connected: boolean;
  metric: string | null;
  streakDays: number | null;
  targetDays: number | null;
  lastSync: string | null;
}

type HealthState =
  | { kind: "ok"; progress: HealthProgress }
  | { kind: "unavailable"; reason: string };

function parseHealthProgress(payload: unknown): HealthProgress {
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  return {
    connected: record.connected === true,
    metric: typeof record.metric === "string" ? record.metric : null,
    streakDays:
      typeof record.streakDays === "number" ? record.streakDays : null,
    targetDays:
      typeof record.targetDays === "number" ? record.targetDays : null,
    lastSync: typeof record.lastSync === "string" ? record.lastSync : null,
  };
}

async function fetchHealthProgress(
  address: `0x${string}`,
  pool?: PoolInfo,
): Promise<HealthState> {
  try {
    const windowQuery = pool
      ? `&start=${Number(pool.periodStart)}&end=${Number(pool.periodEnd)}`
      : "";
    const res = await fetch(
      `/api/junction/progress?address=${address}${windowQuery}`,
    );
    if (!res.ok) {
      return {
        kind: "unavailable",
        reason: `Health progress feed responded ${res.status}.`,
      };
    }
    return { kind: "ok", progress: parseHealthProgress(await res.json()) };
  } catch {
    return {
      kind: "unavailable",
      reason: "Could not reach the health progress feed.",
    };
  }
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

function ConnectButton({
  address,
  label = "Connect health data",
  secondary = false,
}: {
  address: `0x${string}`;
  label?: string;
  secondary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        void connectHealthData(address).catch((err) => {
          console.error(err);
        });
      }}
      className={
        secondary
          ? "mt-3 rounded-xl border border-edge px-4 py-2 text-sm font-semibold text-foreground hover:border-accent/50"
          : "mt-3 rounded-xl bg-accent-strong px-4 py-2 text-sm font-semibold text-background hover:bg-accent"
      }
    >
      {label}
    </button>
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
    queryKey: ["junction-progress", address, pool?.id.toString() ?? "none"],
    queryFn: () => fetchHealthProgress(address, pool),
    retry: false,
  });

  return (
    <section className="rounded-2xl border border-edge bg-surface p-5">
      <h2 className="text-lg font-semibold">Streak progress</h2>
      {healthQuery.isLoading ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      ) : healthQuery.data === undefined ||
        healthQuery.data.kind === "unavailable" ? (
        <>
          <p className="mt-3 rounded-xl border border-dashed border-edge p-4 text-sm text-muted">
            {healthQuery.data?.kind === "unavailable"
              ? healthQuery.data.reason
              : "Streak feed unavailable."}{" "}
            Connect a wearable (WHOOP, Oura, Fitbit, Garmin…) to see verified
            streak progress here.
          </p>
          <ConnectButton address={address} />
        </>
      ) : !healthQuery.data.progress.connected ? (
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
            {healthQuery.data.progress.streakDays ?? 0}
            <span className="text-lg font-semibold text-foreground">
              {healthQuery.data.progress.targetDays !== null
                ? ` of ${healthQuery.data.progress.targetDays} days`
                : " days"}
            </span>
          </p>
          <p className="mt-1 text-sm text-muted">
            {healthQuery.data.progress.metric ?? "Verified streak"}
            {healthQuery.data.progress.lastSync !== null
              ? ` · last sync ${healthQuery.data.progress.lastSync}`
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
    queryKey: ["junction-progress", address, "none"],
    queryFn: () => {
      if (address === null) throw new Error("No wallet address.");
      return fetchHealthProgress(address);
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

  const wearableConnected =
    connectionQuery.data?.kind === "ok" &&
    connectionQuery.data.progress.connected;
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
          (joinedQuery.data ?? []).map(({ pool, participant }) => {
            const result = resultLabel(participant);
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
