// Projection of SPOTTER's ledger into AgentReceipt rows, plus every
// branchable decision the claim client (EvidenceUpload) makes about a ledger:
// which entries belong to the current attempt, what terminal state a fetched
// ledger encodes, why a claim was not paid, and when to re-poll a deferred
// settlement. Those decisions live here as pure functions so they are unit-
// testable in node; the component stays thin.
//
// Client-safe: the only tie to the server ledger is `import type`, which
// erases at compile time, so nothing from the server store reaches the
// browser bundle. Server-side constants this file must agree on (the fail-
// closed attester id prefix, the attester-read service name) are mirrored
// locally rather than imported for the same reason.
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

// ------------------------------------------------- current-attempt selection
//
// One goalId accumulates entries across every attempt (each retry submits a
// new attester job). The server tags verdict/spend entries - and, going
// forward, reason entries - with the attester job id in `ref`, so the current
// attempt's entries are the ones whose ref matches the current attesterId
// (the escalation's `${attesterId}:vision-judge` verdict outranks the cheap
// read it corrects). Ledgers written before reason refs existed have no
// match; for those the LAST entry of a kind is the current one, never the
// first - earlier attempts must not speak for later ones.

/** Mirror of judge.ts's fail-closed inference id prefix. Deliberately not
 *  imported: judge.ts is server code and must stay out of the client bundle. */
export const FAIL_PREFIX = "fail-";

/** Mirror of x402.ts's attester-read service name (server module, same rule). */
const ATTESTER_READ_SERVICE = "attester-read";

type VerdictEntry = Extract<LedgerEntry, { kind: "verdict" }>;
type ReasonEntry = Extract<LedgerEntry, { kind: "reason" }>;
type SettleEntry = Extract<LedgerEntry, { kind: "settle" }>;
type ErrorEntry = Extract<LedgerEntry, { kind: "error" }>;

// The server is gaining these OPTIONAL fields (reason.ref, settle
// deferred.periodEndIso). Widened locally so this code compiles and behaves
// identically whether or not the server-side change has merged yet.
type ReasonEntryMaybeRef = ReasonEntry & { ref?: string };
type SettleEntryMaybePeriodEnd = SettleEntry & { periodEndIso?: string };

function refOf(entry: LedgerEntry): string | undefined {
  if (entry.kind === "spend" || entry.kind === "verdict") return entry.ref;
  if (entry.kind === "reason") return (entry as ReasonEntryMaybeRef).ref;
  return undefined;
}

function lastWhere<T>(
  items: T[],
  matches: (item: T) => boolean,
): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (matches(items[i])) return items[i];
  }
  return undefined;
}

/**
 * The attester job id of the most recent attempt, recovered from the ledger
 * itself (the last attester-read purchase carries it as its dedupe ref).
 * Lets a restored session - which never saw the submit response - scope
 * selection to the attempt that actually ran last.
 */
export function currentAttesterIdOf(ledger: LedgerEntry[]): string | null {
  const spend = lastWhere(
    ledger,
    (e) => e.kind === "spend" && e.service === ATTESTER_READ_SERVICE,
  );
  return spend !== undefined && spend.kind === "spend" ? spend.ref : null;
}

/**
 * The verdict the current attempt's outcome rests on: the escalation's
 * second opinion when one was bought, else the cheap read, else (no ref
 * match - legacy ledger or unknown attempt) the last verdict written.
 */
export function currentVerdictEntry(
  ledger: LedgerEntry[],
  attesterId: string | null,
): VerdictEntry | undefined {
  const verdicts = ledger.filter((e): e is VerdictEntry => e.kind === "verdict");
  if (attesterId !== null) {
    const escalation = lastWhere(
      verdicts,
      (v) => v.ref === `${attesterId}:vision-judge`,
    );
    if (escalation !== undefined) return escalation;
    const base = lastWhere(verdicts, (v) => v.ref === attesterId);
    if (base !== undefined) return base;
  }
  return verdicts[verdicts.length - 1];
}

/** The current attempt's decision entry, same selection rule as verdicts. */
export function currentReasonEntry(
  ledger: LedgerEntry[],
  attesterId: string | null,
): ReasonEntry | undefined {
  const reasons = ledger.filter((e): e is ReasonEntry => e.kind === "reason");
  if (attesterId !== null) {
    const match = lastWhere(
      reasons,
      (r) => (r as ReasonEntryMaybeRef).ref === attesterId,
    );
    if (match !== undefined) return match;
  }
  return reasons[reasons.length - 1];
}

/** Index of the first entry that verifiably belongs to the given attempt
 *  (its ref is the attesterId, or an `${attesterId}:` derived ref). -1 when
 *  the attempt cannot be located, which routes callers to legacy handling. */
function attemptStartIndex(
  ledger: LedgerEntry[],
  attesterId: string | null,
): number {
  if (attesterId === null) return -1;
  for (let i = 0; i < ledger.length; i++) {
    const ref = refOf(ledger[i]);
    if (ref === attesterId || ref?.startsWith(`${attesterId}:`) === true) {
      return i;
    }
  }
  return -1;
}

/**
 * Whether the current attempt hit an attester-stage error (the verification
 * service itself failed, as opposed to the document failing verification).
 * Error entries carry no ref, so the attempt is scoped positionally: entries
 * from the attempt's first ref-bearing entry onward. Legacy ledgers fall
 * back to the last error entry - earlier attempts' failures must not bleed
 * into the current one.
 */
