"use client";

// THE DROP — the payout moment, the emotional peak of the whole product.
// SPOTTER pays you and holds up the coin; the world leans in. Fires only on a
// real settled payout: paidUsd comes from the ledger's settle entry (the
// AchieverPaid delta), never from a transaction merely succeeding.
//
// Honest-core: the amount is the gold mono Money, still, no count-up. Two paid
// branches share the exact same celebration because money moved in both - only
// the TRUST ribbon differs. A self-reported payout is celebrated just as hard
// but NEVER reads as "verified": amber ribbon, no check/shield, no enclave
// claim. Dismissing the takeover reveals the compact receipt left behind.

import { useEffect, useState } from "react";
import { ArcTxLink, Money, Stamp } from "@/components/ui";
import Confetti from "@/components/Confetti";

export default function PayoutMoment({
  paidUsd,
  txHash,
  selfReported = false,
  initialOpen = true,
}: {
  paidUsd: string;
  txHash: string | null;
  /** The low-trust tier. When true the moment NEVER claims "verified". */
  selfReported?: boolean;
  /** Dev/preview only: start with the takeover already dismissed. */
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  // Respect reduced-motion: only the celebration VIDEO carries motion, so it
  // falls back to the static riverbank scene. Starts static (SSR-safe) and
  // upgrades to video on mount when motion is allowed.
  const [motionOK, setMotionOK] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotionOK(!mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const tierChip = selfReported ? (
    <span className="inline-flex items-center rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
      Self-reported
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/12 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-strong">
      Verified
    </span>
  );

  // The record left behind after the takeover is dismissed - the event becomes
  // a warm little receipt, SPOTTER still holding your coin. Not a flat gold box.
  const record = (
    <div className="flex items-center gap-4 rounded-2xl border border-edge bg-surface p-5 shadow-sm sm:gap-5 sm:p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/spotter/spotter-payday.png"
        alt="SPOTTER the otter with your coin"
        className="h-20 w-auto shrink-0 sm:h-24"
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Stamp tone="gold">Paid</Stamp>
          {tierChip}
        </div>
        <p className="mt-2">
          <Money usd={paidUsd} tone="gold" sign="+" size="xl" />
        </p>
        <p className="mt-1 text-sm font-semibold text-foreground">
          SPOTTER paid you.
        </p>
        <p className="text-sm text-muted">Absolute unit. Run it back.</p>
        {txHash !== null ? (
          <p className="mt-2">
            <ArcTxLink txHash={txHash} label="View on Arcscan" />
          </p>
        ) : null}
      </div>
    </div>
  );

  if (!open) return record;

  return (
    <>
      {record}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="SPOTTER paid you"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setOpen(false)}
          className="absolute inset-0 cursor-default bg-foreground/40 backdrop-blur-sm"
        />
        <div className="animate-payout-pop relative z-10 w-full max-w-md overflow-hidden rounded-3xl border border-edge bg-surface shadow-2xl">
          {/* the scene: SPOTTER holds up your coin on the riverbank. Motion on =
              the celebration video; reduced-motion = the still + confetti. */}
          <div className="relative aspect-video overflow-hidden bg-surface-raised">
            {motionOK ? (
              <video
                className="absolute inset-0 h-full w-full object-cover"
                src="/spotter/spotter-thedrop.mp4"
                poster="/spotter/spotter-payday.png"
                autoPlay
                muted
                loop
                playsInline
                aria-hidden="true"
              />
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/spotter/backdrop.png"
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 h-full w-full object-cover object-bottom"
                />
                <Confetti />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/spotter/spotter-payday.png"
                  alt="SPOTTER the otter holding up a gold coin"
                  className="otter-float absolute bottom-0 left-1/2 h-40 w-auto -translate-x-1/2 drop-shadow-xl"
                />
              </>
            )}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent"
            />
          </div>

          <div className="px-6 pb-6 pt-3 text-center">
            <div className="flex justify-center">
              {selfReported ? (
                <span className="inline-flex items-center rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-warning">
                  Self-reported · we took your word for it
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/12 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-accent-strong">
                  Verified in the enclave · nobody saw a thing
                </span>
              )}
            </div>
            <p className="mt-4">
              <Money usd={paidUsd} tone="gold" sign="+" size="xl" />
            </p>
            <p className="mt-2 text-base font-semibold text-foreground">
              SPOTTER paid you.
            </p>
            <p className="mt-1 text-sm text-muted">Absolute unit. Run it back.</p>
            {txHash !== null ? (
              <p className="mt-4">
                <ArcTxLink txHash={txHash} label="View the payout on Arcscan" />
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-accent-strong px-6 py-2 text-sm font-semibold text-background hover:bg-accent"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
