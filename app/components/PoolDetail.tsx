"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import Link from "next/link";
import Countdown from "@/components/Countdown";
import JoinPool from "@/components/JoinPool";
import BackGoal from "@/components/BackGoal";
import FundPool from "@/components/FundPool";
import EvidenceUpload from "@/components/EvidenceUpload";
import WearableCheck from "@/components/WearableCheck";
import { Badge, ErrorNote, Skeleton, Stat, TAP_TARGET } from "@/components/ui";
import { arcAddressUrl } from "@/lib/chains";
import {
  AGENT_WALLET_QUERY_KEY,
  agentIsBroke,
  fetchAgentWallet,
} from "@/lib/agent-budget";
import type { LedgerEntry } from "@/lib/agent-receipt";
import { fetchWithWalletAuth } from "@/lib/client-auth";
import { useWalletAuth } from "@/lib/useWalletAuth";
import { claimProofPathOf, type ProofPath } from "@/lib/claim-restore";
import {
  fetchProviderState,
  providerDownReason,
  providerQueryKey,
} from "@/lib/wearable-provider";
import {
  BOUNTY_MODEL_LABELS,
  displayGoalSpec,
  evidenceTypeOf,
  fetchGoalId,
  fetchParticipant,
  fetchParticipants,
  fetchPool,
  formatUsdc,
  shortAddress,
} from "@/lib/contract";
import { poolCanPay, poolPhase } from "@/lib/pool-lifecycle";
import { useEmbeddedWallet } from "@/lib/wallet";

