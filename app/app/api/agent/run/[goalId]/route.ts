// POST /api/agent/run/[goalId] - drive SPOTTER's run loop for one claim.
// GET  /api/agent/run/[goalId] - read the claim's public money facts.
//
// The browser polls POST after submitting evidence; each poll resumes the run
// wherever it stopped (the ledger carries the state). Unauthenticated by
// design and safe because every step is idempotent, spends are deduped by
// attester job and capped per claim, and the on-chain writes are gated by the
// attester verdict, not by the caller.
//
// WHAT THE CALLER DOES NOT GET TO DECIDE
//
// The goal comes from the chain. `goalSpec` in the body used to be taken on
// trust and handed to the verification step, so a caller could describe the
// goal as something their evidence trivially satisfies and drain a sponsor's
// pool without doing it. The body's value is accepted for wire compatibility
// and IGNORED; the pool's on-chain goalSpec is what the run loop judges.
//
// The evidence kind comes from the chain too (the "[doc]" marker on the
// pool's goalSpec), so a document pool cannot be claimed with wearable data
// or the reverse. A body that disagrees is rejected rather than obeyed.
//
// The path goalId MUST equal the on-chain computeGoalId(poolId, address) -
// otherwise one claim's evidence could be run under another claim's ledger -
// and the address MUST hold the pool's one-wallet-one-entry slot. Both are
// checked before the plan entry lands, so a stranger's request never causes
// SPOTTER to spend anything.
//
// A document claim's attesterId must also be a job THIS claim submitted
// (evidence.ts records the owner at submit time). Everyone in a pool shares
// its goalSpec, so a job id that leaked between two participants would
// otherwise let one collect on the other's evidence.
//
// Request JSON:
//   { attesterId?, poolId, address, goalSpec? (ignored), evidenceKind? }
// Document claims require attesterId (the TEE inference job). Wearable claims
// must NOT send one: the evidence is the pool-period Junction summary, so the
// server synthesizes the ref `wearable-${periodStart}` from the chain itself -
// a caller-supplied ref could split one claim across two ledger keys.
// Response JSON: { status, ledger } (see RunStatus in agent/run.ts)
//
// GET is the read side, and it is redacted. The full ledger carries
// model-authored prose about someone's medical document - verdict reasons,
// decision notes, the goal text itself - and this endpoint is unauthenticated
// while /api/agent/feed hands out goal ids. It returns the same public
// projection the feed does: money facts and machine states only.

import { isAddress, type Address, type Hex } from "viem";
import { evidenceTypeOf } from "@/lib/contract";
import { runAgentForGoal, type RunDeps } from "@/lib/server/agent/run";
import { readLedger } from "@/lib/server/agent/ledger";
import { toPublicFeedClaim } from "@/lib/server/agent/feed-view";
import { getCircleClient } from "@/lib/server/agent/wallet";
import { arcReader, type ArcReader } from "@/lib/server/agent/spotter";
import { liveBuyDeps } from "@/lib/server/agent/x402";
import { geminiReason } from "@/lib/server/agent/reason";
import { wearableEvidenceSource } from "@/lib/server/agent/wearable";
import {
  attesterJobIsForClaim,
  goalSpecDiffers,
  loadClaimPool,
} from "@/lib/server/evidence";
import { pollInference, type PollResult } from "@/lib/server/judge";
import { participantJoined } from "@/lib/server/pools";
import { recordResult } from "@/lib/server/oracle";
import { computeGoalId, recordVerdict } from "@/lib/server/verdict";
import {
  jsonError,
  newCorrelationId,
  readJsonBody,
  safeError,
} from "@/lib/server/http";

// A run can hold a Circle transaction poll plus two RPC inclusion waits;
// Vercel's default function window cuts that off mid-settlement.
export const maxDuration = 60;

const GOAL_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const EVIDENCE_KINDS = ["document", "wearable"] as const;
type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

function liveDeps(
  reader: ArcReader,
  poll: (attesterId: string, goalSpec: string) => Promise<PollResult>,
): RunDeps {
  return {
    spotter: { circle: getCircleClient(), reader },
    buy: liveBuyDeps(),
    reason: geminiReason,
    poll,
    legacyRecordResult: recordResult,
    legacyRecordVerdict: recordVerdict,
  };
}

