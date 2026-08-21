"use client";

// The claim rail: a five-state stepper over one claim's journey, rendered as a
// sticky right rail on desktop and an expandable bottom sheet on mobile. It is
// a progress indicator, not the workbench - the detailed receipt and the
// action buttons live in the main column. The rail's job is to say, at a
// glance, where this claim is and what happens next.
//
// The money-in-motion visual system is established here: emerald marks trust
// (a completed step, a verified verdict); gold marks money moving (the agent's
// live spend, the landed payout). Only the paid step renders a payout figure,
// and only when a settled entry gave us one - a deferred verdict shows as
// verified-and-settling, never as paid.

import { useState } from "react";
import { ArcTxLink, Money, Stamp } from "@/components/ui";
import SpendMeter from "@/components/SpendMeter";
import {
  CLAIM_STEPS,
  claimStepIndex,
  type ClaimStep,
} from "@/lib/claim-rail";
import { railDeferredCopy } from "@/lib/proof-tier";

/** How a non-paying claim ended, for the verdict step's one-line summary. */
export type VerdictKind = "deferred" | "no-pay" | "stopped";

export interface ClaimRailState {
  step: ClaimStep;
  /** Checking step: the agent's spend so far and the frozen cap. */
  spentUsd: string;
  capUsd: string | null;
  /** Verdict step: how it ended, when it is not a payout. */
  verdict: VerdictKind | null;
  /** Paid step: present only when the ledger recorded a settled payout. */
  paid: { paidUsd: string; txHash: string | null } | null;
  /** The low-trust tier. When true the deferred verdict NEVER reads "Verified":
   *  a self-reported photo cannot be confirmed real, recent, or theirs. */
  selfReported?: boolean;
}

const PRIVACY_LINE =
  "Your health data never left the enclave. SPOTTER only ever saw the verdict.";

function dotClass(status: "done" | "active" | "todo"): string {
  if (status === "done") return "h-3.5 w-3.5 rounded-full bg-accent";
  if (status === "active") {
    return "h-3.5 w-3.5 rounded-full border-2 border-accent bg-accent-deep";
  }
  return "h-3.5 w-3.5 rounded-full border border-edge bg-surface-raised";
}

