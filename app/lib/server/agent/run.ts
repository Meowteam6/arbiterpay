// SPOTTER's run loop for one claim: plan, buy, read the evidence, escalate
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
//
// Verdict and reason entries are keyed to the attester job (`ref`): a retry
// under a fresh attesterId buys a fresh read AND gets a fresh verdict and a
// fresh decision, instead of paying for the read and then short-circuiting
// on the stale outcome of the previous job. The ledger stays append-only;
// selection always prefers the entry matching the current job, newest first.
//
// The settle step is shared with the sweep route (settleRecordedClaim), so a
// browser that stops polling after "recorded" still gets paid: the cron
// sweep drives the exact same block against the ledger's stored pool
// linkage the moment the pool period ends.
//
// CONCURRENCY. Everything above assumed one caller per claim. On serverless
// that assumption is false - two open tabs, or a tab and the cron sweep, run on
// two different lambdas with two different module scopes. The whole run is
// therefore wrapped in a Redis lock keyed by goalId (lock.ts), which is what
// makes "the ledger carries the state" true again: the buy dedupe, the cap
// headroom arithmetic and the record/settle steps all read a ledger snapshot
// nobody else is writing. A poll that cannot take the lock is NOT an error -
// a sibling owns the claim, so it reports the state the ledger already encodes
// and the browser polls again. Settlement additionally takes a POOL-scoped
// lock, because settle() is one-shot and pays everyone: the losers of that
// race must spend no gas and write no red row.
//
// SPENDING. Two ceilings guard the wallet. The per-claim cap frozen into the
// plan is checked here before every purchase, and the global/per-wallet daily
// caps (budget.ts) are committed before the money moves and reconciled after,
// because a fresh goalId would otherwise be a fresh budget. Each purchase also
// writes a spend-intent marker before pay() so a crash between settlement and
// the ledger append leaves a recoverable trace instead of an invisible spend.

import {
  formatUnits,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
} from "viem";
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
  VISION_JUDGE_SERVICE,
  type BuyDeps,
  type PurchaseResult,
  type ServiceQuote,
} from "@/lib/server/agent/x402";
import {
  acquireLock,
  addPendingSettlement,
  releaseLock,
  removePendingSettlement,
  withLock,
} from "@/lib/server/agent/lock";
import {
  reconcileDailySpend,
  releaseDailySpend,
  reserveDailySpend,
} from "@/lib/server/agent/budget";
import { junctionReadQuote } from "@/lib/server/agent/wearable";
import type {
  EscalationContext,
  ReasonFn,
} from "@/lib/server/agent/reason";
import {
  ACHIEVER_PAID_ABI,
  recordResultAsSpotter,
  recordVerdictAsSpotter,
  revertKind,
  settlePoolAsSpotter,
  type PoolSettleLock,
  type SpotterDeps,
} from "@/lib/server/agent/spotter";
import {
  isFailId,
  multiplierForConfidence,
  type Confidence,
  type PollResult,
  type Verdict,
} from "@/lib/server/judge";
import { VERDICT_FACETS, type RecordVerdictOutcome } from "@/lib/server/verdict";
import { optionalEnv } from "@/lib/server/env";
import { runStatusFromLedger } from "@/lib/agent-receipt";

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

/** A settled pool without this claim's payout can never pay it - settle() is
 *  one-shot. Exported so the sweep can recognize the terminal state and stop
 *  retrying a claim that is beyond recovery. */
export const SETTLE_UNPAYABLE_MESSAGE =
  "pool settled before this claim completed; a one-shot settle cannot pay it retroactively";

/** Above the run route's maxDuration (60s) so a lambda killed mid-run always
 *  has its lock expire rather than wedging the claim until someone notices. */
export const RUN_LOCK_TTL_MS = 75_000;
/** Same reasoning for the pool-scoped settle, which is the more expensive
 *  side: a Circle transaction plus an inclusion wait. */
export const SETTLE_LOCK_TTL_MS = 75_000;
/**
 * How long a spend-intent marker blocks a re-buy of the same service for the
 * same claim. Long enough that an immediate re-poll after a crash cannot pay
 * twice, short enough that a transient gateway failure does not strand the
 * claim: after the window the claim retries, and the worst case is one extra
 * cheap read bounded by the per-claim cap AND the daily caps.
 */
export const SPEND_INTENT_TTL_MS = 600_000;

