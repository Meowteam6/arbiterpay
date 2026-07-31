// Pool lifecycle classification and display ordering, extracted so the pool
// list, the pool page, and the goal-match ranking all agree on what "live"
// means. The predicate deliberately mirrors /api/goals/match (a pool is live
// only while !settled && periodEnd > now) - if the two ever drift, an expired
// pool can look joinable and hand the user a raw PERIOD_ENDED revert. Pure
// and chain-free so it runs under vitest's node environment.

export type PoolPhase = "live" | "expired" | "settled";

/** The minimal pool shape lifecycle decisions depend on. */
export interface LifecycleFields {
  settled: boolean;
  periodEnd: bigint;
}

/**
 * Classify a pool at a moment in time (unix seconds). "expired" means the
 * period has ended but settlement has not run yet - joining and backing
 * revert on-chain, while evidence and receipts remain meaningful.
 */
export function poolPhase(
  pool: LifecycleFields,
  nowSeconds: bigint,
): PoolPhase {
  if (pool.settled) return "settled";
  return pool.periodEnd > nowSeconds ? "live" : "expired";
}

export interface GroupedPools<T> {
  live: T[];
  expired: T[];
  settled: T[];
}

function byPeriodEndAsc(a: LifecycleFields, b: LifecycleFields): number {
  return a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0;
}

/**
 * Group pools for display: live first (soonest-ending first, so urgency
 * leads), then expired awaiting settlement (most recently ended first),
 * then settled (most recently ended first). Ties keep the input order,
 * which callers provide sorted by pool id.
 */
export function groupPoolsByPhase<T extends LifecycleFields>(
  pools: T[],
  nowSeconds: bigint,
): GroupedPools<T> {
  const live: T[] = [];
  const expired: T[] = [];
  const settled: T[] = [];
  for (const pool of pools) {
    const phase = poolPhase(pool, nowSeconds);
    if (phase === "live") live.push(pool);
    else if (phase === "expired") expired.push(pool);
    else settled.push(pool);
  }
  live.sort(byPeriodEndAsc);
  expired.sort((a, b) => byPeriodEndAsc(b, a));
  settled.sort((a, b) => byPeriodEndAsc(b, a));
  return { live, expired, settled };
}
