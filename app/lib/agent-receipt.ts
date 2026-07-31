// Projection of SPOTTER's ledger into AgentReceipt rows. Client-safe: the
// only tie to the server ledger is `import type`, which erases at compile
// time, so nothing from the server store reaches the browser bundle.
//
// The receipt is the most protected surface in the build: every row here maps
// one-to-one onto a ledger entry, planned steps render before their prices,
// and the paid amount comes exclusively from the settle entry's AchieverPaid-
// derived value - never from a transaction merely succeeding.

import type { LedgerEntry } from "@/lib/server/agent/ledger";
import type { RunStatus } from "@/lib/server/agent/run";

export type { LedgerEntry, RunStatus };

export type ReceiptRow =
  | {
      kind: "spend";
      label: string;
      /** Present in the plan printed before any money moved. */
      planned: boolean;
      estUsd: string | null;
      /** Actual amount once the spend landed; null while still planned. */
      paidUsd: string | null;
      settlement: "prepaid" | "x402" | null;
      note: string | null;
    }
  | {
      kind: "verdict";
      verified: boolean;
      confidence: "low" | "medium" | "high";
      reason: string;
      /** True for the vision judge's second opinion. */
      escalation: boolean;
    }
  | { kind: "reason"; decision: "pay" | "no-pay"; note: string }
  | { kind: "record"; resultTx: string | null; registryTx: string | null }
  | {
      kind: "settle";
      status: "deferred" | "settled" | "already-settled";
      txHash: string | null;
      paidUsd: string | null;
      note: string | null;
    }
  | { kind: "error"; stage: string; message: string };

export interface Receipt {
  rows: ReceiptRow[];
  /** Sum of everything spent so far, two decimals. */
  spentUsd: string;
  /** Cap frozen into the plan; null before the plan lands. */
  capUsd: string | null;
  /** What the participant was actually paid; null until settled. */
  paidUsd: string | null;
}

/** Normalize a USD-ish string ("50", "0.410000") to exactly two decimals,
 *  truncating extra precision - display must never overstate money. */
export function toUsd2(value: string): string {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (match === null) return value;
  const cents = (match[2] ?? "").padEnd(2, "0").slice(0, 2);
  return `${match[1]}.${cents}`;
}

function addUsd(a: string, b: string): string {
  const cents = (v: string) => {
    const [dollars, rest = ""] = v.split(".");
    return Number(dollars) * 100 + Number(rest.padEnd(2, "0").slice(0, 2));
  };
  const total = cents(a) + cents(b);
  return `${Math.floor(total / 100)}.${String(total % 100).padStart(2, "0")}`;
}

/**
 * Fold the ledger, in order, into renderable rows. Planned steps appear as
 * soon as the plan entry lands; a spend that matches a planned service fills
 * that row in place, an unplanned spend (the escalation) gets its own row at
 * its chronological position.
 */
export function projectReceipt(ledger: LedgerEntry[]): Receipt {
  const rows: ReceiptRow[] = [];
  const pendingPlanned = new Map<string, number>();
  let spentUsd = "0.00";
  let capUsd: string | null = null;
  let paidUsd: string | null = null;

  for (const entry of ledger) {
    switch (entry.kind) {
      case "plan": {
        capUsd = entry.capUsd;
        for (const step of entry.steps) {
          pendingPlanned.set(step.service, rows.length);
          rows.push({
            kind: "spend",
            label: step.label,
            planned: true,
            estUsd: step.estUsd,
            paidUsd: null,
            settlement: null,
            note: null,
          });
        }
        break;
      }
      case "spend": {
        spentUsd = addUsd(spentUsd, entry.amountUsd);
        const plannedIndex = pendingPlanned.get(entry.service);
        if (plannedIndex !== undefined) {
          pendingPlanned.delete(entry.service);
          const row = rows[plannedIndex];
          if (row.kind === "spend") {
            row.paidUsd = toUsd2(entry.amountUsd);
            row.settlement = entry.settlement;
            row.note = entry.note ?? null;
          }
        } else {
          rows.push({
            kind: "spend",
            label: entry.label,
            planned: false,
            estUsd: null,
            paidUsd: toUsd2(entry.amountUsd),
            settlement: entry.settlement,
            note: entry.note ?? null,
          });
        }
        break;
      }
      case "verdict": {
        rows.push({
          kind: "verdict",
          verified: entry.verified,
          confidence: entry.confidence,
          reason: entry.reason,
          escalation: entry.ref.endsWith(":vision-judge"),
        });
        break;
      }
      case "reason": {
        rows.push({ kind: "reason", decision: entry.decision, note: entry.note });
        break;
      }
      case "record": {
        rows.push({
          kind: "record",
          resultTx: entry.resultTx ?? null,
          registryTx: entry.registryTx ?? null,
        });
        break;
      }
      case "settle": {
        if (entry.status === "settled" && entry.paidUsd !== undefined) {
          paidUsd = toUsd2(entry.paidUsd);
        }
        rows.push({
          kind: "settle",
          status: entry.status,
          txHash: entry.txHash ?? null,
          paidUsd: entry.paidUsd !== undefined ? toUsd2(entry.paidUsd) : null,
          note: entry.note ?? null,
        });
        break;
      }
      case "error": {
        rows.push({ kind: "error", stage: entry.stage, message: entry.message });
        break;
      }
    }
  }

  return { rows, spentUsd, capUsd, paidUsd };
}

/**
 * The failure split: a claim that died on unreadable evidence is fixable
 * (the joke lands on the photo, retry invited); a claim whose document was
 * read fine but does not show the goal is a miss (deadpan, bit dropped).
 */
export function failureModeOf(
  ledger: LedgerEntry[],
): "evidence" | "goal-missed" | null {
  const reason = ledger.find((e) => e.kind === "reason");
  if (reason === undefined || reason.decision === "pay") return null;
  const verdicts = ledger.filter((e) => e.kind === "verdict");
  const last = verdicts[verdicts.length - 1];
  if (last === undefined) return "evidence";
  // A confident read that still says unverified means the document was
  // legible and the goal simply is not shown; anything low-confidence means
  // the evidence itself could not be read.
  return last.confidence === "low" ? "evidence" : "goal-missed";
}
