// Two questions the pool list has to answer before it invites anyone to spend
// an entry fee, kept out of the page so they can be tested in node.
//
// 1. An expired pool nobody joined is not "awaiting settlement". settle() has
//    no participant to pay, so nothing will ever happen to it - it would sit
//    under that heading forever, telling the visitor a payout is coming that
//    never is. Six such pools exist on the live contract.
//
// 2. A wearable goal cannot be verified while the wearable provider is
//    refusing us, so its pool must not read as joinable during an outage. The
//    entry fee is real money, paid up front, for a goal SPOTTER has no way to
//    check.
//
// Both take their inputs from live sources (participant counts read off the
// chain, provider health read off the junction route); nothing here is
// hard-coded to a pool id.

import { evidenceTypeOf } from "@/lib/contract";

export interface ExpiredSplit<T> {
  /** Ended with participants on record - settlement still has work to do. */
  awaitingSettlement: T[];
  /** Ended with nobody joined - settlement can never pay anyone here. */
  closedEmpty: T[];
}

/**
 * Split expired pools by whether settlement has anyone to pay.
 *
 * `participantCountOf` returns null when the count is not known yet (the read
 * is still in flight, or it failed). Unknown stays in awaitingSettlement on
 * purpose: announcing that nobody joined a pool we have not counted would be a
 * claim the page cannot back.
 */
export function splitExpiredPools<T>(
  expired: T[],
  participantCountOf: (pool: T) => number | null,
): ExpiredSplit<T> {
  const awaitingSettlement: T[] = [];
  const closedEmpty: T[] = [];
  for (const pool of expired) {
    if (participantCountOf(pool) === 0) closedEmpty.push(pool);
    else awaitingSettlement.push(pool);
  }
  return { awaitingSettlement, closedEmpty };
}

export interface VerifiabilitySplit<T> {
  verifiable: T[];
  /** Goals SPOTTER currently has no way to check. Do not invite entry fees. */
  unverifiable: T[];
}

/**
 * Split pools by whether their goal can be verified right now. Only wearable
 * goals depend on the outside provider; document goals run through the TEE
 * attester and are unaffected. When the provider is up - or its state is not
 * known yet - nothing is held back.
 */
export function splitByVerifiability<T extends { goalSpec: string }>(
  pools: T[],
  providerDown: boolean,
): VerifiabilitySplit<T> {
  if (!providerDown) return { verifiable: [...pools], unverifiable: [] };
  const verifiable: T[] = [];
  const unverifiable: T[] = [];
  for (const pool of pools) {
    if (evidenceTypeOf(pool.goalSpec) === "wearable") unverifiable.push(pool);
    else verifiable.push(pool);
  }
  return { verifiable, unverifiable };
}
