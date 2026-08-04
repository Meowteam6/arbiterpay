// Which proof path a restored claim belongs to.
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

export type ProofPath = "wearable" | "document";

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
