// Privacy-safe aggregate outcome metrics for the sponsor console.
//
// A sponsor funds a pool and, understandably, wants to know what their USDC
// bought: how many people joined, how many hit the goal, how much was paid,
// and what a verified completion cost them. Every one of those OUTCOME numbers
// is derived from participants' health results, so this module enforces a
// k-anonymity floor before any of them may be displayed.
//
// The rule (K_ANONYMITY_FLOOR): never surface a metric derived from fewer than
// five participants. It is applied in two independent gates because the two
// families of outcome metric are derived from two different cohorts:
//
//   - Cohort gate  (joined >= K):      unlocks the exact joined count and the
//                                      completion RATE (denominator = joined).
//   - Achiever gate (completions >= K): unlocks the exact completion count, the
//                                      total paid to achievers, and the
//                                      cost-per-completion (all derived from the
//                                      achiever subset).
//
// Sponsor CAPITAL figures (the bounty balance now, and the sponsor's own
// top-ups) are the sponsor's own money movements, not participant-derived, so
// they are never gated. No per-participant value (address, streak, verdict,
// health metric) is ever an input here or an output.
//
// KNOWN REFINEMENT, deliberately not shipped: a completion rate over a cohort
// of >= K can still let an observer back out a numerator that is itself below
// the floor (rate x joined). Complementary suppression / rate banding is the
// standard fix and is a candidate refinement, tracked separately.
//
// LEGAL-GATED FRAMING, deliberately excluded from this module and from all
// shipped UI copy: none of these figures may be presented as an insurer /
// UnitedHealth "pays for behavior -> fewer claims" ROI, nor with any HIPAA /
// covered-entity claim. That framing changes the regulatory posture of the
// product and needs legal review before it appears anywhere a user can read it.
// This module reports counts and USDC only, with no such interpretation.
//
// Pure and chain-free by construction (bigint + number in, gated view out), so
// it runs under vitest's node environment with no RPC.

export const K_ANONYMITY_FLOOR = 5;

/** Raw per-pool aggregate, computed upstream from on-chain events + state. */
export interface PoolAggregate {
  /** Current bounty available in the pool (USDC base units). Sponsor capital. */
  balanceUsdc: bigint;
  /** Sum of the sponsor's own fundPool top-ups (USDC base units). */
  toppedUpUsdc: bigint;
  /** Participants who joined (one wallet, one entry). */
  joined: number;
  /** Participants whose goal was verified (passing verdict). */
  completions: number;
  /** Total paid to achievers on settlement (USDC base units). Money that moved. */
  paidUsdc: bigint;
}

/**
 * The display-safe projection of a pool aggregate. A null field is one the
 * floor withholds; a component MUST NOT reconstruct it. bigint capital fields
 * are always present because they are sponsor money, not participant data.
 */
export interface PoolOutcomeDisplay {
  balanceUsdc: bigint;
  toppedUpUsdc: bigint;
  /** True when joined < K: the whole outcome block is withheld. */
  belowFloor: boolean;
  /** Exact joined count, only once the cohort clears the floor. */
  joined: number | null;
  /** Whole-percent completion rate, only once the cohort clears the floor. */
  completionRatePct: number | null;
  /** Exact completion count, only once the achiever subset clears the floor. */
  completions: number | null;
  /** Total paid to achievers, only once the achiever subset clears the floor. */
  paidUsdc: bigint | null;
  /** Paid / completions, only once the achiever subset clears the floor. */
  costPerCompletionUsdc: bigint | null;
}

/** True when a count is large enough to display a metric derived from it. */
export function clearsFloor(count: number): boolean {
  return count >= K_ANONYMITY_FLOOR;
}

/**
 * Integer division of a USDC total by a positive count, rounded to nearest
 * base unit. Used for cost-per-completion so the console never renders a value
 * the ledger cannot back to the cent.
 */
export function perUnitUsdc(totalUsdc: bigint, count: number): bigint {
  if (count <= 0) {
    throw new Error("perUnitUsdc requires a positive count.");
  }
  const n = BigInt(count);
  const half = n / 2n;
  return (totalUsdc + half) / n;
}

/** Apply both k-anonymity gates to a single pool's aggregate. */
export function poolOutcomeDisplay(a: PoolAggregate): PoolOutcomeDisplay {
  const cohortOk = clearsFloor(a.joined);
  const achieversOk = clearsFloor(a.completions);

  const completionRatePct =
    cohortOk && a.joined > 0
      ? Math.round((a.completions / a.joined) * 100)
      : null;

  return {
    balanceUsdc: a.balanceUsdc,
    toppedUpUsdc: a.toppedUpUsdc,
    belowFloor: !cohortOk,
    joined: cohortOk ? a.joined : null,
    completionRatePct,
    completions: achieversOk ? a.completions : null,
    paidUsdc: achieversOk ? a.paidUsdc : null,
    costPerCompletionUsdc:
      achieversOk && a.completions > 0
        ? perUnitUsdc(a.paidUsdc, a.completions)
        : null,
  };
}

/** Portfolio total across a sponsor's pools, before the display gate. */
export interface PortfolioAggregate {
  poolCount: number;
  totalBalanceUsdc: bigint;
  totalToppedUpUsdc: bigint;
  totalJoined: number;
  totalCompletions: number;
  totalPaidUsdc: bigint;
}

/** The display-safe portfolio projection. Null fields are withheld by the floor. */
export interface PortfolioDisplay {
  poolCount: number;
  totalBalanceUsdc: bigint;
  totalToppedUpUsdc: bigint;
  totalJoined: number | null;
  totalCompletions: number | null;
  totalPaidUsdc: bigint | null;
}

/**
 * Sum a sponsor's pools into one portfolio aggregate. Aggregating across pools
 * only ever RAISES the participant counts, so the floor applied to the sum is
 * at least as safe as the per-pool floor already is.
 */
export function portfolioAggregate(pools: PoolAggregate[]): PortfolioAggregate {
  return pools.reduce<PortfolioAggregate>(
    (acc, p) => ({
      poolCount: acc.poolCount + 1,
      totalBalanceUsdc: acc.totalBalanceUsdc + p.balanceUsdc,
      totalToppedUpUsdc: acc.totalToppedUpUsdc + p.toppedUpUsdc,
      totalJoined: acc.totalJoined + p.joined,
      totalCompletions: acc.totalCompletions + p.completions,
      totalPaidUsdc: acc.totalPaidUsdc + p.paidUsdc,
    }),
    {
      poolCount: 0,
      totalBalanceUsdc: 0n,
      totalToppedUpUsdc: 0n,
      totalJoined: 0,
      totalCompletions: 0,
      totalPaidUsdc: 0n,
    },
  );
}

/** Apply the k-anonymity gates to a portfolio aggregate. */
export function portfolioDisplay(agg: PortfolioAggregate): PortfolioDisplay {
  const cohortOk = clearsFloor(agg.totalJoined);
  const achieversOk = clearsFloor(agg.totalCompletions);
  return {
    poolCount: agg.poolCount,
    totalBalanceUsdc: agg.totalBalanceUsdc,
    totalToppedUpUsdc: agg.totalToppedUpUsdc,
    totalJoined: cohortOk ? agg.totalJoined : null,
    totalCompletions: achieversOk ? agg.totalCompletions : null,
    totalPaidUsdc: achieversOk ? agg.totalPaidUsdc : null,
  };
}