/** Spread the browser's single automatic settle re-poll across a window so a
 *  pool full of open tabs does not fire every re-poll inside the same 100ms.
 *  Applied to the deferred entry's periodEndIso, which is the only re-poll
 *  timing value the server owns (the client's buffer constant lives in
 *  lib/agent-receipt.ts). Small enough to be invisible on the receipt. */
export const SETTLE_REPOLL_JITTER_MS = 15_000;

export function runLockName(goalId: string): string {
  return `agent:run:${goalId.toLowerCase()}`;
}

export function poolSettleLockName(poolId: bigint): string {
  return `agent:settle-pool:${poolId.toString()}`;
}

/** Exported so tests and operators can name the marker a stuck claim is
 *  holding; nothing in the flow needs to construct it from outside. */
export function spendIntentName(
  goalId: string,
  service: string,
  ref: string,
): string {
  return `agent:spend:${goalId.toLowerCase()}:${service}:${ref}`;
}

/** The live pool-scoped settle lock. run.ts injects it rather than the route,
 *  so every caller of the settle block gets it without touching route code. */
export function livePoolSettleLock(): PoolSettleLock {
  return {
    acquire: (poolId) =>
      acquireLock(poolSettleLockName(poolId), SETTLE_LOCK_TTL_MS),
    release: async (poolId, token) => {
      await releaseLock(poolSettleLockName(poolId), token);
    },
  };
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

/** Newest verdict entry carrying exactly this ref. Selection is by ref match
 *  and prefers the LAST entry, never the first: a retried claim appends fresh
 *  entries under its fresh attesterId and must not resurrect stale ones. */
function verdictWithRef(
  entries: LedgerEntry[],
  ref: string,
): Extract<LedgerEntry, { kind: "verdict" }> | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.kind === "verdict" && e.ref === ref) return e;
  }
  return undefined;
}

function escalationVerdictOf(
  entries: LedgerEntry[],
  attesterId: string,
): Extract<LedgerEntry, { kind: "verdict" }> | undefined {
  return verdictWithRef(entries, escalationRef(attesterId));
}

/** Newest reason decided against this attester job. Entries with a different
 *  ref (an earlier job) or no ref at all (written before refs existed) are
 *  never selected: re-deciding once is cheap, replaying a stale decision on
 *  fresh evidence is the bug this selection exists to prevent. */
function reasonOf(
  entries: LedgerEntry[],
  attesterId: string,
): Extract<LedgerEntry, { kind: "reason" }> | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.kind === "reason" && e.ref === attesterId) return e;
  }
  return undefined;
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

/**
 * Why a purchase did not happen. "plan-cap" is the guardrail the receipt
 * already shows (the plan prints its cap), so it stays a quiet skip; every
 * other refusal is an agent-level halt the receipt must spell out.
 */
type PurchaseRefusal =
  | "no-plan"
  | "plan-cap"
  | "daily-cap"
  | "intent-held"
  | "post-settlement-cap"
  /** The purchase itself threw. Ambiguous - the gateway may or may not have
   *  settled before the failure - and therefore the loudest of the lot. */
  | "purchase-failed";

type PurchaseOutcome =
  | { ok: true; ledger: LedgerEntry[]; purchase: PurchaseResult }
  | {
      ok: false;
      ledger: LedgerEntry[];
      message: string;
      refusal: PurchaseRefusal;
    };

interface PurchaseRequest {
  goalId: Hex;
  ledger: LedgerEntry[];
  quote: ServiceQuote;
  /** Dedupe reference - the attester job id, or the settle tx for a chain read. */
  ref: string;
  body: Record<string, unknown>;
  /** Participant this purchase is for, and the key of the per-wallet cap. */
  walletKey: string;
  notePrefix?: string;
}

/**
 * Execute one service purchase under every ceiling that applies to it.
 *
 * Order matters and is deliberate:
 *   1. per-claim cap frozen into the plan (cheap, local to the ledger)
 *   2. global + per-wallet daily caps, COMMITTED before the buy - a check that
 *      runs after settlement cannot stop anything
 *   3. spend intent, written before pay() so a crash between the gateway
 *      settling and the ledger append leaves a marker rather than an invisible
 *      spend, and so the next poll refuses to buy the same thing again
 *   4. the buy
 *   5. the ledger append, which stays the authority: an actual price over the
 *      estimate that breaks the claim cap is surfaced loudly, never swallowed
 *
 * Every refusal returns a message the receipt can render verbatim. Nothing here
 * stops quietly.
 */
