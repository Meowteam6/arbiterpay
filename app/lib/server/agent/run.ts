// SPOTTER's run loop for one claim: plan, buy, read the attester, decide,
// record on-chain, settle when settleable. Every step lands in the ledger
// before anything else happens, and the ledger doubles as the idempotence
// record - the browser polls this run and each poll resumes exactly where the
// last one stopped. Nothing is bought twice, nothing is recorded twice, and
// "paid" is only ever derived from a real AchieverPaid payout.
//
// Two steps are deliberately pluggable behind their current implementations:
// the buy step settles "prepaid" until the x402 marketplace purchase lands
// (build item 4), and the reason step is deterministic until Gemini takes it
// over (build item 5). The control flow they plug into is what this file owns.

import type { Address, Hex } from "viem";
import {
  appendLedger,
  defaultClaimCapUsd,
  findSpend,
  readLedger,
  LedgerInvariantError,
  type LedgerEntry,
} from "@/lib/server/agent/ledger";
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
} from "@/lib/server/judge";
import { VERDICT_FACETS, type RecordVerdictOutcome } from "@/lib/server/verdict";
import { optionalEnv } from "@/lib/server/env";

/** What one attester read costs SPOTTER. Becomes a real x402 price in item 4. */
export const ATTESTER_READ_USD = "0.02";
const ATTESTER_SERVICE = "attester-read";

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

  // PLAN - printed before any money moves, cap frozen at plan time.
  if (entryOf(ledger, "plan") === undefined) {
    ledger = await appendLedger(input.goalId, {
      kind: "plan",
      steps: [
        {
          service: ATTESTER_SERVICE,
          label: "document read (TEE attester)",
          estUsd: ATTESTER_READ_USD,
        },
      ],
      capUsd: defaultClaimCapUsd(),
    });
  }

  // BUY - once per attester job. The cap check lives in the ledger append;
  // a violation aborts the run before the service is consumed.
  if (findSpend(ledger, ATTESTER_SERVICE, input.attesterId) === undefined) {
    try {
      ledger = await appendLedger(input.goalId, {
        kind: "spend",
        service: ATTESTER_SERVICE,
        label: "document read (TEE attester)",
        amountUsd: ATTESTER_READ_USD,
        ref: input.attesterId,
        settlement: "prepaid",
      });
    } catch (err) {
      if (err instanceof LedgerInvariantError) {
        ledger = await appendLedger(input.goalId, {
          kind: "error",
          stage: "buy",
          message: err.message,
        });
        return { status: "cap-exceeded", ledger };
      }
      throw err;
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

  // REASON - deterministic today, Gemini in item 5. Deadpan on purpose.
  let reason = entryOf(ledger, "reason");
  if (reason === undefined) {
    const pay =
      status === "completed" && verdict.verified && verdict.confidence !== "low";
    ledger = await appendLedger(input.goalId, {
      kind: "reason",
      decision: pay ? "pay" : "no-pay",
      note: pay
        ? `verified, ${verdict.confidence} confidence. paying.`
        : `not paying: ${verdict.reason}`,
    });
    reason = entryOf(ledger, "reason");
  }
  if (reason?.decision !== "pay") {
    return { status: "no-pay", ledger };
  }

  // RECORD - both writes (pool result + verdict registry), dispatched to
  // whichever key the chain currently trusts. Recorded exactly once; the
  // ledger entry lands only after BOTH writes are in.
  if (entryOf(ledger, "record") === undefined) {
    const multiplierBps = multiplierForConfidence(verdict.confidence);
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
          confidence: verdict.confidence,
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
          verdict.confidence,
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
