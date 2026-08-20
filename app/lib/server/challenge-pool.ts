// Whether an on-chain pool is a private peer challenge, cached per pool id.
//
// The public Payout Feed must never surface a challenge pool's payout: a
// challenge is a person-to-person dare on a health-adjacent goal, listed
// nowhere and reachable only by its unguessable link. The reliable, immutable
// signal is the pool's on-chain `initiative` field ("challenge"), set once at
// createPool and never mutated - NOT the Supabase challenges row, which can be
// absent if the row write failed after the pool funded.
//
// The initiative never changes, so a resolved answer is cached for the life of
// the process and no pool is read twice. A read failure resolves to `true`
// (treat as a challenge and withhold) and is deliberately NOT cached, so a
// transient RPC error hides a public payout only until the next request rather
// than for the whole process: privacy-first, exclude-on-uncertainty. A public
// payout wrongly withheld is invisible; a private one wrongly shown is a leak.

import { fetchPool } from "@/lib/contract";

const cache = new Map<string, boolean>();

/** True when the pool's initiative is "challenge", or when it cannot be read. */
export async function isChallengePool(poolId: string): Promise<boolean> {
  const cached = cache.get(poolId);
  if (cached !== undefined) return cached;
  try {
    const pool = await fetchPool(BigInt(poolId));
    const isChallenge = pool.initiative === "challenge";
    cache.set(poolId, isChallenge);
    return isChallenge;
  } catch {
    return true;
  }
}