async function purchaseService(
  deps: { buy: BuyDeps },
  request: PurchaseRequest,
): Promise<PurchaseOutcome> {
  const { goalId, ledger, quote, ref, body } = request;
  const plan = entryOf(ledger, "plan");
  if (plan === undefined) {
    return {
      ok: false,
      ledger,
      message: "no plan entry exists; SPOTTER emits its plan before any spend",
      refusal: "no-plan",
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
      refusal: "plan-cap",
    };
  }

  const budget = await reserveDailySpend({
    amountUsd: quote.estUsd,
    walletKey: request.walletKey,
    service: quote.service,
  });
  if (!budget.ok) {
    return { ok: false, ledger, message: budget.message, refusal: "daily-cap" };
  }

  const intent = spendIntentName(goalId, quote.service, ref);
  const intentToken = await acquireLock(intent, SPEND_INTENT_TTL_MS);
  if (intentToken === null) {
    await releaseDailySpend(budget.reservation);
    return {
      ok: false,
      ledger,
      message:
        `a ${quote.service} purchase for this claim is already in flight or ` +
        "was left unreconciled by an interrupted run, and no spend row records " +
        "it. SPOTTER will not buy the same read twice; this claim retries once " +
        "the intent marker expires.",
      refusal: "intent-held",
    };
  }

  let purchase: PurchaseResult;
  try {
    purchase = await deps.buy.buy(quote, body, { idempotencyKey: intent });
  } catch (err) {
    // Ambiguous: the gateway may or may not have settled before this threw.
    // Give the daily budget back (the ledger, not the counter, is the record
    // of what was spent) but KEEP the intent marker, so an immediate retry
    // cannot pay twice for the same read.
    await releaseDailySpend(budget.reservation);
    throw err;
  }

  const noteParts = [
    request.notePrefix,
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
    // The spend is on the ledger now, which is what dedupes future polls, so
    // the marker has done its job. Correct the day's total to the real price.
    await reconcileDailySpend(budget.reservation, purchase.amountUsd);
    await releaseLock(intent, intentToken);
    return { ok: true, ledger: updated, purchase };
  } catch (err) {
    if (err instanceof LedgerInvariantError) {
      // Money HAS moved and the ledger refused the row. Keep the marker (no
      // re-buy) and hold the reservation at the real amount - the daily total
      // must never understate what left the wallet.
      await reconcileDailySpend(budget.reservation, purchase.amountUsd);
      return {
        ok: false,
        ledger,
        message:
          `${quote.service} purchase of ${purchase.amountUsd} USDC exceeded ` +
          `the estimate and broke the claim cap AFTER settlement ` +
          `(${purchase.gatewayTx !== null ? `gateway tx ${purchase.gatewayTx}` : purchase.settlement}): ` +
          err.message,
        refusal: "post-settlement-cap",
      };
    }
    throw err;
  }
}

/**
 * purchaseService, with a thrown failure converted into a refusal the caller
 * can record.
 *
 * A purchase that throws is the worst case on this path: real USDC may have
 * left the wallet and there is no ledger row for it. Letting the exception
 * propagate turns that into a bare 500 with NOTHING written down - the failure
 * mode the "no silent failures on a money path" rule exists to forbid. Every
 * caller writes the returned message to the ledger, so the halt is on the
 * receipt permanently instead of living for ten minutes inside a Redis marker.
 */
