// POST /api/agent/run/[goalId] - drive SPOTTER's run loop for one claim.
// GET  /api/agent/run/[goalId] - read the claim: money facts for anyone, the
//      full ledger for the wallet that owns it.
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
// Response JSON: { status, claim, hasLedger, ledger } - status is the
// RunStatus in agent/run.ts; ledger is non-null only for a proven owner (see
// below). GET answers the same minus `status`.
//
// WHO SEES THE LEDGER
//
// The full ledger carries model-authored prose about someone's medical
// document - verdict reasons, decision notes, the goal text itself - and
// /api/agent/feed hands out the goal ids needed to ask for it. A goalId is
// therefore not a credential, and neither is an address in the body: both are
// public. Ownership is proven by an EIP-191 signature over the wallet-auth
// message (lib/server/wallet-auth.ts).
//
// Both verbs answer the same way (lib/server/agent/claim-access.ts):
//   - a caller who proves control of the claim's participant address gets the
//     full ledger, which is what makes a returning user's receipt come back;
//   - everyone else gets the redacted projection the public feed serves -
//     money facts and machine states, no prose.
// The redaction is never a reason to refuse the request: an unsigned caller
// still learns whether a claim exists, so the UI can say "sign to see this
// claim" instead of showing a blank upload box over work already done.
//
// The signature does NOT gate the run itself. The loop stays idempotent,
// spend-capped and verdict-gated, so a missing signature costs the caller
// visibility, never money.

import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  claimModalityFor,
  MODALITIES,
  proofPolicyOf,
  type Modality,
} from "@/lib/contract";
import { runAgentForGoal, type RunDeps } from "@/lib/server/agent/run";
import { readLedger, type LedgerEntry } from "@/lib/server/agent/ledger";
import {
  claimParticipantOf,
  isClaimOwner,
  projectClaimForCaller,
  type ClaimAccess,
} from "@/lib/server/agent/claim-access";
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
import { authenticateWallet } from "@/lib/server/wallet-auth";

// A run can hold a Circle transaction poll plus two RPC inclusion waits;
// Vercel's default function window cuts that off mid-settlement.
export const maxDuration = 60;

const GOAL_ID_RE = /^0x[0-9a-fA-F]{64}$/;

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

/**
 * Fallback ownership proof for ledgers written before the plan entry carried
 * its participant: the chain derives goalId from (poolId, participant), so a
 * signer whose address hashes to THIS goal id under the caller's poolId is
 * this claim's participant. The poolId is untrusted input and needs to be -
 * getting it wrong only fails the comparison. An RPC failure fails closed.
 */
async function ownsGoalOnChain(
  request: Request,
  goalId: string,
  signer: Address,
): Promise<"yes" | "no" | "unknown"> {
  const poolId = new URL(request.url).searchParams.get("poolId");
  if (poolId === null || !/^\d+$/.test(poolId)) return "unknown";
  try {
    const derived = await computeGoalId(BigInt(poolId), signer);
    return derived.toLowerCase() === goalId.toLowerCase() ? "yes" : "no";
  } catch (err) {
    // A dead RPC withholds the ledger, as it must - but it is NOT evidence
    // that the caller is somebody else, and the copy downstream depends on
    // that difference.
    console.error("[agent-run] chain ownership check failed", err);
    return "unknown";
  }
}

/** How the caller was classified for a GET. The ledger's own record of its
 *  participant is preferred; the chain is asked only for ledgers written
 *  before that field existed. */
async function accessForGet(
  request: Request,
  goalId: string,
  ledger: LedgerEntry[],
  viewer: Address | null,
): Promise<ClaimAccess> {
  if (isClaimOwner(ledger, viewer)) return "owner";
  if (viewer === null) return "unproven";
  if (claimParticipantOf(ledger) !== null) return "not-owner";
  if (ledger.length === 0) return "unproven";
  const onChain = await ownsGoalOnChain(request, goalId, viewer);
  if (onChain === "yes") return "owner";
  return onChain === "no" ? "not-owner" : "unproven";
}

export async function GET(request: Request, ctx: Ctx) {
  const cid = newCorrelationId("agent-run-get");
  try {
    const { goalId } = await ctx.params;
    if (!GOAL_ID_RE.test(goalId)) {
      return jsonError(400, "goalId must be a 0x-prefixed bytes32 hex string");
    }
    const ledger = await readLedger(goalId);

    // An unsigned or invalid-signature caller is not an error here: they get
    // the redacted view, exactly as before this route learned about owners.
    const auth = await authenticateWallet(request);
    const viewer = auth.ok ? auth.address : null;
    const access = await accessForGet(request, goalId, ledger, viewer);

    // An empty ledger projects to a claim with nothing in it, which is
    // exactly what an unknown goal is.
    return Response.json(projectClaimForCaller({ goalId, ledger, access }));
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
    const policy = proofPolicyOf(goalSpec);

    // The modality this claim runs under, enforcing the pool's accepted set. A
    // caller may request one of the accepted modalities (the hybrid opt-in
    // surfaces do); absent a request the pool's floor is used. A modality the
    // pool does NOT accept is refused here, server-side, before any spend —
    // never merely hidden in the UI.
    const requested =
      body.evidenceKind === undefined ? undefined : String(body.evidenceKind);
    const resolved = claimModalityFor(policy, requested);
    if (!resolved.ok) {
      return resolved.reason === "invalid"
        ? jsonError(400, `evidenceKind must be one of: ${MODALITIES.join(", ")}`)
        : jsonError(
            400,
            `this pool accepts ${policy.accepted.join(", ")} evidence, not ${requested}`,
          );
    }
    const evidenceKind: Modality = resolved.modality;

    // Document and self-reported are both upload-routed: a file goes to the TEE
    // attester and the claim carries that job id. Wearable reads the pool-period
    // Junction summary instead and takes no attester job.
    const uploadRouted =
      evidenceKind === "document" || evidenceKind === "self-reported";
    if (uploadRouted) {
      if (
        typeof body.attesterId !== "string" ||
        body.attesterId.trim() === ""
      ) {
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
      // Bind the path goalId (which equals the on-chain computeGoalId) into the
      // poll so the Tier C enclave-signature check verifies the verdict was
      // signed for THIS claim. No injectable-signature change: the closure
      // carries goalId, the rest of the run loop is untouched.
      poll = (aid, spec) => pollInference(aid, spec, goalId);
    }

    // Ownership for the RESPONSE only, never for the run. The derived-goalId
    // check above already proved this goal belongs to (poolId, address), so a
    // signature over that same address proves the caller is its participant.
    // Verified before the run so a run that throws cannot skip it. A valid
    // signature for a DIFFERENT wallet is reported as such, so the browser can
    // say "wrong wallet" without having to guess it from a missing ledger.
    const auth = await authenticateWallet(request);
    const access: ClaimAccess = !auth.ok
      ? "unproven"
      : auth.address === getAddress(address)
        ? "owner"
        : "not-owner";

    const result = await runAgentForGoal(liveDeps(reader, poll), {
      goalId: goalId as Hex,
      poolId: BigInt(poolId),
      address: address as Address,
      goalSpec,
      attesterId,
      evidenceKind,
    });
    return Response.json({
      status: result.status,
      ...projectClaimForCaller({ goalId, ledger: result.ledger, access }),
    });
  } catch (err) {
    // Last-resort guard - the route must never crash, and must never hand the
    // caller the underlying failure text.
    return jsonError(500, safeError(err, cid));
  }
}
