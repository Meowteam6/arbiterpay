"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import Link from "next/link";
import Countdown from "@/components/Countdown";
import JoinPool from "@/components/JoinPool";
import BackGoal from "@/components/BackGoal";
import ClaimPrivately from "@/components/ClaimPrivately";
import FundPool from "@/components/FundPool";
import EvidenceUpload from "@/components/EvidenceUpload";
import { Badge, ErrorNote, Skeleton, Stat } from "@/components/ui";
import { arcAddressUrl } from "@/lib/chains";
import {
  BOUNTY_MODEL_LABELS,
  displayGoalSpec,
  evidenceTypeOf,
  fetchParticipant,
  fetchParticipants,
  fetchPool,
  formatUsdc,
  shortAddress,
} from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";

function formatDay(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default function PoolDetail({ id }: { id: string }) {
  const { address } = useEmbeddedWallet();
  const poolId = useMemo(() => {
    try {
      const parsed = BigInt(id);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [id]);

  const poolQuery = useQuery({
    queryKey: ["pool", id],
    queryFn: () => {
      if (poolId === null) throw new Error("Invalid pool id.");
      return fetchPool(poolId);
    },
    enabled: poolId !== null,
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

  const pool = poolQuery.data;
  const participantCount = participantsQuery.data?.length ?? null;
  const evidenceType = evidenceTypeOf(pool.goalSpec);
  const isDocGoal = evidenceType === "document";
  const goalTitle = displayGoalSpec(pool.goalSpec);
  const hasJoined = participantQuery.data?.joined === true;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/pools"
          className="text-sm text-muted hover:text-foreground"
        >
          Back to pools
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge>{pool.initiative}</Badge>
          <Badge tone={isDocGoal ? "accent" : "muted"}>
            {isDocGoal ? "Document" : "Wearable"}
          </Badge>
          {pool.settled ? (
            <Badge tone="muted">Settled</Badge>
          ) : (
            <Badge tone="warning">Live</Badge>
          )}
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

      {!pool.settled ? (
        <div className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Participant actions
          </p>
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

          {hasJoined ? (
            <section className="rounded-2xl border border-accent/40 bg-surface p-5">
              <EvidenceUpload poolId={pool.id} goalSpec={pool.goalSpec} />
            </section>
          ) : null}

          <section className="rounded-2xl border border-edge bg-surface p-5">
            <BackGoal poolId={pool.id} />
          </section>

          {hasJoined ? (
            <ClaimPrivately poolId={String(pool.id)} />
          ) : null}
        </div>
      ) : (
        <section className="rounded-2xl border border-edge bg-surface p-5">
          <h2 className="text-lg font-semibold">This pool has settled</h2>
          <p className="mt-1 text-sm text-muted">
            Bounties were paid to verified achievers. Browse other pools to
            join a live one.
          </p>
        </section>
      )}

      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Sponsor action
        </p>
        <section className="rounded-2xl border border-edge bg-surface p-5">
          <FundPool poolId={pool.id} />
        </section>
      </div>
    </div>
  );
}
