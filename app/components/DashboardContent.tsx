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
//
// The two /api/junction/* reads on this page are signature-gated: a streak and
// a week of sleep hours are health data, and a wallet address is public, so
// knowing the address is not permission to read them. This is the one surface
// where a signature prompt on load is the right call - it is the signed-in
// user's own dashboard, asking for their own data - and one signature covers
// every read for the session. A refused prompt shows the reason and a way to
// try again, never an empty card that reads as "you have no wearable".

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import BalanceCard from "@/components/BalanceCard";
import Countdown from "@/components/Countdown";
import SignInPanel from "@/components/SignInPanel";
import { Badge, EmptyState, ErrorNote, Skeleton, TAP_TARGET } from "@/components/ui";
import {
  displayGoalSpec,
  evidenceTypeOf,
  fetchGoalId,
  fetchParticipant,
  fetchPools,
  fetchProofTier,
  formatUsdc,
  type ParticipantInfo,
  type PoolInfo,
} from "@/lib/contract";
import { dashboardDeferredLead, type ProofTier } from "@/lib/proof-tier";
import {
  fetchProviderState,
  providerAuthReason,
  providerConnected,
  providerDownReason,
  providerQueryKey,
} from "@/lib/wearable-provider";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useWalletAuth } from "@/lib/useWalletAuth";
import {
  authBlockReason,
  fetchWithWalletAuth,
  type WalletAuthRequester,
} from "@/lib/client-auth";

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

/** The deferred-claim note. A recorded-but-unsettled claim is owed money and is
 *  waiting on the clock - but a self-reported claim must NEVER read "Verified"
 *  here. The tier comes from the on-chain HealthVerdict facet (fetchProofTier);
 *  when it is unknown (registry unset or a read miss) the copy stays neutral and
 *  never claims verification. */