async function attemptPurchase(
  deps: { buy: BuyDeps },
  request: PurchaseRequest,
): Promise<PurchaseOutcome> {
  try {
    return await purchaseService(deps, request);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      ledger: request.ledger,
      refusal: "purchase-failed",
      message:
        `the ${request.quote.service} purchase failed mid-flight (${detail}). ` +
        "SPOTTER cannot tell whether the payment settled before it failed, so " +
        "it will not buy this read again until the spend-intent marker expires.",
    };
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

/** Append one error entry unless the identical failure is already on record.
 *  Keeps a cron-driven retry loud on NEW failures without letting a repeating
 *  one grow the ledger without bound. */
async function appendErrorOnce(
  goalId: Hex,
  ledger: LedgerEntry[],
  stage: string,
  message: string,
): Promise<LedgerEntry[]> {
  const seen = ledger.some(
    (e) => e.kind === "error" && e.stage === stage && e.message === message,
  );
  if (seen) return ledger;
  return appendLedger(goalId, { kind: "error", stage, message });
}

function receiptConfirmsPayout(data: unknown, participant: Address): boolean {
  try {
    const result = (
      data as { result?: { status?: unknown; logs?: unknown } } | null
    )?.result;
    if (result === undefined || result === null) return false;
    if (result.status !== "0x1" || !Array.isArray(result.logs)) return false;
    const events = parseEventLogs({
      abi: ACHIEVER_PAID_ABI,
      logs: result.logs as Log[],
      eventName: "AchieverPaid",
    });
    return events.some(
      (e) =>
        sameAddress(e.args.participant, participant) && e.args.amount > 0n,
    );
  } catch {
    return false;
  }
}

/**
 * When a paid chain-read endpoint exists, buy ONE JSON-RPC receipt read of
 * the settle transaction through it as the independent verification of the
 * settlement, under the same claim cap. The body is a JSON-RPC request -
 * document data never reaches this service. When the quote resolves prepaid
 * there is no paid endpoint, so no spend row is written: the free-RPC assert
 * inside settlePoolAsSpotter already verified the payout and inventing a
 * purchase would be a fake reference. A failed purchase degrades to a note
 * on the settle entry; it never blocks a settlement that already paid.
 */
async function chainReadVerification(
  deps: SettleClaimDeps,
  goalId: Hex,
  ledger: LedgerEntry[],
  txHash: Hex,
  participant: Address,
): Promise<{ ledger: LedgerEntry[]; note?: string }> {
  let quote: ServiceQuote;
  try {
    quote = await deps.buy.quoteChainRead();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ledger,
      note: `chain-read quote failed (${message}); the free-RPC verification stands`,
    };
  }
  if (quote.url === null) {
    return { ledger };
  }
  if (findSpend(ledger, quote.service, txHash) !== undefined) {
    return {
      ledger,
      note: "settle transaction already verified through a paid chain read",
    };
  }

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getTransactionReceipt",
    params: [txHash],
  };
  let outcome: PurchaseOutcome;
  try {
    outcome = await purchaseService(deps, {
      goalId,
      ledger,
      quote,
      ref: txHash,
      body,
      walletKey: participant,
      notePrefix: "independent verification read of the settle transaction.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ledger,
      note: `chain-read purchase failed (${message}); the free-RPC verification stands`,
    };
  }
  if (!outcome.ok) {
    return {
      ledger: outcome.ledger,
      note: `chain-read skipped: ${outcome.message}; the free-RPC verification stands`,
    };
  }
  const confirmed = receiptConfirmsPayout(outcome.purchase.data, participant);
  return {
    ledger: outcome.ledger,
    note: confirmed
      ? "payout independently confirmed through a paid chain read: AchieverPaid present for the participant"
      : "the paid chain read returned no parseable AchieverPaid for the participant; the free-RPC verification stands",
  };
}

export interface SettleClaimDeps {
  spotter: SpotterDeps;
  buy: BuyDeps;
}

export interface SettleClaimOutcome {
  status: "settled" | "deferred" | "error";
  ledger: LedgerEntry[];
}

/**
 * The one settle block, shared by the run loop and the sweep route: settle
 * the pool from SPOTTER's wallet the moment the period allows it, append the
 * same ledger entries either caller would, and report what actually happened.
 * A deferral is recorded once, not per poll; errors are recorded once per
 * distinct failure so a two-minute cron cannot flood the ledger.
 *
 * Takes the same per-goal lock the run loop takes, so the cron sweep and a
 * polling browser cannot drive the same claim at once across two lambdas. The
 * run loop calls the unlocked body directly because it already holds it.
 */
export async function settleRecordedClaim(
  deps: SettleClaimDeps,
  input: { goalId: Hex; poolId: bigint; participant: Address },
): Promise<SettleClaimOutcome> {
  const outcome = await withLock(
    runLockName(input.goalId),
    RUN_LOCK_TTL_MS,
    () => settleClaimUnlocked(deps, input),
  );
  if (outcome.acquired) return outcome.value;
  // A sibling (a polling browser, or an overlapping sweep) owns this claim
  // right now. Not a failure and not a deferral to record: report what the
  // ledger currently says and let the holder finish.
  const ledger = await readLedger(input.goalId);
  return {
    status: ledger.some((e) => e.kind === "settle" && e.status === "settled")
      ? "settled"
      : "deferred",
    ledger,
  };
}

