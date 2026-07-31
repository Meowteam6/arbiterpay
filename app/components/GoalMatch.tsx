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

function MatchCard({ match, lead }: { match: Match; lead: boolean }) {
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
      <p className="mt-2 text-sm text-muted">
        <Money usd={formatUsdc(BigInt(match.balance))} size="sm" /> staked by a
        sponsor. Not you.
      </p>
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
