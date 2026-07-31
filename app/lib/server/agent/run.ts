// SPOTTER's run loop for one claim: plan, buy, read the attester, escalate
// when the read is unreadable, decide, record on-chain, settle when
// settleable. Every step lands in the ledger before anything else happens,
// and the ledger doubles as the idempotence record - the browser polls this
// run and each poll resumes exactly where the last one stopped. Nothing is
// bought twice, nothing is recorded twice, and "paid" is only ever derived
// from a real AchieverPaid payout.
//
// The buy side (x402.ts) and the reason step (reason.ts) are injected via
// RunDeps; this file owns the control flow between them. The cheap-first-
// then-escalate shape is deliberate: the plan prints one cheap read, and the
// vision-judge row appears only when that read comes back unreadable - an
// unplanned purchase, decided live, under the frozen cap.

import type { Address, Hex } from "viem";
import {
  appendLedger,
  defaultClaimCapUsd,
  findSpend,
  readLedger,
  totalSpentUsd,
  LedgerInvariantError,
  type LedgerEntry,
} from "@/lib/server/agent/ledger";
import {
  usdCents,
  ATTESTER_READ_SERVICE,
  VISION_JUDGE_SERVICE,
  type BuyDeps,
  type PurchaseResult,
  type ServiceQuote,
} from "@/lib/server/agent/x402";
import type {
  EscalationContext,
  ReasonFn,
} from "@/lib/server/agent/reason";
import {
  recordResultAsSpotter,
  recordVerdictAsSpotter,
  settlePoolAsSpotter,
  type SpotterDeps,
} from "@/lib/server/agent/spotter";
import {
  multiplierForConfidence,
  type Confidence,
  type PollResult,
  type Verdict,
} from "@/lib/server/judge";
import { VERDICT_FACETS, type RecordVerdictOutcome } from "@/lib/server/verdict";
import { optionalEnv } from "@/lib/server/env";

export interface RunInput {
  goalId: Hex;
  poolId: bigint;
  address: Address;
  goalSpec: string;
  attesterId: string;
  evidenceKind: keyof typeof VERDICT_FACETS;
}

export interface RunDeps {
  spotter: SpotterDeps;
  buy: BuyDeps;
  reason: ReasonFn;
  poll: (attesterId: string, goalSpec: string) => Promise<PollResult>;
  legacyRecordResult: (
    poolId: bigint,
    user: Address,
    verdict: boolean,
    multiplierBps: bigint,
  ) => Promise<Hex>;
  legacyRecordVerdict: (
    poolId: bigint,
    user: Address,
    verified: boolean,
    confidence: Confidence,
    attesterId: string,
    facets?: number,
  ) => Promise<RecordVerdictOutcome>;
}

export type RunStatus =
  | "verifying"
  | "cap-exceeded"
  | "no-pay"
  | "blocked"
  | "recorded"
  | "paid"
  | "error";

export interface RunResult {
  status: RunStatus;
  ledger: LedgerEntry[];
}

function entryOf<K extends LedgerEntry["kind"]>(
  entries: LedgerEntry[],
  kind: K,
): Extract<LedgerEntry, { kind: K }> | undefined {
  return entries.find(
    (e): e is Extract<LedgerEntry, { kind: K }> => e.kind === kind,
  );
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The escalation's verdict entry is keyed off the attester job with this
 *  suffix so a resumed poll can recover the second opinion from the ledger. */
function escalationRef(attesterId: string): string {
  return `${attesterId}:vision-judge`;
}

function escalationVerdictOf(
  entries: LedgerEntry[],
  attesterId: string,
): Extract<LedgerEntry, { kind: "verdict" }> | undefined {
  return entries.find(
    (e): e is Extract<LedgerEntry, { kind: "verdict" }> =>
      e.kind === "verdict" && e.ref === escalationRef(attesterId),
  );
}

/** Parse a verdict-shaped second opinion out of an escalation service
 *  response. Anything else degrades to an opaque summary for the reason step. */
function parseOpinion(data: unknown): {
  verdict: Verdict | null;
  summary: string | null;
} {
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (
      typeof record.verified === "boolean" &&
      (record.confidence === "low" ||
        record.confidence === "medium" ||
        record.confidence === "high") &&
      typeof record.reason === "string"
    ) {
      const verdict: Verdict = {
        verified: record.verified,
        confidence: record.confidence,
        reason: record.reason,
      };
      return {
        verdict,
        summary: `verified=${verdict.verified}, confidence=${verdict.confidence}: ${verdict.reason}`,
      };
    }
    return { verdict: null, summary: JSON.stringify(record).slice(0, 200) };
  }
  return { verdict: null, summary: null };
}

