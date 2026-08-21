// Restoring a claim in the browser: which proof path it belongs to, and what
// the claim read is allowed to show.
//
// A wearable pool offers two ways to prove the same goal and only one may be
// mounted at a time: WearableCheck and EvidenceUpload both drive SPOTTER's run
// loop for the same goal id. So a returning user has to land on the tab that
// owns the claim they already started - otherwise their receipt (and the money
// SPOTTER already spent on it) sits hidden behind the other tab and the page
// reads as though nothing ever happened.
//
// The ledger already records which path ran. The cheap read SPOTTER buys is
// the Junction summary for a wearable claim and the TEE attester read for a
// document claim, and the plan names that service before any money moves, so
// the answer survives even a claim that died at the buy step.
//
// The service names are mirrored here rather than imported: their definitions
// live in server modules that must stay out of the client bundle - the same
// rule agent-receipt.ts follows for the attester-read name.

import type { LedgerEntry } from "@/lib/agent-receipt";
import { authBlockReason, type ClientAuth } from "@/lib/client-auth";

export type ProofPath = "wearable" | "document" | "self-reported";

/** Mirror of wearable.ts's JUNCTION_READ_SERVICE. */
const WEARABLE_SERVICES = new Set(["junction-read"]);
/** Mirror of x402.ts's ATTESTER_READ_SERVICE and VISION_JUDGE_SERVICE. The
 *  vision judge only ever escalates a document read, so it identifies the
 *  path too. chain-read is deliberately absent: it is bought at settlement by
 *  both paths and says nothing about which evidence was used. */
const DOCUMENT_SERVICES = new Set(["attester-read", "vision-judge"]);

function pathOfService(service: string): ProofPath | null {
  if (WEARABLE_SERVICES.has(service)) return "wearable";
  if (DOCUMENT_SERVICES.has(service)) return "document";
  return null;
}

/**
 * The proof path the ledger's most recent attempt used, or null when the
 * ledger is empty or names no path-bearing service (callers keep their default
 * tab in that case). Scanned newest-first on purpose: a claim retried through
 * the other path must resolve to the path that ran last, not the first one
 * ever tried.
 */
