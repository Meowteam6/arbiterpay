"use client";

// The product promise, kept, visibly. The amount comes exclusively from the
// ledger's settle entry, which is derived from the AchieverPaid event of a
// real settlement transaction - never from a transaction merely succeeding.
// No count-up animation on purpose: the takeover is the event; the number is
// real and stays still.

import { ArcTxLink, Money, Stamp } from "@/components/ui";

export default function PayoutMoment({
  paidUsd,
  txHash,
}: {
  paidUsd: string;
  txHash: string | null;
}) {
  return (
    <div className="rounded-2xl border border-gold/40 bg-gold-deep/30 p-6 text-center">
      <Stamp tone="gold">Paid</Stamp>
      <p className="mt-4">
        <Money usd={paidUsd} tone="gold" sign="+" size="xl" />
      </p>
      <p className="mt-2 text-base font-semibold text-gold">
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
}