type PurchaseOutcome =
  | { ok: true; ledger: LedgerEntry[]; purchase: PurchaseResult }
  | { ok: false; ledger: LedgerEntry[]; message: string };

/**
 * Execute one service purchase under the claim cap.
 *
 * The headroom check runs BEFORE the buy because an x402 purchase moves real
 * money the moment pay() runs - the ledger's own append-time invariant cannot
 * protect a spend that already settled. The append afterwards is still the
 * authority: if the actual price exceeded the estimate and breaks the cap,
 * the invariant error is surfaced loudly, never swallowed.
 */
async function purchaseService(
  deps: RunDeps,
  goalId: Hex,
  ledger: LedgerEntry[],
  quote: ServiceQuote,
  ref: string,
  body: Record<string, unknown>,
  notePrefix?: string,
): Promise<PurchaseOutcome> {
  const plan = entryOf(ledger, "plan");
  if (plan === undefined) {
    return {
      ok: false,
      ledger,
      message: "no plan entry exists; SPOTTER emits its plan before any spend",
    };
  }
  const spent = usdCents(totalSpentUsd(ledger));
  const next = usdCents(quote.estUsd);
  const cap = usdCents(plan.capUsd);
  if (spent + next > cap) {
    return {
      ok: false,
      ledger,
      message:
        `buying ${quote.service} at ${quote.estUsd} USDC would break the ` +
        `${plan.capUsd} USDC cap for this claim (already spent ${totalSpentUsd(ledger)})`,
    };
  }

  const purchase = await deps.buy.buy(quote, body);
  const noteParts = [
    notePrefix,
    purchase.gatewayTx !== null ? `gateway tx ${purchase.gatewayTx}` : undefined,
  ].filter((p): p is string => p !== undefined && p !== "");
  try {
    const updated = await appendLedger(goalId, {
      kind: "spend",
      service: quote.service,
      label: quote.label,
      amountUsd: purchase.amountUsd,
      ref,
      settlement: purchase.settlement,
      note: noteParts.length > 0 ? noteParts.join(" ") : undefined,
    });
    return { ok: true, ledger: updated, purchase };
  } catch (err) {
    if (err instanceof LedgerInvariantError) {
      // Money may already have moved for this purchase; say so explicitly.
      return {
        ok: false,
        ledger,
        message:
          `${quote.service} purchase of ${purchase.amountUsd} USDC exceeded ` +
          `the estimate and broke the claim cap AFTER settlement ` +
          `(${purchase.gatewayTx !== null ? `gateway tx ${purchase.gatewayTx}` : purchase.settlement}): ` +
          err.message,
      };
    }
    throw err;
  }
}

async function spotterHoldsRole(
  deps: RunDeps,
  role: "oracle" | "attester",
): Promise<boolean> {
  const spotterAddress = optionalEnv("SPOTTER_WALLET_ADDRESS", "");
  if (spotterAddress === "") return false;
  const holder =
    role === "oracle"
      ? await deps.spotter.reader.oracleAddress()
      : await deps.spotter.reader.attesterAddress();
  return sameAddress(holder, spotterAddress);
}

/**
 * Drive one claim as far as it can go right now. Safe to call repeatedly;
 * the ledger carries the state between polls.
 */
