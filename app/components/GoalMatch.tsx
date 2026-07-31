"use client";

// The /goal match screen: the typed goal meets the money already staked on
// it. Ranking comes from the keyword route; the top match leads, the rest
// stay one tap away.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { displayGoalSpec, formatUsdc } from "@/lib/contract";
import { Badge, EmptyState, ErrorNote, Money, Skeleton } from "@/components/ui";

interface Match {
  poolId: string;
  initiative: string;
  goalSpec: string;
  balance: string;
  entryFee: string;
  periodEnd: string;
  score: number;
}

// The match API returns base-unit strings; a cached or partial response must
// degrade to an omitted row, never to a BigInt throw that takes down the page.
function safeUsdc(raw: unknown): string | null {
  return typeof raw === "string" && /^\d+$/.test(raw)
    ? formatUsdc(BigInt(raw))
    : null;
}

function formatDeadline(periodEnd: unknown): string | null {
  const seconds = typeof periodEnd === "string" ? Number(periodEnd) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function MatchCard({ match, lead }: { match: Match; lead: boolean }) {
  const balanceUsd = safeUsdc(match.balance);
  const entryFeeUsd = safeUsdc(match.entryFee);
  const deadline = formatDeadline(match.periodEnd);
  return (
    <Link
      href={`/pools/${match.poolId}`}
      className={`block rounded-2xl border bg-surface p-5 transition-colors hover:border-accent/50 ${
        lead ? "border-accent/40" : "border-edge"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge>{match.initiative}</Badge>
        {lead ? <Badge tone="accent">closest match</Badge> : null}
      </div>
      <p className="mt-3 text-base font-semibold">
        {displayGoalSpec(match.goalSpec)}
      </p>
      {balanceUsd !== null ? (
        <p className="mt-2 text-sm text-muted">
          <Money usd={balanceUsd} size="sm" /> staked by a sponsor. Not you.
        </p>
      ) : null}
      {entryFeeUsd !== null || deadline !== null ? (
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
          {entryFeeUsd !== null ? (
            <span>
              Entry fee <Money usd={entryFeeUsd} size="sm" />
            </span>
          ) : null}
          {deadline !== null ? <span>Ends {deadline}</span> : null}
        </div>
      ) : null}
    </Link>
  );
}

export default function GoalMatch({ query }: { query: string }) {
  const matches = useQuery({
    queryKey: ["goal-match", query],
    queryFn: async (): Promise<Match[]> => {
      const res = await fetch(`/api/goals/match?q=${encodeURIComponent(query)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Match service responded ${res.status}.`);
      }
      const body = (await res.json()) as { matches?: Match[] };
      return body.matches ?? [];
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-accent">
          Somebody already put money on this
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          {query === "" ? "Live goals with money behind them" : `"${query}"`}
        </h1>
      </div>

      {matches.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : matches.isError ? (
        <ErrorNote
          title="Could not load pools"
          detail={
            matches.error instanceof Error
              ? matches.error.message
              : "Unknown error."
          }
          onRetry={() => {
            void matches.refetch();
          }}
        />
      ) : matches.data.length === 0 ? (
        <EmptyState
          title="Nothing staked on this one yet."
          detail="No live pool matches your goal. Create the pool and let a sponsor fund it - or browse what is already funded."
          action={
            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/pools/create"
                className="inline-block rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
              >
                Create the pool
              </Link>
              <Link
                href="/pools"
                className="inline-block rounded-xl border border-edge px-6 py-3 text-sm font-semibold text-foreground hover:bg-surface-raised"
              >
                Browse pools
              </Link>
            </div>
          }
        />
      ) : (
        <div className="space-y-3">
          {matches.data.map((match, index) => (
            <MatchCard
              key={match.poolId}
              match={match}
              lead={index === 0 && match.score > 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
