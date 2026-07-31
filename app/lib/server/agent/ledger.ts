// SPOTTER's append-only decision ledger, keyed by goalId.
//
// Every step the agent takes on a claim - the plan it prints before spending,
// each purchase, the attester verdict, its decision, the on-chain writes, the
// settlement - lands here as one entry. AgentReceipt renders this verbatim;
// nothing on that screen exists unless it went through this file first.
//
// Two invariants are enforced at append time, not render time:
//   1. No spend without a prior plan entry ("emit plan before any spend").
//   2. Spends stop dead at the per-claim USDC cap frozen into the plan.
// A violating entry throws LedgerInvariantError and persists nothing.
//
// Built on store.ts (Upstash Redis in prod, tmpdir JSON locally). Append is
// read-modify-write, not atomic - acceptable at demo scale because each goalId
// is driven by a single polling client; revisit if runs ever race.

import { readJson, writeJson } from "@/lib/server/store";
import { optionalEnv } from "@/lib/server/env";
import type { Confidence } from "@/lib/server/judge";

export const DEFAULT_CLAIM_CAP_USD = "1.00";

export interface PlannedStep {
  service: string;
  label: string;
  estUsd: string;
}

interface Stamped {
  at: string;
}

export type LedgerEntry = Stamped &
  (
    | { kind: "plan"; steps: PlannedStep[]; capUsd: string }
    | {
        kind: "spend";
        service: string;
        label: string;
        amountUsd: string;
        /** External reference for dedupe, e.g. the attester job id. */
        ref: string;
        /** How the purchase settled. "prepaid" = metered under an existing
         *  API key; "x402" = paid per-call from SPOTTER's wallet. */
        settlement: "prepaid" | "x402";
        note?: string;
      }
    | {
        kind: "verdict";
        verified: boolean;
        confidence: Confidence;
        reason: string;
        ref: string;
      }
    | { kind: "reason"; decision: "pay" | "no-pay"; note: string }
    | {
        kind: "record";
        goalId: string;
        resultTx?: string;
        registryStatus: "recorded" | "already-recorded" | "skipped";
        registryTx?: string;
      }
    | {
        kind: "settle";
        status: "deferred" | "settled" | "already-settled";
        txHash?: string;
        paidUsd?: string;
        note?: string;
      }
    | { kind: "error"; stage: string; message: string }
  );

export type LedgerEntryInput = LedgerEntry extends infer E
  ? E extends Stamped
    ? Omit<E, "at">
    : never
  : never;

export class LedgerInvariantError extends Error {}

function ledgerFile(goalId: string): string {
  return `agent-ledger-${goalId.toLowerCase()}.json`;
}

// The store is key/value with no scan, so the /agent feed needs its own
// index: one entry per claim, written when the claim's plan lands (the plan
// is every claim's first entry, so one index write per claim, ever).
const LEDGER_INDEX_FILE = "agent-ledger-index.json";

export interface LedgerIndexEntry {
  goalId: string;
  at: string;
}

/** Claims SPOTTER has touched, most recent first. */
export async function listLedgerGoalIds(
  limit = 20,
): Promise<LedgerIndexEntry[]> {
  const index = await readJson<LedgerIndexEntry[]>(LEDGER_INDEX_FILE, []);
  return index.slice(0, limit);
}

async function indexGoal(goalId: string, at: string): Promise<void> {
  const index = await readJson<LedgerIndexEntry[]>(LEDGER_INDEX_FILE, []);
  const key = goalId.toLowerCase();
  if (index.some((entry) => entry.goalId === key)) return;
  await writeJson(LEDGER_INDEX_FILE, [{ goalId: key, at }, ...index]);
}

/** Whole-cent USD amounts only; anything else is a bug upstream. */
function usdToCents(amount: string, context: string): number {
  if (!/^\d+\.\d{2}$/.test(amount)) {
    throw new LedgerInvariantError(
      `${context}: amount ${JSON.stringify(amount)} must be a USD string with exactly two decimals`,
    );
  }
  const [dollars, cents] = amount.split(".");
  return Number(dollars) * 100 + Number(cents);
}

function centsToUsd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  return `${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

export function defaultClaimCapUsd(): string {
  return optionalEnv("AGENT_CLAIM_CAP_USD", DEFAULT_CLAIM_CAP_USD);
}

export async function readLedger(goalId: string): Promise<LedgerEntry[]> {
  return readJson<LedgerEntry[]>(ledgerFile(goalId), []);
}

export function totalSpentUsd(entries: LedgerEntry[]): string {
  let cents = 0;
  for (const entry of entries) {
    if (entry.kind === "spend") {
      cents += usdToCents(entry.amountUsd, "totalSpentUsd");
    }
  }
  return centsToUsd(cents);
}

export function findSpend(
  entries: LedgerEntry[],
  service: string,
  ref: string,
): Extract<LedgerEntry, { kind: "spend" }> | undefined {
  return entries.find(
    (e): e is Extract<LedgerEntry, { kind: "spend" }> =>
      e.kind === "spend" && e.service === service && e.ref === ref,
  );
}

function planOf(
  entries: LedgerEntry[],
): Extract<LedgerEntry, { kind: "plan" }> | undefined {
  return entries.find(
    (e): e is Extract<LedgerEntry, { kind: "plan" }> => e.kind === "plan",
  );
}

function assertAppendAllowed(
  entries: LedgerEntry[],
  entry: LedgerEntryInput,
): void {
  if (entry.kind === "plan") {
    if (planOf(entries) !== undefined) {
      throw new LedgerInvariantError(
        "a plan entry already exists for this goal; the plan is emitted once",
      );
    }
    usdToCents(entry.capUsd, "plan.capUsd");
    for (const step of entry.steps) {
      usdToCents(step.estUsd, `plan step ${step.service}`);
    }
    return;
  }

  if (entry.kind === "spend") {
    const plan = planOf(entries);
    if (plan === undefined) {
      throw new LedgerInvariantError(
        "no plan entry exists for this goal; SPOTTER emits its plan before any spend",
      );
    }
    const spent = usdToCents(totalSpentUsd(entries), "ledger total");
    const next = usdToCents(entry.amountUsd, "spend.amountUsd");
    const cap = usdToCents(plan.capUsd, "plan.capUsd");
    if (spent + next > cap) {
      throw new LedgerInvariantError(
        `spend of ${entry.amountUsd} USDC would break the ${plan.capUsd} USDC ` +
          `cap for this claim (already spent ${centsToUsd(spent)})`,
      );
    }
  }
}

/**
 * Append one entry, enforcing the plan-before-spend and cap invariants.
 * Returns the full ledger including the new entry.
 */
export async function appendLedger(
  goalId: string,
  entry: LedgerEntryInput,
): Promise<LedgerEntry[]> {
  const entries = await readLedger(goalId);
  assertAppendAllowed(entries, entry);
  const stamped = { ...entry, at: new Date().toISOString() } as LedgerEntry;
  const next = [...entries, stamped];
  await writeJson(ledgerFile(goalId), next);
  if (stamped.kind === "plan") {
    await indexGoal(goalId, stamped.at);
  }
  return next;
}