export async function runAgentForGoal(
  deps: RunDeps,
  input: RunInput,
): Promise<RunResult> {
  let ledger = await readLedger(input.goalId);

  // Fast path: money already moved for this claim; nothing left to do.
  const settled = ledger.find(
    (e) => e.kind === "settle" && e.status === "settled",
  );
  if (settled !== undefined) {
    return { status: "paid", ledger };
  }

  // PLAN - printed before any money moves, cap frozen at plan time. The plan
  // deliberately holds only the cheap read: when an escalation happens, its
  // row prints unplanned, which is the moment the whole submission hangs on.
  let attesterQuote: ServiceQuote | null = null;
  const getAttesterQuote = async () => {
    attesterQuote ??= await deps.buy.quoteAttesterRead();
    return attesterQuote;
  };
  if (entryOf(ledger, "plan") === undefined) {
    const quote = await getAttesterQuote();
    ledger = await appendLedger(input.goalId, {
      kind: "plan",
      steps: [
        { service: quote.service, label: quote.label, estUsd: quote.estUsd },
      ],
      capUsd: defaultClaimCapUsd(),
    });
  }

  // BUY - once per attester job, deduped by (service, attester id) so a
  // re-poll never double-buys. A cap violation aborts the run before the
  // service is consumed.
  if (
    findSpend(ledger, ATTESTER_READ_SERVICE, input.attesterId) === undefined
  ) {
    const outcome = await purchaseService(
      deps,
      input.goalId,
      ledger,
      await getAttesterQuote(),
      input.attesterId,
      { attesterId: input.attesterId, goalSpec: input.goalSpec },
    );
    ledger = outcome.ledger;
    if (!outcome.ok) {
      ledger = await appendLedger(input.goalId, {
        kind: "error",
        stage: "buy",
        message: outcome.message,
      });
      return { status: "cap-exceeded", ledger };
    }
  }

  // ATTESTER - poll the inference this claim paid for.
  const { status, verdict } = await deps.poll(input.attesterId, input.goalSpec);
  if (status === "verifying" || verdict === null) {
    return { status: "verifying", ledger };
  }

  if (entryOf(ledger, "verdict") === undefined) {
    ledger = await appendLedger(input.goalId, {
      kind: "verdict",
      verified: verdict.verified,
      confidence: verdict.confidence,
      reason: verdict.reason,
      ref: input.attesterId,
    });
  }

  // ESCALATE - the cheap read completed but could not actually read the
  // evidence (low confidence). SPOTTER buys exactly one second opinion,
  // under the same frozen cap. A transport-failed inference never escalates:
  // buying a second read of a job that never ran spends money on nothing.
  // The second opinion's verdict, when the service returns one, lands as its
  // own ledger verdict entry so a resumed poll recovers it.
  let escalation: EscalationContext = { kind: "none" };
  let effective: Verdict = verdict;
  const priorEscalation = escalationVerdictOf(ledger, input.attesterId);
  if (priorEscalation !== undefined) {
    escalation = {
      kind: "bought",
      opinion: `verified=${priorEscalation.verified}, confidence=${priorEscalation.confidence}: ${priorEscalation.reason}`,
    };
    effective = {
      verified: priorEscalation.verified,
      confidence: priorEscalation.confidence,
      reason: priorEscalation.reason,
    };
  } else if (
    findSpend(ledger, VISION_JUDGE_SERVICE, input.attesterId) !== undefined
  ) {
    // Spend landed but the opinion was lost to a resume; do not buy again.
    escalation = { kind: "bought", opinion: null };
  } else if (
    status === "completed" &&
    verdict.confidence === "low" &&
    entryOf(ledger, "reason") === undefined
  ) {
    const quote = await deps.buy.quoteVisionJudge();
    const poolUsd = await deps.spotter.reader
      .poolBalanceUsd?.(input.poolId)
      .catch(() => undefined);
    const escalationLine =
      poolUsd !== undefined
        ? `escalating. i can't read this and i'm not paying out ${poolUsd} USDC on something i can't read.`
        : "escalating. i can't read this and i'm not paying out on something i can't read.";
    const outcome = await purchaseService(
      deps,
      input.goalId,
      ledger,
      quote,
      input.attesterId,
      {
        attesterId: input.attesterId,
        goalSpec: input.goalSpec,
        verdict: {
          verified: verdict.verified,
          confidence: verdict.confidence,
          reason: verdict.reason,
        },
      },
      escalationLine,
    );
    ledger = outcome.ledger;
    if (outcome.ok) {
      const opinion = parseOpinion(outcome.purchase.data);
      escalation = { kind: "bought", opinion: opinion.summary };
      if (opinion.verdict !== null) {
        effective = opinion.verdict;
        ledger = await appendLedger(input.goalId, {
          kind: "verdict",
          verified: opinion.verdict.verified,
          confidence: opinion.verdict.confidence,
          reason: opinion.verdict.reason,
          ref: escalationRef(input.attesterId),
        });
      }
    } else {
      // Not an error state: the agent declines the purchase and decides with
      // what it has. The reason step is told why.
      escalation = { kind: "skipped", why: outcome.message };
    }
  }

  // REASON - Gemini on Vertex via deps.reason, anchored to the deterministic
  // rule and falling back to it loudly. Deadpan on purpose. The guardrail
  // below is not the model's to negotiate: a decision can veto a payout but
  // never mint one without a verified verdict behind it.
  let reason = entryOf(ledger, "reason");
  if (reason === undefined) {
    const plan = entryOf(ledger, "plan");
    const decided = await deps.reason({
      goalSpec: input.goalSpec,
      verdict: effective,
      attesterStatus: status,
      escalation,
      capUsd: plan?.capUsd ?? defaultClaimCapUsd(),
      spentUsd: totalSpentUsd(ledger),
    });
    let decision = decided.decision;
    let note = decided.note;
    if (decision === "pay" && !effective.verified) {
      decision = "no-pay";
      note = `overruled to no-pay: no verified verdict backs this claim. ${note}`;
    }
    ledger = await appendLedger(input.goalId, { kind: "reason", decision, note });
    reason = entryOf(ledger, "reason");
  }
  if (reason?.decision !== "pay") {
    return { status: "no-pay", ledger };
  }

  // RECORD - both writes (pool result + verdict registry), dispatched to
  // whichever key the chain currently trusts. Recorded exactly once; the
  // ledger entry lands only after BOTH writes are in.
  if (entryOf(ledger, "record") === undefined) {
    // An escalated claim records the second opinion's confidence: that is the
    // verdict the pay decision actually rests on.
    const multiplierBps = multiplierForConfidence(effective.confidence);
    const facets = VERDICT_FACETS[input.evidenceKind];
    try {
      let resultTx: string | undefined;
      let registryTx: string | undefined;
      let registryStatus: "recorded" | "already-recorded" | "skipped";

      if (await spotterHoldsRole(deps, "oracle")) {
        const r = await recordResultAsSpotter(deps.spotter, {
          poolId: input.poolId,
          user: input.address,
          verdict: true,
          multiplierBps: Number(multiplierBps),
        });
        resultTx = r.status === "recorded" ? r.txHash : undefined;
      } else {
        try {
          resultTx = await deps.legacyRecordResult(
            input.poolId,
            input.address,
            true,
            multiplierBps,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Already on chain is the end state we wanted; anything else throws.
          if (!message.includes("ALREADY_RECORDED")) throw err;
        }
      }

      if (await spotterHoldsRole(deps, "attester")) {
        const r = await recordVerdictAsSpotter(deps.spotter, {
          goalId: input.goalId,
          verified: true,
          confidence: effective.confidence,
          attesterRef: input.attesterId,
          facets,
        });
        registryStatus = r.status;
        registryTx = r.status === "recorded" ? r.txHash : undefined;
      } else {
        const r = await deps.legacyRecordVerdict(
          input.poolId,
          input.address,
          true,
          effective.confidence,
          input.attesterId,
          facets,
        );
        registryStatus = r.status === "skipped" ? "skipped" : r.status;
        registryTx = r.status === "recorded" ? r.txHash : undefined;
      }

      ledger = await appendLedger(input.goalId, {
        kind: "record",
        goalId: input.goalId,
        resultTx,
        registryStatus,
        registryTx,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ledger = await appendLedger(input.goalId, {
        kind: "error",
        stage: "record",
        message,
      });
      return {
        status: message.includes("NOT_PARTICIPANT") ? "blocked" : "error",
        ledger,
      };
    }
  }

  // SETTLE WHEN SETTLEABLE - SPOTTER pays from its own wallet the moment the
  // pool period allows it. A deferral is recorded once, not per poll.
  try {
    const outcome = await settlePoolAsSpotter(deps.spotter, {
      poolId: input.poolId,
      goalId: input.goalId,
      participant: input.address,
    });

    if (outcome.status === "not-due") {
      if (entryOf(ledger, "settle") === undefined) {
        ledger = await appendLedger(input.goalId, {
          kind: "settle",
          status: "deferred",
          note: `pool period ends at ${outcome.periodEnd.toString()}; settling the moment it does`,
        });
      }
      return { status: "recorded", ledger };
    }

    if (outcome.status === "already-settled") {
      // The pool settled without this participant's payout landing in the
      // ledger - settle() is one-shot, so this claim can never pay now.
      ledger = await appendLedger(input.goalId, {
        kind: "error",
        stage: "settle",
        message:
          "pool settled before this claim completed; a one-shot settle cannot pay it retroactively",
      });
      return { status: "error", ledger };
    }

    ledger = await appendLedger(input.goalId, {
      kind: "settle",
      status: "settled",
      txHash: outcome.txHash,
      paidUsd: outcome.participantPaidUsd,
    });
    return { status: "paid", ledger };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ledger = await appendLedger(input.goalId, {
      kind: "error",
      stage: "settle",
      message,
    });
    return { status: "error", ledger };
  }
}
