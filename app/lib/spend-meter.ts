// The SpendMeter's arithmetic, kept pure so the bar can be reasoned about and
// tested without a DOM. Everything runs in whole-cent integers parsed from the
// two-decimal USD strings the receipt already produced, so the ratio never
// drifts on floating point and never overstates spend.

export interface SpendMeterModel {
  /** 0..1, spent over cap, clamped. 0 while there is no cap yet. */
  ratio: number;
  /** Spend has reached or passed the cap - the guardrail bit. */
  atCap: boolean;
  /** No plan/cap on the ledger yet: the meter is indeterminate. */
  planning: boolean;
}

function cents(usd: string): number {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(usd.trim());
  if (match === null) return 0;
  return (
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0").slice(0, 2))
  );
}

/**
 * Fold a spent and cap figure into what the meter renders. A null cap means the
 * plan has not landed yet (indeterminate). A zero cap is treated as fully spent
 * the moment any money moves, so a misconfigured cap never reads as headroom.
 */
export function spendMeterModel(
  spentUsd: string,
  capUsd: string | null,
): SpendMeterModel {
  if (capUsd === null) {
    return { ratio: 0, atCap: false, planning: true };
  }
  const cap = cents(capUsd);
  const spent = cents(spentUsd);
  if (cap <= 0) {
    return { ratio: spent > 0 ? 1 : 0, atCap: spent > 0, planning: false };
  }
  return { ratio: Math.min(spent / cap, 1), atCap: spent >= cap, planning: false };
}
