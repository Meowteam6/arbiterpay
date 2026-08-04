// Who is allowed to read a claim's full ledger, and what everyone else gets.
//
// WHY: the ledger carries model-authored prose about somebody's medical
// document - the verdict reason, the decision note, the goal text itself - and
// /api/agent/feed publishes the goal ids needed to ask for it. Redacting the
// read closed the leak but took the claim's owner down with it: the person who
// uploaded the record, paid gas and came back an hour later could no longer
// see their own receipt.
//
// A goalId is NOT the credential. It is public in the feed, and the
// participant list is public on chain, so possession proves nothing. Ownership
// is proven by an EIP-191 signature (lib/server/wallet-auth.ts) whose signer
// matches the claim's participant - the address the run loop froze into the
// plan entry before it spent a cent.
//
// The projection selection is a pure function so both verbs share exactly one
// rule and it is unit-testable: an owner sees the ledger verbatim, everyone
// else sees the same redacted view the public feed serves.

import { getAddress, isAddress } from "viem";
import type { LedgerEntry } from "@/lib/server/agent/ledger";
import {
  toPublicFeedClaim,
  type PublicFeedClaim,
} from "@/lib/server/agent/feed-view";

/**
 * The wallet a claim belongs to, read from the plan entry's on-chain linkage
 * (run.ts writes `participant` when it emits the plan, before any spend).
 * Null for a ledger with no plan entry, or one written before that field
 * existed - which fails CLOSED: no derivable owner means no full ledger.
 */
export function claimParticipantOf(ledger: LedgerEntry[]): string | null {
  for (const entry of ledger) {
    if (entry.kind !== "plan") continue;
    const participant = entry.participant;
    if (typeof participant === "string" && isAddress(participant)) {
      return getAddress(participant);
    }
  }
  return null;
}

/**
 * Whether a proven signer is this claim's participant. `viewer` must already
 * be a VERIFIED address (the output of wallet-auth), never a value taken from
 * a body or query string - those name an address, they do not prove one.
 */
export function isClaimOwner(
  ledger: LedgerEntry[],
  viewer: string | null,
): boolean {
  if (viewer === null || !isAddress(viewer)) return false;
  const participant = claimParticipantOf(ledger);
  if (participant === null) return false;
  return participant === getAddress(viewer);
}

/**
 * Why the caller got what they got. The browser cannot tell an expired
 * signature from the wrong wallet on its own - both look like "no ledger" -
 * and guessing produces the worst possible message: telling somebody their own
 * claim belongs to a stranger. So the server says which it was.
 *
 *   owner     - proven participant; the ledger is enclosed.
 *   not-owner - a valid signature that is definitively NOT the participant.
 *   unproven  - no usable signature, or ownership could not be established
 *               (nothing recorded to compare against, or the chain read for
 *               the fallback failed). Signing again is the honest advice.
 */
export type ClaimAccess = "owner" | "not-owner" | "unproven";

export interface ClaimReadResponse {
  /** Money facts and machine states. Safe for anyone. */
  claim: PublicFeedClaim;
  /** How the caller was classified; drives the copy, never the redaction. */
  access: ClaimAccess;
  /** Whether a claim exists at all. Not sensitive - the feed publishes the
   *  goal ids of live claims - and the UI needs it to tell "nothing here yet"
   *  (show the upload box) from "hidden until you sign" (say so). */
  hasLedger: boolean;
  /** The full ledger, for a proven owner only. Null for everyone else. */
  ledger: LedgerEntry[] | null;
}

/**
 * One rule, both verbs: owner gets the ledger, everyone gets the redaction.
 * The redacted claim is included even for the owner so the response shape
 * never depends on who is asking.
 *
 * `access` is reported alongside and never widens what is returned - the
 * ledger is enclosed if and only if `access` is "owner".
 */
export function projectClaimForCaller(params: {
  goalId: string;
  ledger: LedgerEntry[];
  access: ClaimAccess;
}): ClaimReadResponse {
  const { goalId, ledger, access } = params;
  const owner = access === "owner";
  return {
    claim: toPublicFeedClaim(goalId, ledger[0]?.at ?? "", ledger),
    access,
    hasLedger: ledger.length > 0,
    ledger: owner ? ledger : null,
  };
}