type Ctx = { params: Promise<{ goalId: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  const cid = newCorrelationId("agent-run-get");
  try {
    const { goalId } = await ctx.params;
    if (!GOAL_ID_RE.test(goalId)) {
      return jsonError(400, "goalId must be a 0x-prefixed bytes32 hex string");
    }
    const ledger = await readLedger(goalId);
    // Same redaction the public feed applies. An empty ledger projects to a
    // claim with nothing in it, which is exactly what an unknown goal is.
    return Response.json({
      claim: toPublicFeedClaim(goalId, ledger[0]?.at ?? "", ledger),
    });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}

export async function POST(request: Request, ctx: Ctx) {
  const cid = newCorrelationId("agent-run");
  try {
    const { goalId } = await ctx.params;
    if (!GOAL_ID_RE.test(goalId)) {
      return jsonError(400, "goalId must be a 0x-prefixed bytes32 hex string");
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Request body must be a JSON object.");
    }

    const { poolId, address } = body;
    if (
      (typeof poolId !== "number" && typeof poolId !== "string") ||
      !/^\d+$/.test(String(poolId))
    ) {
      return jsonError(400, "poolId must be a non-negative integer");
    }
    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }

    // The pool is the authority on the goal and on how it is verified.
    const pool = await loadClaimPool(BigInt(poolId));
    if (pool === null) {
      return jsonError(400, "That pool does not exist.");
    }
    const goalSpec = pool.goalSpec;
    const evidenceKind: EvidenceKind = evidenceTypeOf(goalSpec);

    if (body.evidenceKind !== undefined) {
      if (
        typeof body.evidenceKind !== "string" ||
        !EVIDENCE_KINDS.includes(body.evidenceKind as EvidenceKind)
      ) {
        return jsonError(
          400,
          `evidenceKind must be one of: ${EVIDENCE_KINDS.join(", ")}`,
        );
      }
      if (body.evidenceKind !== evidenceKind) {
        return jsonError(
          400,
          `this pool is verified by ${evidenceKind} evidence`,
        );
      }
    }

    if (evidenceKind === "document") {
      if (typeof body.attesterId !== "string" || body.attesterId.trim() === "") {
        return jsonError(400, "attesterId must be a non-empty string");
      }
    } else if (body.attesterId !== undefined) {
      return jsonError(
        400,
        "wearable claims take no attesterId; the server derives the ref from the pool period",
      );
    }

    // Integrity: the ledger key must be the goal the chain derives for this
    // (pool, participant) pair, not whatever the caller typed into the URL.
    // The correct id is deliberately NOT echoed back - a mismatch is either a
    // stale client or someone probing, and neither needs the answer.
    const derived = await computeGoalId(BigInt(poolId), address as Address);
    if (derived.toLowerCase() !== goalId.toLowerCase()) {
      return jsonError(
        400,
        `goalId does not match pool ${poolId} for that address`,
      );
    }

    // Membership gate, before the plan entry and therefore before any spend:
    // only the wallet holding this pool's one-wallet-one-entry slot can be
    // paid from it, so running the loop for anyone else buys verification
    // nobody can be paid for.
    if (!(await participantJoined(BigInt(poolId), address as Address))) {
      return jsonError(403, "That address has not joined this pool.");
    }

    // Logged only for a caller who got this far: the supplied text is
    // untrusted, and a stranger must not be able to write lines into the log.
    goalSpecDiffers("agent-run", body.goalSpec, pool.goalSpec);

    const reader = arcReader();
    let attesterId: string;
    let poll: (attesterId: string, goalSpec: string) => Promise<PollResult>;
    if (evidenceKind === "wearable") {
      const state = await reader.getPoolState(BigInt(poolId));
      if (state.periodStart === undefined) {
        return jsonError(
          500,
          `pool ${poolId} has no readable period start on-chain`,
        );
      }
      attesterId = `wearable-${state.periodStart.toString()}`;
      poll = wearableEvidenceSource({
        address: address as Address,
        periodStart: state.periodStart,
        periodEnd: state.periodEnd,
      });
    } else {
      attesterId = body.attesterId as string;
      // Ownership, not just existence: the verdict this job returns is what
      // gets paid out, so it must be the job THIS claim submitted. Two
      // participants in one pool share a goalSpec, so without this check a
      // leaked or shared job id lets one of them collect on the other's
      // evidence. Checked before the poll and before any spend.
      if (
        !(await attesterJobIsForClaim(
          attesterId,
          BigInt(poolId),
          address as Address,
        ))
      ) {
        return jsonError(
          400,
          "That verification job does not belong to this claim. Upload the record for this pool again.",
        );
      }
      poll = pollInference;
    }

    const result = await runAgentForGoal(liveDeps(reader, poll), {
      goalId: goalId as Hex,
      poolId: BigInt(poolId),
      address: address as Address,
      goalSpec,
      attesterId,
      evidenceKind,
    });
    return Response.json(result);
  } catch (err) {
    // Last-resort guard - the route must never crash, and must never hand the
    // caller the underlying failure text.
    return jsonError(500, safeError(err, cid));
  }
}
