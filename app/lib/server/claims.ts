// Claim + identity store for the private payout path.
//
// A claim flag is the only thing standing between one reward and two payouts,
// so it is stored as a SET NX key per goal rather than a flag inside a shared
// map. The old shape was `if (await isClaimed(id)) return; await markClaimed(id)`
// over one global blob: two requests that arrive together both read "not
// claimed", both write, and unlink-payout.ts pays real USDC twice.
//
// tryMarkClaimed is the race-free primitive - exactly one caller gets true.
// isClaimed/markClaimed are kept because unlink-payout.ts calls them, but
// markClaimed is now a lock acquisition, not a set: it throws
// ClaimAlreadyHeldError when it loses the race, so the loser of a true tie
// stops instead of paying. Prefer tryMarkClaimed in new code.
//
// Claims recorded before this change live in the claims.json blob. Every read
// path consults it, because treating an already-paid goal as unclaimed is the
// double-pay this file exists to prevent.

import {
  deleteKey,
  existsKey,
  readJson,
  setNx,
  writeJson,
} from "@/lib/server/store";

const LEGACY_CLAIMS_FILE = "claims.json";
const LEGACY_ADDR_FILE = "unlink-addresses.json";

type ClaimMap = Record<string, true>;
type AddrMap = Record<string, string>; // userId -> unlink1...

export class ClaimAlreadyHeldError extends Error {}

function claimKey(goalId: string): string {
  // Case-fold: "0xAB" and "0xab" are the same goal, and treating them as two
  // claims would pay the same reward twice.
  return `claim:${goalId.toLowerCase()}`;
}

/** Was this goal claimed before the per-goal keys existed? */
async function legacyClaimed(goalId: string): Promise<boolean> {
  const map = await readJson<ClaimMap>(LEGACY_CLAIMS_FILE, {});
  return map[goalId] === true || map[goalId.toLowerCase()] === true;
}

/**
 * Claim a goal atomically. Returns true for the single caller that took it and
 * false for everyone else, including goals claimed before this store changed.
 */
export async function tryMarkClaimed(goalId: string): Promise<boolean> {
  if (await legacyClaimed(goalId)) return false;
  return setNx(claimKey(goalId), new Date().toISOString());
}

export async function isClaimed(goalId: string): Promise<boolean> {
  if (await existsKey(claimKey(goalId))) return true;
  return legacyClaimed(goalId);
}

/**
 * Take the claim, or throw if somebody else already holds it. Callers that
 * want a boolean should use tryMarkClaimed; this exists so an existing
 * check-then-mark caller cannot silently double-pay when the check and the
 * mark straddle a concurrent request.
 */
export async function markClaimed(goalId: string): Promise<void> {
  if (await tryMarkClaimed(goalId)) return;
  throw new ClaimAlreadyHeldError(
    `goal ${goalId} was already claimed by another request`,
  );
}

/**
 * Release a claim. Used to roll back the optimistic lock when a payout fails
 * AFTER it was marked claimed but BEFORE funds actually moved — otherwise a
 * transient failure would lock the reward forever.
 */
export async function unmarkClaimed(goalId: string): Promise<void> {
  await deleteKey(claimKey(goalId));

  // Legacy blob path: only reachable for goals claimed before the per-goal
  // keys existed, which are all completed payouts, so the read-modify-write
  // here has nothing to race with.
  const map = await readJson<ClaimMap>(LEGACY_CLAIMS_FILE, {});
  if (map[goalId] === undefined && map[goalId.toLowerCase()] === undefined) {
    return;
  }
  delete map[goalId];
  delete map[goalId.toLowerCase()];
  await writeJson(LEGACY_CLAIMS_FILE, map);
}

// One key per user instead of one shared map, so two users linking an address
// at the same time cannot drop each other's write.
function addressKey(userId: string): string {
  return `unlink-address-${userId.toLowerCase()}.json`;
}

export async function linkUnlinkAddress(
  userId: string,
  unlinkAddress: string,
): Promise<void> {
  await writeJson(addressKey(userId), unlinkAddress);
}

export async function getUnlinkAddress(
  userId: string,
): Promise<string | null> {
  const linked = await readJson<string | null>(addressKey(userId), null);
  if (linked !== null) return linked;

  // Mappings written before the per-user keys existed, keyed by whatever
  // casing the caller sent at the time.
  const map = await readJson<AddrMap>(LEGACY_ADDR_FILE, {});
  return map[userId] ?? map[userId.toLowerCase()] ?? null;
}

export async function userOwnsUnlinkAddress(
  userId: string,
  unlinkAddress: string,
): Promise<boolean> {
  return (await getUnlinkAddress(userId)) === unlinkAddress;
}