function formatDay(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** Every terminal state on this page ends with somewhere to go. A pool that
 *  has settled or expired is not a place to leave someone standing. */
function BrowsePoolsLink({ label = "Browse live pools" }: { label?: string }) {
  return (
    <Link
      href="/pools"
      className={`mt-4 rounded-xl bg-accent-strong font-semibold text-background hover:bg-accent ${TAP_TARGET}`}
    >
      {label}
    </Link>
  );
}

export default function PoolDetail({ id }: { id: string }) {
  const { address } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();
  // Wearable pools offer two proof paths, but only one may be mounted at a
  // time: WearableCheck and EvidenceUpload both drive SPOTTER's run loop for
  // the same goal id, and two concurrent pollers with conflicting evidence
  // kinds is an untested surface on a money path.
  //
  // The visitor's own choice wins; below it, whichever path an existing claim
  // used (so a returning user is not stranded behind the other tab); below
  // that, the wearable default. Derived rather than stored so the restore can
  // never race the render or overwrite a tap.
  const [pinnedPath, setPinnedPath] = useState<ProofPath | null>(null);
  const choosePath = (path: ProofPath) => setPinnedPath(path);
  const poolId = useMemo(() => {
    try {
      const parsed = BigInt(id);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [id]);

  // The clock is read alongside the fetch, not during render, so the phase
  // decision stays pure. The query client disables focus refetches, so a
  // polling interval re-classifies the pool while the page sits open - a
  // live pool crossing its period end must drop the join UI, not offer a
  // button that reverts with PERIOD_ENDED.
  const poolQuery = useQuery({
    queryKey: ["pool", id],
    queryFn: async () => {
      if (poolId === null) throw new Error("Invalid pool id.");
      return {
        pool: await fetchPool(poolId),
        asOfSeconds: BigInt(Math.floor(Date.now() / 1000)),
      };
    },
    enabled: poolId !== null,
    refetchInterval: 30_000,
  });

  const participantsQuery = useQuery({
    queryKey: ["participants", id],
    queryFn: () => {
      if (poolId === null) throw new Error("Invalid pool id.");
      return fetchParticipants(poolId);
    },
    enabled: poolId !== null,
  });

  const participantQuery = useQuery({
    queryKey: ["participant", id, address],
    queryFn: () => {
      if (poolId === null) throw new Error("Invalid pool id.");
      if (address === null) throw new Error("No wallet connected.");
      return fetchParticipant(poolId, address);
    },
    enabled: poolId !== null && address !== null,
  });

  // Wearable goals depend on an outside provider that can refuse us outright.
  // Shares one query key with the dashboard and the pool list.
  //
  // cachedOnly: this read decides whether to offer a join button, and nobody
  // asked to unlock anything by opening a pool page. It uses a signature the
  // session already has and otherwise comes back unsigned - which reports as
  // "not known", never as an outage, so no goal is pulled off the page over a
  // signature the visitor was never asked for.
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

  // SPOTTER pays for verification from its own wallet. When that wallet is
  // empty, a claim started here dies at the buy step, so say so before the
  // person taps rather than after.
  const agentWalletQuery = useQuery({
    queryKey: AGENT_WALLET_QUERY_KEY,
    queryFn: fetchAgentWallet,
    staleTime: 15_000,
  });

  const isWearableGoal =
    poolQuery.data !== undefined &&
    evidenceTypeOf(poolQuery.data.pool.goalSpec) === "wearable";
  const joined = participantQuery.data?.joined === true;

  // Which tab owns an existing claim. Only wearable pools have two tabs, so
  // this is the only case where the answer can be wrong; the ledger is read
  // once and the claim section waits for it rather than mounting the wrong
  // path first and swapping it out from under a running restore.
  //
  // The read is owner-only, so it carries the wallet signature - but
  // cachedOnly, exactly like providerQuery above. Opening a pool page is not a
  // request to unlock anything, and this query gates the claim section behind
  // a skeleton, so a prompting read here would be the first thing that happens
  // on load for anyone who joined a wearable pool. Without a signature the
  // server returns no entries, the path is unknown, and the default tab stands
  // - the claim client itself then prompts and says why.
  const claimPathQuery = useQuery({
    queryKey: ["claim-proof-path", id, address],
    queryFn: async (): Promise<ProofPath | null> => {
      if (poolId === null || address === null) {
        throw new Error("No claim identity yet.");
      }
      const goalId = await fetchGoalId(poolId, address);
      const sent = await fetchWithWalletAuth(
        `/api/agent/run/${goalId}?poolId=${poolId.toString()}`,
        undefined,
        (options) => requestAuth({ ...options, cachedOnly: true }),
      );
      if (!sent.response.ok) {
        throw new Error(`ledger read responded ${sent.response.status}`);
      }
      const body = (await sent.response.json().catch(() => ({}))) as {
        ledger?: LedgerEntry[];
      };
      return claimProofPathOf(Array.isArray(body.ledger) ? body.ledger : []);
    },
    enabled: poolId !== null && address !== null && joined && isWearableGoal,
    retry: false,
    staleTime: 60_000,
  });

  const proofPath: ProofPath =
    pinnedPath ?? claimPathQuery.data ?? "wearable";

  if (poolId === null) {
    return (
      <ErrorNote
        title="Invalid pool"
        detail={`"${id}" is not a valid pool id.`}
      />
    );
  }

  if (poolQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-9 w-3/4" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-14" />
      </div>
    );
  }

  if (poolQuery.isError || poolQuery.data === undefined) {
    return (
      <ErrorNote
        title="Could not load this pool"
        detail={
          poolQuery.error instanceof Error
            ? poolQuery.error.message
            : "Unknown error reading from Arc testnet."
        }
        onRetry={() => {
          void poolQuery.refetch();
        }}
      />
    );
  }

  const { pool, asOfSeconds } = poolQuery.data;
  const participantCount = participantsQuery.data?.length ?? null;
  const evidenceType = evidenceTypeOf(pool.goalSpec);
  const isDocGoal = evidenceType === "document";
  const goalTitle = displayGoalSpec(pool.goalSpec);
  const hasJoined = participantQuery.data?.joined === true;
  // joinPool and backGoal revert with PERIOD_ENDED once the period closes,
  // so an expired pool must never offer either action. Evidence and the
  // receipt stay visible for joined participants until settlement runs.
  const phase = poolPhase(pool, asOfSeconds);

  // A wearable goal with the provider refusing us cannot be checked at all.
  // The entry fee is real money paid up front, so the join action comes off
  // the page rather than selling a goal SPOTTER has no way to verify.
  const providerDown = providerDownReason(providerQuery.data);
  const unverifiableNow = providerDown !== null && evidenceType === "wearable";
  const agentBroke = agentIsBroke(agentWalletQuery.data?.balanceUsd ?? null);
  // Wait for the restore before mounting either tab; mounting the wrong one
  // first would start a poll loop the correct tab then has to supersede.
  const claimPathPending = isWearableGoal && hasJoined && claimPathQuery.isLoading;

  // The single mounted claim surface. Wearable pools default to the wearable
  // check with the document upload one tap away; document pools upload only.
  const claimSection = !hasJoined ? null : (
    <>
      {agentBroke ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
          <p className="text-base font-semibold text-warning">
            SPOTTER is out of budget
          </p>
          <p className="mt-1 text-sm text-foreground/80">
            The agent buys every verification from its own wallet, and that
            wallet reads 0.00 USDC. A check started now stops at the buy step
            and nobody gets paid. Nothing you did - come back once it is topped
            up.
          </p>
          <Link
            href="/agent"
            className={`mt-3 rounded-xl border border-warning/50 text-warning hover:bg-warning/10 ${TAP_TARGET}`}
          >
            See SPOTTER&apos;s wallet
          </Link>
        </div>
      ) : null}
      {evidenceType === "wearable" ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => choosePath("wearable")}
            className={`rounded-xl border ${TAP_TARGET} ${
              proofPath === "wearable"
                ? "border-accent/50 bg-accent-deep text-accent"
                : "border-edge bg-surface-raised text-muted hover:text-foreground"
            }`}
          >
            Verify from wearable
          </button>
          <button
            type="button"
            onClick={() => choosePath("document")}
            className={`rounded-xl border ${TAP_TARGET} ${
              proofPath === "document"
                ? "border-accent/50 bg-accent-deep text-accent"
                : "border-edge bg-surface-raised text-muted hover:text-foreground"
            }`}
          >
            Upload proof instead
          </button>
        </div>
      ) : null}
      <section className="rounded-2xl border border-accent/40 bg-surface p-5">
        {claimPathPending ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-16" />
          </div>
        ) : evidenceType === "wearable" && proofPath === "wearable" ? (
          <WearableCheck
            poolId={pool.id}
            goalSpec={pool.goalSpec}
            onSwitchToDocument={() => choosePath("document")}
          />
        ) : (
          <EvidenceUpload poolId={pool.id} goalSpec={pool.goalSpec} />
        )}
      </section>
    </>
  );

  return (
    <div className="space-y-8">
      <div>
        {/* -ml-4 keeps the text optically flush with the heading below while
            the padding gives the link a real 44px thumb target. */}
        <Link
          href="/pools"
          className={`-ml-4 text-muted hover:text-foreground ${TAP_TARGET}`}
        >
          Back to pools
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge>{pool.initiative}</Badge>
          <Badge tone={isDocGoal ? "accent" : "muted"}>
            {isDocGoal ? "Document" : "Wearable"}
          </Badge>
          {phase === "settled" ? (
            <Badge tone="muted">Settled</Badge>
          ) : phase === "expired" ? (
            <Badge tone="warning">Expired</Badge>
          ) : (
            <Badge tone="accent">Live</Badge>
          )}
          {unverifiableNow && phase === "live" ? (
            <Badge tone="warning">Cannot verify right now</Badge>
          ) : null}
        </div>
        {isDocGoal ? (
          <p className="mt-3 text-sm font-semibold uppercase tracking-wide text-accent">
            Preventive care - Earn from a {formatUsdc(pool.balance)} USDC bounty
          </p>
        ) : null}
        <h1 className="mt-3 text-2xl font-bold leading-tight sm:text-3xl">
          {goalTitle}
        </h1>
        <p className="mt-2 text-sm text-muted">
          Funder{" "}
          <a
            href={arcAddressUrl(pool.creator)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono underline decoration-edge underline-offset-2 hover:text-foreground"
          >
            {shortAddress(pool.creator)}
          </a>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Bounty pool"
          value={
            <span className="text-accent">{formatUsdc(pool.balance)} USDC</span>
          }
        />
        <Stat label="Entry fee" value={`${formatUsdc(pool.entryFee)} USDC`} />
        <Stat
          label="Time remaining"
          value={
            <Countdown
              periodStart={pool.periodStart}
              periodEnd={pool.periodEnd}
            />
          }
        />
        <Stat
          label="Payout model"
          value={BOUNTY_MODEL_LABELS[pool.bountyModel] ?? "Custom model"}
        />
        <Stat
          label="Participants"
          value={participantCount !== null ? participantCount : "--"}
        />
        <Stat label="Starts" value={formatDay(pool.periodStart)} />
        <Stat label="Ends" value={formatDay(pool.periodEnd)} />
      </div>

      {phase === "live" ? (
        <div className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Participant actions
          </p>
          {!poolCanPay(pool) ? (
            <section className="rounded-2xl border border-warning/40 bg-warning/10 p-5">
              <h2 className="text-lg font-semibold text-warning">
                This pool cannot pay out
              </h2>
              <p className="mt-1 text-sm text-foreground/80">
                It was created with no bounty per achiever, so even a verified
                claim settles to zero USDC. We are not offering to join or
                upload here - it would pass verification and pay you nothing.
              </p>
              <BrowsePoolsLink label="Find a pool that can pay" />
            </section>
          ) : unverifiableNow && !hasJoined ? (
            <section className="rounded-2xl border border-warning/40 bg-warning/10 p-5">
              <h2 className="text-lg font-semibold text-warning">
                This goal cannot be verified right now
              </h2>
              <p className="mt-1 text-sm text-foreground/80">{providerDown}</p>
              <p className="mt-2 text-sm text-foreground/80">
                The {formatUsdc(pool.entryFee)} USDC entry fee is real money and
                joining will not be offered while SPOTTER has no way to check
                the goal. Document-verified pools are unaffected.
              </p>
              <BrowsePoolsLink label="Find a pool that can pay" />
            </section>
          ) : (
            <section className="rounded-2xl border border-edge bg-surface p-5">
              <h2 className="text-lg font-semibold">Join this pool</h2>
              <p className="mb-4 mt-1 text-sm text-muted">
                {isDocGoal
                  ? `Pay the ${formatUsdc(pool.entryFee)} USDC entry fee, then upload your record. The bounty pays out the moment your document is verified.`
                  : `Pay the ${formatUsdc(pool.entryFee)} USDC entry fee, hit the goal during the period, and the bounty pays out the moment your result is verified.`}
              </p>
              {participantCount === 0 ? (
                <p className="mb-4 rounded-xl border border-dashed border-accent/30 bg-accent-deep/20 p-3 text-sm text-accent">
                  No one has joined yet, be the first.
                </p>
              ) : null}
              <JoinPool
                poolId={pool.id}
                entryFee={pool.entryFee}
                alreadyJoined={hasJoined}
              />
            </section>
          )}

          {poolCanPay(pool) ? claimSection : null}

          {/* Backers are only ever paid on ACHIEVERS (HealthPools._payBackers).
              A pool that cannot pay its achievers also cannot make backing win,
              and with join/upload suppressed no one here can become an achiever,
              so a stake would only forfeit. Hide backing on unpayable pools. */}
          {poolCanPay(pool) ? (
            <section className="rounded-2xl border border-edge bg-surface p-5">
              <BackGoal poolId={pool.id} />
            </section>
          ) : null}
        </div>
      ) : phase === "expired" ? (
        <div className="space-y-4">
          <section className="rounded-2xl border border-edge bg-surface p-5">
            <h2 className="text-lg font-semibold">This pool has ended</h2>
            <p className="mt-1 text-sm text-muted">
              The goal window closed on {formatDay(pool.periodEnd)}, so joining
              and backing are closed. SPOTTER settles the payouts for verified
              achievers now that the period is over.
            </p>
            {!hasJoined ? (
              <>
                <p className="mt-2 text-sm text-muted">
                  {participantCount === 0
                    ? "Nobody joined this one, so there is nothing here to settle."
                    : "You are not in this pool, so nothing here settles for you."}
                </p>
                <BrowsePoolsLink />
              </>
            ) : null}
          </section>

          {hasJoined ? (
            <>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                Your claim
              </p>
              {claimSection}
            </>
          ) : null}
        </div>
      ) : (
        <section className="rounded-2xl border border-edge bg-surface p-5">
          <h2 className="text-lg font-semibold">This pool has settled</h2>
          <p className="mt-1 text-sm text-muted">
            Bounties were paid to verified achievers. Nothing more happens on
            this pool - the next payout is on a pool that is still open.
          </p>
          <BrowsePoolsLink />
        </section>
      )}

      {phase !== "settled" ? (
        <div className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Sponsor action
          </p>
          <section className="rounded-2xl border border-edge bg-surface p-5">
            <FundPool poolId={pool.id} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
