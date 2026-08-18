"use client";

// One card in the sponsor console: a pool the sponsor funds, its capital, and
// its privacy-safe outcomes. Two rules shape everything on it:
//
//   1. k-anonymity floor (lib/sponsor-metrics): no outcome derived from fewer
//      than five participants is rendered. A withheld figure shows a designed
//      "held back" state, never a zero that reads as "nobody did it".
//   2. No participant identity, ever: this card renders the pool's own health
//      label (initiative + goal) but NEVER a participant wallet or handle beside
//      it, and never a per-participant metric. The only addresses in the source
//      data were counted and discarded upstream.
//
// LEGAL-GATED, intentionally absent from the copy below: no insurer /
// UnitedHealth "pays for behavior -> fewer claims" ROI reading, and no HIPAA /
// covered-entity language. Those reframes change the product's regulatory
// posture and are held for legal review, not shipped in console copy.

import { useState } from "react";
import Countdown from "@/components/Countdown";
import FundPool from "@/components/FundPool";
import { Badge, Money, Stat, TAP_TARGET } from "@/components/ui";
import {
  displayGoalSpec,
  evidenceTypeOf,
  formatUsdc,
  type PoolInfo,
} from "@/lib/contract";
import { poolPhase } from "@/lib/pool-lifecycle";
import {
  poolOutcomeDisplay,
  type PoolAggregate,
} from "@/lib/sponsor-metrics";

// The verdict-privacy line. Completion rate is a verdict-derived figure, so any
// card that can show outcomes carries this, matching every other verdict
// surface in the app.
const PRIVACY_LINE =
  "SPOTTER verifies in a confidential enclave. Only the pass or fail verdict ever leaves it, never your health data.";

function OutcomeStat({
  label,
  usd,
  paid = false,
}: {
  label: string;
  usd: string;
  paid?: boolean;
}) {
  // Every dollar figure renders through Money: monospace, no adjective. `paid`
  // marks the money-in-motion figure (achiever payouts). The design system
  // reserves a warm accent for money in motion; until the shared --color-gold
  // token from the social work merges into globals.css, it renders through the
  // same honest Money primitive as the rest and is only set apart by its label.
  return (
    <Stat label={label} value={<Money usd={usd} sign={paid ? "+" : undefined} />} />
  );
}

export default function SponsorPoolOutcome({
  pool,
  aggregate,
  nowSeconds,
}: {
  pool: PoolInfo;
  aggregate: PoolAggregate;
  nowSeconds: bigint;
}) {
  const [showTopUp, setShowTopUp] = useState(false);
  const d = poolOutcomeDisplay(aggregate);
  const phase = poolPhase(pool, nowSeconds);
  const isDocGoal = evidenceTypeOf(pool.goalSpec) === "document";

  return (
    <article className="space-y-4 rounded-2xl border border-edge bg-surface p-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{pool.initiative}</Badge>
            <Badge tone={isDocGoal ? "accent" : "muted"}>
              {isDocGoal ? "Document" : "Wearable"}
            </Badge>
          </div>
          {phase === "settled" ? (
            <Badge tone="muted">Settled</Badge>
          ) : phase === "expired" ? (
            <Badge tone="warning">Awaiting settlement</Badge>
          ) : (
            <Badge tone="accent">Live</Badge>
          )}
        </div>
        {/* Health label with no wallet or handle beside it, by rule. */}
        <h3 className="text-lg font-semibold leading-snug">
          {displayGoalSpec(pool.goalSpec)}
        </h3>
        <p className="text-sm font-medium">
          <Countdown periodStart={pool.periodStart} periodEnd={pool.periodEnd} />
        </p>
      </header>

      {/* Sponsor capital: always shown, never gated. This is the sponsor's own
          money movement, not a participant-derived figure. */}
      <div className="grid grid-cols-2 gap-3">
        <OutcomeStat label="In the pool now" usd={formatUsdc(d.balanceUsdc)} />
        <OutcomeStat label="You funded" usd={formatUsdc(d.toppedUpUsdc)} />
      </div>

      {/* Outcomes: gated by the k-anonymity floor. */}
      {d.belowFloor ? (
        <div className="rounded-xl border border-dashed border-edge bg-surface-raised p-4">
          <p className="text-sm font-semibold">Outcomes are hidden here</p>
          <p className="mt-1 text-sm text-muted">
            This pool has fewer than five participants, so no completion or
            payout figure is shown. Outcomes appear once at least five people
            have joined. No participant is ever named.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Joined" value={d.joined ?? 0} />
            <Stat
              label="Completion rate"
              value={
                d.completionRatePct !== null ? `${d.completionRatePct}%` : "—"
              }
            />
          </div>

          {d.completions !== null && d.paidUsdc !== null ? (
            <div className="grid grid-cols-2 gap-3">
              <OutcomeStat
                label="Paid to achievers"
                usd={formatUsdc(d.paidUsdc)}
                paid
              />
              {d.costPerCompletionUsdc !== null ? (
                <OutcomeStat
                  label="Cost per completion"
                  usd={formatUsdc(d.costPerCompletionUsdc)}
                />
              ) : (
                <Stat label="Cost per completion" value="—" />
              )}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-edge bg-surface-raised p-3 text-sm text-muted">
              Payout figures unlock once five participants have been verified.
              Fewer than that and the amount could point at one person, so it
              stays held.
            </p>
          )}

          <p className="text-xs leading-relaxed text-muted">{PRIVACY_LINE}</p>
        </div>
      )}

      {/* Top up: the existing FundPool machinery, reused unchanged. Only offered
          while the pool can still take funds — the contract reverts fundPool on
          a settled pool. */}
      {phase !== "settled" ? (
        <div className="border-t border-edge pt-4">
          {showTopUp ? (
            <FundPool poolId={pool.id} />
          ) : (
            <button
              type="button"
              onClick={() => setShowTopUp(true)}
              className={`w-full rounded-xl border border-accent/50 font-semibold text-accent hover:bg-accent-deep ${TAP_TARGET}`}
            >
              Top up this pool
            </button>
          )}
        </div>
      ) : null}
    </article>
  );
}
