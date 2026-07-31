// POST /api/agent/run/[goalId] - drive SPOTTER's run loop for one claim.
// GET  /api/agent/run/[goalId] - read the claim's ledger (AgentReceipt data).
//
// The browser polls POST after submitting evidence; each poll resumes the run
// wherever it stopped (the ledger carries the state). Unauthenticated like
// /api/evidence/result and safe for the same reasons: every step is
// idempotent, spends are deduped by attester job and capped per claim, and
// the on-chain writes are gated by the attester verdict, not by the caller.
//
// The path goalId MUST equal the on-chain computeGoalId(poolId, address) -
// otherwise one claim's evidence could be run under another claim's ledger.
//
// Request JSON:
//   { attesterId?, poolId, address, goalSpec, evidenceKind? = "document" }
// Document claims require attesterId (the TEE inference job). Wearable claims
// must NOT send one: the evidence is the pool-period Junction summary, so the
// server synthesizes the ref `wearable-${periodStart}` from the chain itself -
// a caller-supplied ref could split one claim across two ledger keys.
// Response JSON: { status, ledger } (see RunStatus in agent/run.ts)

import { isAddress, type Address, type Hex } from "viem";
import { runAgentForGoal, type RunDeps } from "@/lib/server/agent/run";
import { readLedger } from "@/lib/server/agent/ledger";
import { getCircleClient } from "@/lib/server/agent/wallet";
import { arcReader, type ArcReader } from "@/lib/server/agent/spotter";
import { liveBuyDeps } from "@/lib/server/agent/x402";
import { geminiReason } from "@/lib/server/agent/reason";
import { wearableEvidenceSource } from "@/lib/server/agent/wearable";
import { pollInference, type PollResult } from "@/lib/server/judge";
import { recordResult } from "@/lib/server/oracle";
import { computeGoalId, recordVerdict } from "@/lib/server/verdict";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

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
  try {
    const { goalId } = await ctx.params;
    if (!GOAL_ID_RE.test(goalId)) {
      return jsonError(400, "goalId must be a 0x-prefixed bytes32 hex string");
    }
    return Response.json({ ledger: await readLedger(goalId) });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}

export async function POST(request: Request, ctx: Ctx) {
  try {
    const { goalId } = await ctx.params;
    if (!GOAL_ID_RE.test(goalId)) {
      return jsonError(400, "goalId must be a 0x-prefixed bytes32 hex string");
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { poolId, address, goalSpec } = body;
    if (
      (typeof poolId !== "number" && typeof poolId !== "string") ||
      !/^\d+$/.test(String(poolId))
    ) {
      return jsonError(400, "poolId must be a non-negative integer");
    }
    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    if (typeof goalSpec !== "string" || goalSpec.trim() === "") {
      return jsonError(400, "goalSpec must be a non-empty string");
    }
    const evidenceKind = (body.evidenceKind ?? "document") as EvidenceKind;
    if (!EVIDENCE_KINDS.includes(evidenceKind)) {
      return jsonError(
        400,
        `evidenceKind must be one of: ${EVIDENCE_KINDS.join(", ")}`,
      );
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
    const derived = await computeGoalId(BigInt(poolId), address as Address);
    if (derived.toLowerCase() !== goalId.toLowerCase()) {
      return jsonError(
        400,
        `goalId mismatch: the chain derives ${derived} for pool ${poolId} and ${address}`,
      );
    }

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
    // Last-resort guard - the route must never crash.
    return jsonError(500, errorMessage(err));
  }
}