export function claimProofPathOf(ledger: LedgerEntry[]): ProofPath | null {
  // The tier is definitive: a self-reported verdict routes to the self-reported
  // surface regardless of which paid service produced it (self-reported shares
  // the attester read with document). Newest verdict wins, so a claim retried
  // across tiers resolves to the tier that ran last.
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const entry = ledger[i];
    if (entry.kind === "verdict") {
      if (entry.selfReported === true) return "self-reported";
      break;
    }
  }
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const entry = ledger[i];
    if (entry.kind === "spend") {
      const path = pathOfService(entry.service);
      if (path !== null) return path;
      continue;
    }
    if (entry.kind === "plan") {
      for (let step = entry.steps.length - 1; step >= 0; step -= 1) {
        const path = pathOfService(entry.steps[step].service);
        if (path !== null) return path;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------- claim visibility
//
// /api/agent/run/[goalId] answers an unsigned caller with a redacted view: the
// ledger prose is about somebody's medical document and the goal ids are
// public, so only a proven owner gets the entries themselves. That leaves the
// browser with three distinct situations, and telling them apart is the whole
// difference between an honest screen and a blank upload box over work that
// already happened:
//
//   visible - the ledger came back; render the receipt.
//   none    - no claim exists for this wallet yet; offer the upload box.
//   locked  - a claim exists and is being withheld; say why, and what to do.
//
// The server distinguishes the last two with `hasLedger`, which is not a
// disclosure: /api/agent/feed already publishes the goal ids of live claims.

/** The shape the claim read returns. Every field optional: this parses an
 *  untrusted response, and a missing field must degrade, not throw. */
export interface ClaimReadBody {
  hasLedger?: unknown;
  ledger?: unknown;
  /** The server's own verdict on the caller: "owner" (ledger enclosed),
   *  "not-owner" (a valid signature that is definitively somebody else), or
   *  "unproven" (no usable signature, or ownership could not be established).
   *  Without it a expired signature is indistinguishable from the wrong
   *  wallet, and telling someone their own claim belongs to a stranger is the
   *  kind of wrong that reads as "the money is gone". */
  access?: unknown;
}

export type ClaimVisibility =
  | { kind: "visible"; ledger: LedgerEntry[] }
  | { kind: "none" }
  | { kind: "locked"; reason: string };

/** Only for a caller the SERVER says is definitively somebody else. */
const WRONG_WALLET =
  "This claim belongs to a different wallet. Switch to the wallet that started it to see the receipt.";

/** The honest answer when the client believed it was signed and the server
 *  still would not confirm ownership: an expired signature, a drifting clock,
 *  or a chain read that failed. Nothing about the claim is wrong, and signing
 *  again fixes every one of those. */
const SIGN_AGAIN =
  "Your wallet proof could not be confirmed just now - it may simply have expired. Sign again to see this claim.";

/**
 * What a claim read is allowed to show, given the auth state the request was
 * made under. A withheld claim always yields a reason the person can act on;
 * an absent claim never masquerades as one; and a claim is called somebody
 * else's ONLY when the server said so.
 */
export function claimVisibilityOf(
  body: ClaimReadBody,
  auth: ClientAuth,
): ClaimVisibility {
  const ledger = Array.isArray(body.ledger)
    ? (body.ledger as LedgerEntry[])
    : null;
  if (ledger !== null) {
    return ledger.length > 0 ? { kind: "visible", ledger } : { kind: "none" };
  }
  if (body.hasLedger !== true) return { kind: "none" };
  if (body.access === "not-owner") {
    return { kind: "locked", reason: WRONG_WALLET };
  }
  return { kind: "locked", reason: authBlockReason(auth) ?? SIGN_AGAIN };
}

// ------------------------------------------------------------- the run screen
//
// What the claim surface is showing, carried between polls. It exists because
// of one specific way to lie to somebody: a poll that fails, or comes back
// withheld, must not blank a receipt that already lists real money SPOTTER
// spent. An empty upload box over a paid claim invites a second upload, a
// second attester job, and a second draw on the per-claim cap.

export interface ClaimScreen {
  ledger: LedgerEntry[];
  /** Why the rows are being withheld, when they are. */
  lockedReason: string | null;
}

export function emptyClaimScreen(): ClaimScreen {
  return { ledger: [], lockedReason: null };
}

export function claimScreenOf(ledger: LedgerEntry[]): ClaimScreen {
  return { ledger, lockedReason: null };
}

/**
 * Fold one successful poll onto what is already on screen. A response that
 * carries a ledger replaces the rows; one that does not (the cached signature
 * aged out mid-run and the re-sign was refused) keeps them and explains
 * itself. Never returns fewer rows than it was given.
 */
export function nextClaimScreen(
  shown: ClaimScreen,
  body: ClaimReadBody,
  auth: ClientAuth,
): ClaimScreen {
  const visibility = claimVisibilityOf(body, auth);
  if (visibility.kind === "visible") {
    return { ledger: visibility.ledger, lockedReason: null };
  }
  return {
    ledger: shown.ledger,
    lockedReason: visibility.kind === "locked" ? visibility.reason : null,
  };
}

/**
 * The receipt an error screen must keep. Undefined only when there was never
 * anything to show - a transient 5xx on the first poll of a resumed claim is
 * exactly when this matters, because the rows on screen are the user's only
 * evidence that SPOTTER already paid for the verification.
 */
export function receiptToKeep(
  shown: ClaimScreen | undefined,
): LedgerEntry[] | undefined {
  if (shown === undefined || shown.ledger.length === 0) return undefined;
  return shown.ledger;
}

/**
 * The ledger a poll should render. A poll that lost visibility mid-run (the
 * cached signature aged out and the re-sign was refused) keeps whatever was
 * already on screen: money that moved must not vanish from the receipt because
 * the next request went out unsigned.
 */
export function mergeRunLedger(
  previous: LedgerEntry[],
  body: ClaimReadBody,
): LedgerEntry[] {
  return Array.isArray(body.ledger) ? (body.ledger as LedgerEntry[]) : previous;
}
