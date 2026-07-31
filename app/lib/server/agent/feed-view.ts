// Public projection of SPOTTER's ledger for the unauthenticated agent feed.
//
// The full ledger carries model-authored prose written about medical
// documents - verdict reasons, decision notes, escalation lines, engineer
// diagnostics. None of that belongs on a public endpoint; the product's core
// claim is that health data stays private. This view keeps only money facts
// and machine states: amounts, service labels, settlement rails, tx hashes,
// statuses, timestamps. No reason text, no notes, no goal text, no error
// prose.

import type { LedgerEntry } from "@/lib/server/agent/ledger";

// settle.periodEndIso is an optional field newer ledgers carry on deferred
// entries; widened locally so this module compiles whether or not the ledger
// type has it yet.
type SettleLedgerEntry = Extract<LedgerEntry, { kind: "settle" }> & {
  periodEndIso?: string;
};

export interface PublicFeedSpend {
  at: string;
  label: string;
  amountUsd: string;
  settlement: "prepaid" | "x402";
}

export interface PublicFeedSettle {
  at: string;
  status: "deferred" | "settled" | "already-settled";
  paidUsd: string | null;
  txHash: string | null;
  periodEndIso: string | null;
}

export interface PublicFeedClaim {
  goalId: string;
  at: string;
  decision: "pay" | "no-pay" | null;
  spends: PublicFeedSpend[];
  recordTxs: { resultTx: string | null; registryTx: string | null } | null;
  settle: PublicFeedSettle | null;
}

/** Runtime string check. The store returns whatever JSON it holds, so the
 *  redaction boundary is also the validation boundary: a corrupt field must
 *  not crash the public console or render a wrong value. */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Redact one claim's ledger down to what the public feed may carry. */
export function toPublicFeedClaim(
  goalId: string,
  at: string,
  ledger: LedgerEntry[],
): PublicFeedClaim {
  const spends: PublicFeedSpend[] = [];
  let decision: "pay" | "no-pay" | null = null;
  let recordTxs: PublicFeedClaim["recordTxs"] = null;
  let settle: PublicFeedSettle | null = null;

  for (const entry of ledger) {
    switch (entry.kind) {
      case "spend": {
        // The spend note stays server-side: it carries the escalation line.
        // A corrupt amount is dropped whole rather than crashing the feed.
        const amountUsd = asString(entry.amountUsd);
        if (amountUsd === null) break;
        spends.push({
          at: entry.at,
          label: entry.label,
          amountUsd,
          settlement: entry.settlement,
        });
        break;
      }
      case "reason":
        // The decision is a machine state; the note behind it is model prose.
        decision = entry.decision;
        break;
      case "record":
        recordTxs = {
          resultTx: entry.resultTx ?? null,
          registryTx: entry.registryTx ?? null,
        };
        break;
      case "settle": {
        // A settled entry is the claim's end state; never let a later
        // duplicate or deferred row displace it.
        if (settle?.status === "settled") break;
        const widened = entry as SettleLedgerEntry;
        settle = {
          at: entry.at,
          status: entry.status,
          paidUsd: asString(entry.paidUsd),
          txHash: asString(entry.txHash),
          periodEndIso: asString(widened.periodEndIso),
        };
        break;
      }
      // plan, verdict, and error entries carry prose (goal specs, model
      // reasons, engineer diagnostics) and never leave the server.
      default:
        break;
    }
  }

  return { goalId, at, decision, spends, recordTxs, settle };
}