export function hasAttesterErrorForAttempt(
  ledger: LedgerEntry[],
  attesterId: string | null,
): boolean {
  const start = attemptStartIndex(ledger, attesterId);
  if (start >= 0) {
    return ledger
      .slice(start)
      .some((e) => e.kind === "error" && e.stage === "attester");
  }
  const errors = ledger.filter((e): e is ErrorEntry => e.kind === "error");
  const last = errors[errors.length - 1];
  return last !== undefined && last.stage === "attester";
}

export type FailureMode = "evidence" | "goal-missed" | "attester-offline";

/**
 * The failure split, three ways:
 *   - "attester-offline": the verification service never produced a real
 *     read (fail-closed attester id, or an attester-stage error). The
 *     document was never judged; a re-upload cannot help and would only
 *     re-buy verification of a service that is down. Checked first because
 *     the other two modes presume the document was actually examined.
 *   - "evidence": the read happened but could not make out the document
 *     (low confidence). Fixable - retry invited.
 *   - "goal-missed": the document was read fine and does not show the goal.
 *     A miss; no retry, a new photo of the same facts changes nothing.
 */
export function failureModeOf(
  ledger: LedgerEntry[],
  attesterId: string | null = null,
): FailureMode | null {
  const id = attesterId ?? currentAttesterIdOf(ledger);
  const verdict = currentVerdictEntry(ledger, id);
  if (verdict !== undefined && verdict.ref.startsWith(FAIL_PREFIX)) {
    return "attester-offline";
  }
  if (hasAttesterErrorForAttempt(ledger, id)) return "attester-offline";
  const reason = currentReasonEntry(ledger, id);
  if (reason === undefined || reason.decision === "pay") return null;
  if (verdict === undefined) return "evidence";
  // A confident read that still says unverified means the document was
  // legible and the goal simply is not shown; anything low-confidence means
  // the evidence itself could not be read.
  return verdict.confidence === "low" ? "evidence" : "goal-missed";
}

// ------------------------------------------------ ledger-derived run status
//
// GET /api/agent/run/[goalId] returns the ledger and no status (and only to
// the wallet that owns the claim - see lib/claim-restore.ts); a returning session
// must reconstruct the run status the POST loop would have reported. This
// mirrors the server run loop's return points - keep the two in sync.

/**
 * The run status a fetched ledger encodes, or null for an empty ledger (no
 * claim exists; show the upload box). "verifying" means the run is resumable:
 * it stopped mid-flight without a terminal marker.
 */
export function runStatusFromLedger(ledger: LedgerEntry[]): RunStatus | null {
  if (ledger.length === 0) return null;
  if (ledger.some((e) => e.kind === "settle" && e.status === "settled")) {
    return "paid";
  }
  const last = ledger[ledger.length - 1];
  if (last.kind === "error") {
    if (last.stage === "buy") return "cap-exceeded";
    if (last.stage === "record" && last.message.includes("NOT_PARTICIPANT")) {
      return "blocked";
    }
    return "error";
  }
  if (ledger.some((e) => e.kind === "settle" && e.status === "deferred")) {
    return "recorded";
  }
  const reason = currentReasonEntry(ledger, currentAttesterIdOf(ledger));
  if (reason !== undefined && reason.decision === "no-pay") return "no-pay";
  return "verifying";
}

// -------------------------------------------------- deferred settle timing

/** Padding past periodEnd before the automatic settle re-poll, covering the
 *  gap between wall clock and the chain's block timestamp check. */
export const SETTLE_REPOLL_BUFFER_MS = 5_000;

/** setTimeout treats delays above 2^31 - 1 ms as 0, which would fire an
 *  instant re-poll on far-future pools; clamp instead of overflowing. */
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * When the deferred settlement becomes due, in epoch ms. Prefers the settle
 * entry's own periodEndIso (written by the server at deferral time); falls
 * back to the pool's on-chain periodEnd (seconds) for ledgers written before
 * that field existed. Null when neither source is usable.
 */
export function deferredPeriodEndMs(
  ledger: LedgerEntry[],
  poolPeriodEndSec: number | null,
): number | null {
  const deferred = lastWhere(
    ledger,
    (e) => e.kind === "settle" && e.status === "deferred",
  ) as SettleEntryMaybePeriodEnd | undefined;
  if (deferred?.periodEndIso !== undefined) {
    const ms = Date.parse(deferred.periodEndIso);
    if (Number.isFinite(ms)) return ms;
  }
  if (
    poolPeriodEndSec !== null &&
    Number.isFinite(poolPeriodEndSec) &&
    poolPeriodEndSec > 0
  ) {
    return poolPeriodEndSec * 1000;
  }
  return null;
}

/**
 * Delay before the single automatic re-poll of a deferred claim: just after
 * periodEnd passes, or just the buffer when the period already ended (a
 * restored stale claim settles moments after the page opens). Clamped to the
 * setTimeout maximum.
 */
export function settleRepollDelayMs(
  periodEndMs: number,
  nowMs: number,
): number {
  const untilEnd = Math.max(periodEndMs - nowMs, 0);
  return Math.min(untilEnd + SETTLE_REPOLL_BUFFER_MS, MAX_TIMEOUT_DELAY_MS);
}