function DeferredNote({
  tier,
  settlesAt,
}: {
  tier: ProofTier | null;
  settlesAt: bigint;
}) {
  const { lead, tone, selfReported } = dashboardDeferredLead(tier);
  const cls =
    tone === "warning"
      ? "border-warning/40 bg-warning/10 text-warning"
      : "border-accent/30 bg-accent-deep/20 text-accent";
  return (
    <p className={`mt-3 rounded-xl border border-dashed p-3 text-sm ${cls}`}>
      {lead} SPOTTER settles this {selfReported ? "self-reported claim " : ""}
      when the pool period ends at {formatSettleMoment(settlesAt)} (
      <Countdown periodStart={0n} periodEnd={settlesAt} />) - no human involved,
      nothing for you to do.
    </p>
  );
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
  const requestAuth = useWalletAuth();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: providerQueryKey(address, pool?.id),
    queryFn: () => fetchProviderState(address, requestAuth, pool),
    retry: false,
  });

  const state = healthQuery.data;
  const downReason = providerDownReason(state);
  const authReason = providerAuthReason(state);
  const progress = state?.kind === "ok" ? state.progress : null;

  /** Sign, then re-read every junction card on the page. This button is the
   *  only place to sign from, so refetching just this card would leave the
   *  synced-data card below it hidden until a reload. */
  const unlock = () => {
    void (async () => {
      await requestAuth({ refresh: true });
      await queryClient.invalidateQueries({ queryKey: ["junction-progress"] });
      await queryClient.invalidateQueries({ queryKey: ["junction-data"] });
    })();
  };

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
      ) : authReason !== null ? (
        // Locked, not empty. Offering the connect flow here would tell someone
        // with a linked device to link it again.
        <>
          <p className="mt-3 rounded-xl border border-accent/40 bg-accent-deep/20 p-4 text-sm text-foreground/80">
            {authReason}
          </p>
          <button
            type="button"
            onClick={unlock}
            className={`mt-3 rounded-xl bg-accent-strong font-semibold text-background hover:bg-accent ${TAP_TARGET}`}
          >
            Sign and show my streak
          </button>
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

/** Per-day sleep and steps are health data, so the read is signed. A 401 is
 *  reported as its own state: the card is hidden rather than shown empty, and
 *  the streak card above carries the one call to action. */
type RecentDataResult =
  | { kind: "data"; data: RecentData }
  | { kind: "auth-required"; reason: string };

async function fetchRecentData(
  address: `0x${string}`,
  requestAuth: WalletAuthRequester,
): Promise<RecentDataResult> {
  const sent = await fetchWithWalletAuth(
    `/api/junction/data?address=${address}`,
    undefined,
    requestAuth,
  );
  if (sent.response.status === 401) {
    return {
      kind: "auth-required",
      reason:
        authBlockReason(sent.auth) ??
        "Sign with your wallet to see your synced data.",
    };
  }
  if (!sent.response.ok) {
    throw new Error(`Recent data feed responded ${sent.response.status}.`);
  }
  const j = (await sent.response.json()) as Partial<RecentData>;
  return {
    kind: "data",
    data: {
      connected: j.connected === true,
      sleep: Array.isArray(j.sleep) ? j.sleep : [],
      activity: Array.isArray(j.activity) ? j.activity : [],
    },
  };
}

/** Shows the latest few days pulled from the linked provider (demo proof). */
function RecentDataCard({ address }: { address: `0x${string}` }) {
  const requestAuth = useWalletAuth();
  const recentQuery = useQuery({
    queryKey: ["junction-data", address],
    queryFn: () => fetchRecentData(address, requestAuth),
    retry: false,
  });

  const result = recentQuery.data;
  const data = result?.kind === "data" ? result.data : undefined;
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
  const { ready, authenticated, address } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();

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
      return fetchProviderState(address, requestAuth);
    },
    enabled: address !== null,
    retry: false,
  });

  // Trust tier per deferred (recorded-but-unsettled) claim, read from the
  // on-chain HealthVerdict facet so a self-reported claim can never render as
  // "Verified" on its settling card. Only the deferred subset is read.
  const deferredEntries = (joinedQuery.data ?? []).filter(
    (entry) => deferredUntil(entry) !== null,
  );
  const deferredKey = deferredEntries
    .map((entry) => entry.pool.id.toString())
    .join(",");
  const deferredTierQuery = useQuery({
    queryKey: ["deferred-proof-tier", address, deferredKey],
    enabled: address !== null && deferredEntries.length > 0,
    queryFn: async (): Promise<Map<string, ProofTier>> => {
      const map = new Map<string, ProofTier>();
      await Promise.all(
        deferredEntries.map(async (entry) => {
          try {
            if (address === null) return;
            const goalId = await fetchGoalId(entry.pool.id, address);
            map.set(entry.pool.id.toString(), await fetchProofTier(goalId));
          } catch {
            map.set(entry.pool.id.toString(), "unknown");
          }
        }),
      );
      return map;
    },
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
    // The email-first panel is the default path (we make the wallet); an
    // external wallet is the deliberate second choice inside it. Replacing the
    // bare login() button here means a first-time visitor never has to guess
    // what "Sign in" will pop up.
    return (
      <div className="mx-auto max-w-md space-y-4">
        <div className="text-center">
          <p className="text-lg font-semibold">Sign in to see your goals</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Your joined pools, streak progress, and payouts live here once you
            sign in.
          </p>
        </div>
        <SignInPanel />
      </div>
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
                  <DeferredNote
                    tier={deferredTierQuery.data?.get(pool.id.toString()) ?? null}
                    settlesAt={settlesAt}
                  />
                ) : null}
              </Link>
            );
          })
        )}
      </section>

      {/* The locked case earns the card too: a wearable may well be linked
       *  and simply unreadable until the signature lands, and dropping the
       *  card would leave nowhere to sign from. */}
      {wearableConnected ||
      wearablePool !== undefined ||
      providerAuthReason(connectionQuery.data) !== null ? (
        <StreakCard address={address} pool={wearablePool} />
      ) : null}
      <RecentDataCard address={address} />
      <BalanceCard address={address} />
    </div>
  );
}
