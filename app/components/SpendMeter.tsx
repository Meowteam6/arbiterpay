"use client";

// SPOTTER's live spend against the hard per-claim cap. Spend is money in
// motion, so the filled portion is gold; the cap is a limit, not money that
// moved, so it reads neutral. The bar is decoration - the two Money figures
// below carry the same facts for anyone who cannot see colour or the bar.

import { Money } from "@/components/ui";
import { spendMeterModel } from "@/lib/spend-meter";

export default function SpendMeter({
  spentUsd,
  capUsd,
}: {
  spentUsd: string;
  capUsd: string | null;
}) {
  const { ratio, atCap, planning } = spendMeterModel(spentUsd, capUsd);
  const pct = Math.round(ratio * 100);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          SPOTTER spend
        </p>
        {atCap ? (
          <span className="text-xs font-semibold uppercase tracking-wide text-warning">
            at cap
          </span>
        ) : null}
      </div>

      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-raised"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={planning ? undefined : pct}
        aria-label="SPOTTER spend against the per-claim cap"
      >
        <div
          className={`h-full rounded-full ${
            planning
              ? "w-1/3 animate-pulse bg-gold/40"
              : atCap
                ? "bg-warning transition-[width] duration-500"
                : "bg-gold transition-[width] duration-500"
          }`}
          style={planning ? undefined : { width: `${pct}%` }}
        />
      </div>

      <p className="mt-2 text-sm">
        {planning ? (
          <span className="text-muted">
            SPOTTER is pricing the buys it needs.
          </span>
        ) : (
          <>
            <Money usd={spentUsd} tone="gold" size="sm" />
            <span className="text-muted"> of a </span>
            {capUsd !== null ? <Money usd={capUsd} size="sm" /> : null}
            <span className="text-muted"> cap on this claim</span>
          </>
        )}
      </p>
    </div>
  );
}
