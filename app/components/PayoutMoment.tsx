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

import { useState } from "react";
import { ArcTxLink, Money, Stamp } from "@/components/ui";
import Confetti from "@/components/Confetti";

export default function PayoutMoment({
  paidUsd,
  txHash,
  selfReported = false,
}: {
  paidUsd: string;
  txHash: string | null;
  /** The low-trust tier. When true the moment NEVER claims "verified". */
  selfReported?: boolean;
}) {
  const [open, setOpen] = useState(true);

  // The record left behind after the takeover is dismissed - the event becomes
  // the receipt.
  const record = (
    <div className="rounded-2xl border border-gold/40 bg-gold-deep/15 p-6 text-center">
      <Stamp tone="gold">Paid</Stamp>
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
          {/* the scene: SPOTTER holds up your coin on the riverbank */}
          <div className="relative h-48 overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/spotter/backdrop.png"
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover object-bottom"
            />
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-t from-surface via-surface/10 to-transparent"
            />
            <Confetti />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/spotter/spotter-payday.png"
              alt="SPOTTER the otter holding up a gold coin"
              className="otter-float absolute bottom-0 left-1/2 h-44 w-auto -translate-x-1/2 drop-shadow-xl"
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