async function settleClaimUnlocked(
  deps: SettleClaimDeps,
  input: { goalId: Hex; poolId: bigint; participant: Address },
): Promise<SettleClaimOutcome> {
  let ledger = await readLedger(input.goalId);
  try {
    const outcome = await settlePoolAsSpotter(
      {
        ...deps.spotter,
        // Injected here rather than by the routes: every caller of this block
        // gets pool-scoped exclusion without route code knowing it exists.
        settleLock: deps.spotter.settleLock ?? livePoolSettleLock(),
      },
      {
        poolId: input.poolId,
        goalId: input.goalId,
        participant: input.participant,
      },
    );

    if (outcome.status === "not-due") {
      // Queue it for the sweep, scored by the moment it becomes settleable, so
      // the cron reads only claims that are actually due.
      await addPendingSettlement(input.goalId, Number(outcome.periodEnd));
      if (entryOf(ledger, "settle") === undefined) {
        ledger = await appendLedger(input.goalId, {
          kind: "settle",
          status: "deferred",
          periodEndIso: new Date(
            Number(outcome.periodEnd) * 1000 + settleRepollJitterMs(),
          ).toISOString(),
          note: "the pool period is still running; SPOTTER settles the moment it ends",
        });
      }
      return { status: "deferred", ledger };
    }

    if (outcome.status === "busy") {
      // Another claim in this pool is settling it right now. ONE settle() pays
      // every eligible achiever, so racing it would burn gas on a certain
      // revert and stamp a red row on a claim the winner is about to pay. No
      // transaction, no ledger entry: the next poll reads the settled pool and
      // reconciles against AchieverPaid.
      return { status: "deferred", ledger };
    }

    if (outcome.status === "already-settled") {
      // Re-read before declaring anything: the run route and the cron sweep
      // can race each other to the same settle, and the loser must not stamp
      // a spurious failure on a claim the winner just recorded.
      ledger = await readLedger(input.goalId);
      if (
        ledger.some((e) => e.kind === "settle" && e.status === "settled")
      ) {
        await removePendingSettlement(input.goalId);
        return { status: "settled", ledger };
      }
      // ONE settle() pays EVERY eligible achiever in the pool, so another
      // claim's settlement very likely paid this participant too - in a
      // multi-achiever pool it is the guaranteed outcome for everyone after
      // the first claim swept. The AchieverPaid log is the authority;
      // reconcile against it before declaring anything unpayable.
      if (deps.spotter.reader.settledPayout !== undefined) {
        let payout: { txHash: Hex; amount: bigint } | null;
        try {
          payout = await deps.spotter.reader.settledPayout(
            input.poolId,
            input.participant,
          );
        } catch (err) {
          // Unknown is not unpayable: leave the claim retryable. This
          // message differs from SETTLE_UNPAYABLE_MESSAGE on purpose so the
          // sweep's terminal filter does not strand the claim.
          const message = err instanceof Error ? err.message : String(err);
          ledger = await appendErrorOnce(
            input.goalId,
            ledger,
            "settle",
            `the pool is settled but the AchieverPaid reconciliation read failed (${message}); retrying on the next pass`,
          );
          return { status: "error", ledger };
        }
        if (payout !== null && payout.amount > 0n) {
          ledger = await appendLedger(input.goalId, {
            kind: "settle",
            status: "settled",
            txHash: payout.txHash,
            paidUsd: formatUnits(payout.amount, 6),
            note: "the pool settled in one transaction covering every eligible achiever; this participant's AchieverPaid payout is in it",
          });
          await removePendingSettlement(input.goalId);
          return { status: "settled", ledger };
        }
      }
      // The pool settled without paying this participant - settle() is
      // one-shot, so this claim can never pay now. Terminal: drop it from the
      // sweep queue rather than retrying it every two minutes forever.
      ledger = await appendErrorOnce(
        input.goalId,
        ledger,
        "settle",
        SETTLE_UNPAYABLE_MESSAGE,
      );
      await removePendingSettlement(input.goalId);
      return { status: "error", ledger };
    }

    const verification = await chainReadVerification(
      deps,
      input.goalId,
      ledger,
      outcome.txHash,
      input.participant,
    );
    ledger = verification.ledger;
    ledger = await appendLedger(input.goalId, {
      kind: "settle",
      status: "settled",
      txHash: outcome.txHash,
      paidUsd: outcome.participantPaidUsd,
      note: verification.note,
    });
    await removePendingSettlement(input.goalId);
    return { status: "settled", ledger };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ledger = await appendErrorOnce(input.goalId, ledger, "settle", message);
    // Due but unsettled: keep it in the sweep queue so the retry is driven by
    // the cron rather than by whether a browser tab happens to still be open.
    await addPendingSettlement(input.goalId, Math.floor(Date.now() / 1000));
    return { status: "error", ledger };
  }
}