function VerdictBody({
  verdict,
  selfReported = false,
}: {
  verdict: VerdictKind | null;
  selfReported?: boolean;
}) {
  if (verdict === "deferred") {
    return (
      <div
        className={`rounded-xl border p-3 ${
          selfReported
            ? "border-warning/40 bg-warning/10"
            : "border-accent/40 bg-accent-deep/30"
        }`}
      >
        <p
          className={`text-sm font-semibold ${
            selfReported ? "text-warning" : "text-accent"
          }`}
        >
          {railDeferredCopy(selfReported)}
        </p>
        <p className="mt-1 text-xs text-muted">
          SPOTTER pays out automatically the moment the period closes - no human
          involved.
        </p>
        <p className="mt-2 text-xs text-muted">{PRIVACY_LINE}</p>
      </div>
    );
  }
  if (verdict === "no-pay") {
    return (
      <div className="rounded-xl border border-edge bg-surface-raised p-3">
        <p className="text-sm font-semibold">Not paid.</p>
        <p className="mt-1 text-xs text-muted">
          The evidence did not clear the goal. The receipt has the full reason.
        </p>
        <p className="mt-2 text-xs text-muted">{PRIVACY_LINE}</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/10 p-3">
      <p className="text-sm font-semibold text-warning">Stopped before payout.</p>
      <p className="mt-1 text-xs text-muted">
        The receipt shows exactly where it stopped. Nothing was paid that the
        ledger does not show.
      </p>
      <p className="mt-2 text-xs text-muted">{PRIVACY_LINE}</p>
    </div>
  );
}

function PaidBody({
  paid,
}: {
  paid: { paidUsd: string; txHash: string | null } | null;
}) {
  // Defensive: the paid step should always carry a settled figure, but never
  // fabricate one. Without it, say it is settling rather than show a number.
  if (paid === null) {
    return (
      <p className="text-sm text-muted">
        Settling now. The payout appears here the moment it lands.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-gold/40 bg-gold-deep/30 p-4 text-center">
      <Stamp tone="gold">Paid</Stamp>
      <p className="mt-3">
        <Money usd={paid.paidUsd} tone="gold" sign="+" size="lg" />
      </p>
      <p className="mt-1 text-sm font-semibold text-gold">SPOTTER paid you.</p>
      {paid.txHash !== null ? (
        <p className="mt-3">
          <ArcTxLink txHash={paid.txHash} label="View the payout on Arcscan" />
        </p>
      ) : null}
      <p className="mt-3 text-xs text-muted">{PRIVACY_LINE}</p>
    </div>
  );
}

function StepList({ state }: { state: ClaimRailState }) {
  const activeIndex = claimStepIndex(state.step);
  return (
    <ol>
      {CLAIM_STEPS.map((meta, i) => {
        const status: "done" | "active" | "todo" =
          i < activeIndex ? "done" : i === activeIndex ? "active" : "todo";
        const isLast = i === CLAIM_STEPS.length - 1;
        return (
          <li key={meta.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
            <div className="flex flex-col items-center">
              <span className={`mt-1 ${dotClass(status)}`} aria-hidden />
              {!isLast ? (
                <span
                  aria-hidden
                  className={`w-px flex-1 ${
                    i < activeIndex ? "bg-accent/50" : "bg-edge"
                  }`}
                />
              ) : null}
            </div>
            <div className={isLast ? "pb-1" : "pb-5"}>
              <p
                className={`text-sm font-semibold ${
                  status === "active"
                    ? "text-foreground"
                    : status === "done"
                      ? "text-accent"
                      : "text-muted"
                }`}
              >
                {meta.label}
              </p>
              {status === "active" ? (
                <div className="mt-2 space-y-3">
                  <p className="text-sm text-muted">{meta.blurb}</p>
                  {meta.id === "checking" ? (
                    <SpendMeter spentUsd={state.spentUsd} capUsd={state.capUsd} />
                  ) : null}
                  {meta.id === "verdict" ? (
                    <VerdictBody
                      verdict={state.verdict}
                      selfReported={state.selfReported}
                    />
                  ) : null}
                  {meta.id === "paid" ? <PaidBody paid={state.paid} /> : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default function ClaimRail({ state }: { state: ClaimRailState }) {
  // The bottom sheet defaults open on the payout step, so the moment is never
  // hidden behind a collapsed bar - including when a live run flips to paid,
  // since the default follows the step. A tap pins the visitor's own choice
  // (override) from then on. Derived rather than an effect: no setState in a
  // render-driven effect, no cascading render.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? state.step === "paid";

  const active = CLAIM_STEPS[claimStepIndex(state.step)];

  return (
    <>
      {/* Desktop: sticky right rail. */}
      <aside className="hidden lg:block">
        <div className="sticky top-24 rounded-2xl border border-edge bg-surface p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted">
            Claim rail
          </p>
          <div className="mt-4">
            <StepList state={state} />
          </div>
        </div>
      </aside>

      {/* Mobile: sticky, expandable bottom sheet. */}
      <div className="fixed inset-x-0 bottom-0 z-40 lg:hidden">
        <div className="mx-auto max-w-2xl border-t border-edge bg-surface/95 px-4 shadow-[0_-8px_24px_rgba(0,0,0,0.45)] backdrop-blur">
          <button
            type="button"
            onClick={() => setOverride(!open)}
            aria-expanded={open}
            className="flex min-h-14 w-full items-center justify-between gap-3"
          >
            <span className="flex items-baseline gap-2 text-left">
              <span className="text-xs font-semibold uppercase tracking-widest text-muted">
                Claim rail
              </span>
              <span className="text-sm font-semibold text-foreground">
                {active.label}
              </span>
            </span>
            <span className="text-sm font-medium text-muted">
              {open ? "Hide" : "Show"}
            </span>
          </button>
          {open ? (
            <div
              className="animate-rise-in max-h-[60vh] overflow-y-auto pb-[calc(1rem+env(safe-area-inset-bottom))]"
            >
              <StepList state={state} />
            </div>
          ) : (
            <div className="h-[env(safe-area-inset-bottom)]" />
          )}
        </div>
      </div>
    </>
  );
}