/** Per-claim jitter for the deferred re-poll moment. Random on purpose: the
 *  point is that N tabs on one pool do not converge on one instant. */
function settleRepollJitterMs(): number {
  return Math.floor(Math.random() * SETTLE_REPOLL_JITTER_MS);
}

/**
 * Drive one claim as far as it can go right now. Safe to call repeatedly and
 * safe to call concurrently: the ledger carries the state between polls, and
 * the per-goal lock is what keeps that state from being read stale.
 *
 * A poll that cannot take the lock reports the state the ledger already
 * encodes instead of an error. That is not a fudge - a sibling poll owns the
 * claim and is writing that state right now, so "what the ledger says" is the
 * honest answer, and the browser polls again a second later.
 */
export async function runAgentForGoal(
  deps: RunDeps,
  input: RunInput,
): Promise<RunResult> {
  const outcome = await withLock(
    runLockName(input.goalId),
    RUN_LOCK_TTL_MS,
    () => runClaimUnlocked(deps, input),
  );
  if (outcome.acquired) return outcome.value;
  const ledger = await readLedger(input.goalId);
  return { status: runStatusFromLedger(ledger) ?? "verifying", ledger };
}

async function runClaimUnlocked(
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

  // The cheap read depends on the evidence: documents buy the TEE attester
  // read, wearables buy the Junction summary. Same plan-then-buy shape.
  let cheapQuote: ServiceQuote | null = null;
  const getCheapQuote = async () => {
    cheapQuote ??=
      input.evidenceKind === "wearable"
        ? junctionReadQuote()
        : await deps.buy.quoteAttesterRead();
    return cheapQuote;
  };

  // PLAN - printed before any money moves, cap frozen at plan time. The plan
  // deliberately holds only the cheap read: when an escalation happens, its
  // row prints unplanned, which is the moment the whole submission hangs on.
  // The pool linkage is stored here so the sweep can settle this claim from
  // the ledger alone once the browser stops polling.
  if (entryOf(ledger, "plan") === undefined) {
    const quote = await getCheapQuote();
    ledger = await appendLedger(input.goalId, {
      kind: "plan",
      steps: [
        { service: quote.service, label: quote.label, estUsd: quote.estUsd },
      ],
      capUsd: defaultClaimCapUsd(),
      poolId: input.poolId.toString(),
      participant: input.address,
    });
  }

  // BUY - once per attester job, deduped by (service, attester id) so a
  // re-poll never double-buys. A cap violation aborts the run before the
  // service is consumed. A fail-closed id marks a job the attester never
  // ran - buying a read of it would spend money on nothing, so the skip is
  // recorded once and the claim proceeds straight to the failed verdict.
  if (isFailId(input.attesterId)) {
    const seen = ledger.some(
      (e) =>
        e.kind === "error" &&
        e.stage === "attester" &&
        e.message.includes(input.attesterId),
    );
    if (!seen) {
      ledger = await appendLedger(input.goalId, {
        kind: "error",
        stage: "attester",
        message:
          `attester job ${input.attesterId} never ran - the attester was ` +
          "unreachable or unconfigured when this evidence was submitted. " +
          "SPOTTER is not buying a read of a job that never executed.",
      });
    }
  } else if (
    findSpend(ledger, (await getCheapQuote()).service, input.attesterId) ===
    undefined
  ) {
    const outcome = await attemptPurchase(deps, {
      goalId: input.goalId,
      ledger,
      quote: await getCheapQuote(),
      ref: input.attesterId,
      body: { attesterId: input.attesterId, goalSpec: input.goalSpec },
      walletKey: input.address,
    });
    ledger = outcome.ledger;
    if (!outcome.ok) {
      ledger = await appendErrorOnce(
        input.goalId,
        ledger,
        "buy",
        outcome.message,
      );
      // A guardrail refusing to spend and a purchase blowing up are different
      // things, and the receipt must not call one the other.
      return {
        status: outcome.refusal === "purchase-failed" ? "error" : "cap-exceeded",
        ledger,
      };
    }
  }

  // EVIDENCE - poll the read this claim paid for (or, for a fail-closed id,
  // resolve it to the unverified verdict without touching any service).
  const { status, verdict } = await deps.poll(input.attesterId, input.goalSpec);
  if (status === "verifying" || verdict === null) {
    return { status: "verifying", ledger };
  }

  // VERDICT - keyed to the current attester job. Content-aware on purpose:
  // an attester job's verdict is immutable, but a wearable claim's ref is
  // stable across the pool period while the underlying data moves daily, so
  // a changed verdict is appended fresh and forces a fresh decision below.
  const priorPrimary = verdictWithRef(ledger, input.attesterId);
  const verdictChanged =
    priorPrimary !== undefined &&
    (priorPrimary.verified !== verdict.verified ||
      priorPrimary.confidence !== verdict.confidence ||
      priorPrimary.reason !== verdict.reason);
  if (priorPrimary === undefined || verdictChanged) {
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
    reasonOf(ledger, input.attesterId) === undefined
  ) {
    const quote = await deps.buy.quoteVisionJudge();
    const poolUsd = await deps.spotter.reader
      .poolBalanceUsd?.(input.poolId)
      .catch(() => undefined);
    const escalationLine =
      poolUsd !== undefined
        ? `escalating. i can't read this and i'm not paying out ${poolUsd} USDC on something i can't read.`
        : "escalating. i can't read this and i'm not paying out on something i can't read.";
    const outcome = await attemptPurchase(deps, {
      goalId: input.goalId,
      ledger,
      quote,
      ref: input.attesterId,
      body: {
        attesterId: input.attesterId,
        goalSpec: input.goalSpec,
        verdict: {
          verified: verdict.verified,
          confidence: verdict.confidence,
          reason: verdict.reason,
        },
      },
      walletKey: input.address,
      notePrefix: escalationLine,
    });
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
      if (outcome.refusal !== "plan-cap") {
        // The per-claim cap is already on the receipt (the plan prints it), so
        // hitting it needs no extra row. Every other halt - the daily ceiling,
        // an unreconciled intent - is invisible otherwise, and a spend that
        // stops for a reason nobody can see is a silent failure.
        ledger = await appendErrorOnce(
          input.goalId,
          ledger,
          "buy",
          outcome.message,
        );
      }
    }
  }

  // REASON - Gemini on Vertex via deps.reason, anchored to the deterministic
  // rule and falling back to it loudly. Deadpan on purpose. The guardrail
  // below is not the model's to negotiate: a decision can veto a payout but
  // never mint one without a verified verdict behind it. Decided once per
  // attester job; a changed verdict for the same job re-decides - UNLESS the
  // decision was already consummated on-chain (a record entry exists). The
  // on-chain writes are one-shot, so re-deciding a recorded claim (say, a
  // wearable poll that failed transiently after the payout was earned) would
  // print a no-pay the chain can no longer honor.
  const alreadyRecorded = entryOf(ledger, "record") !== undefined;
  let reason =
    verdictChanged && !alreadyRecorded
      ? undefined
      : reasonOf(ledger, input.attesterId);
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
    ledger = await appendLedger(input.goalId, {
      kind: "reason",
      decision,
      note,
      ref: input.attesterId,
    });
    reason = reasonOf(ledger, input.attesterId);
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
          // Already on chain is the end state we wanted; anything else throws.
          // Same matcher the SPOTTER path uses, so both decode reverts alike.
          if (revertKind(err) !== "already-recorded") throw err;
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
        status: revertKind(err) === "not-participant" ? "blocked" : "error",
        ledger,
      };
    }
  }

  // SETTLE WHEN SETTLEABLE - SPOTTER pays from its own wallet the moment the
  // pool period allows it, through the same block the sweep route drives.
  // Called unlocked on purpose: this run already holds the per-goal lock, and
  // the lock is not reentrant.
  const outcome = await settleClaimUnlocked(deps, {
    goalId: input.goalId,
    poolId: input.poolId,
    participant: input.address,
  });
  if (outcome.status === "settled") {
    return { status: "paid", ledger: outcome.ledger };
  }
  if (outcome.status === "deferred") {
    return { status: "recorded", ledger: outcome.ledger };
  }
  return { status: "error", ledger: outcome.ledger };
}
