// POST /api/evidence/submit
//   (file path: app/app/api/evidence/submit/route.ts → route /api/evidence/submit)
//
// Step 1 of the document-verified health-goal flow. A participant uploads a
// health document (flu-shot record, lab/cholesterol report, biometric
// screening); we submit it to the Chainlink Confidential AI Attester for
// confidential inference inside a TEE. Inference is asynchronous, so this
// route returns the attester job id immediately; the frontend then drives
// SPOTTER's run loop by polling POST /api/agent/run/<goalId> with it.
//
// WHAT THE CALLER DOES NOT GET TO DECIDE
//
// The goal is read from the chain, never from the body. This route used to
// interpolate the body's `goalSpec` straight into the enclave prompt, which
// meant anyone who paid a pool's entry fee could submit any file under a goal
// of their own writing ("the attached file is a PNG") and collect the
// sponsor's pool at up to a 2x multiplier without doing the goal. The body's
// goalSpec is now accepted for wire compatibility with older clients and
// IGNORED — the pool's on-chain goalSpec is the only value that reaches the
// attester. A mismatch is logged, never honored.
//
// The filename is generated here for the same reason: it travels into the
// enclave request beside the prompt, so a caller-chosen one is a second
// injection channel (and people name files after their diagnosis).
//
// The file itself is validated server-side — size, base64, and magic bytes
// against the declared content type. The browser's checks are a courtesy to
// the person uploading; these are the rule.
//
// The attester job id this route returns is recorded against (poolId,
// address) before it is handed out. The run route pays on whatever verdict a
// job returns, and everyone in a pool shares its goalSpec, so an
// unattributed job id would let one participant collect on another's
// evidence.
//
// Request JSON:
//   { poolId: number|string, address: string, goalSpec?: string (ignored),
//     fileBase64: string, fileName?: string (ignored), contentType: string }
//   contentType is image/png, image/jpeg, application/pdf, or text/plain.
//
// Response JSON:
//   { attesterId: string }
//   On a missing key or attester error the id is a "fail-<random>" id, which the
//   agent's poll step resolves to an UNVERIFIED verdict that is never recorded — a
//   broken or unconfigured attester can never mint a passing result. Only with
//   DEMO_MODE explicitly on is a "mock-<random>" id returned instead, which does
//   resolve to a verified verdict (local demos only).
//
// Privacy: the document bytes are sent only to the attester for inference. They
// are NOT persisted to disk or chain and are never logged here.

import { isAddress, type Address } from "viem";
import { evidenceTypeOf } from "@/lib/contract";
import {
  checkEvidenceFile,
  goalSpecDiffers,
  loadClaimPool,
  rememberAttesterJob,
  serverEvidenceFileName,
} from "@/lib/server/evidence";
import {
  isSupportedContentType,
  submitInference,
  type SupportedContentType,
} from "@/lib/server/judge";
import {
  errorMessage,
  jsonError,
  newCorrelationId,
  readJsonBody,
  safeError,
} from "@/lib/server/http";
import { participantJoined } from "@/lib/server/pools";
import { computeGoalId } from "@/lib/server/verdict";

export async function POST(request: Request) {
  const cid = newCorrelationId("evidence-submit");
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Request body must be a JSON object.");
    }

    const { poolId, address, fileBase64, contentType } = body;

    // poolId travels as a decimal string (the frontend serializes the bigint).
    if (
      (typeof poolId !== "number" && typeof poolId !== "string") ||
      !/^\d+$/.test(String(poolId))
    ) {
      return jsonError(400, "poolId must be a non-negative integer");
    }
    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    if (typeof fileBase64 !== "string" || fileBase64.trim() === "") {
      return jsonError(400, "fileBase64 must be a non-empty base64 string");
    }
    if (
      typeof contentType !== "string" ||
      !isSupportedContentType(contentType)
    ) {
      return jsonError(
        400,
        "contentType must be one of image/png, image/jpeg, application/pdf, text/plain",
      );
    }

    // The file is judged first: these checks are pure and cost nothing, so a
    // junk payload never reaches the chain reads below, let alone the enclave.
    const check = checkEvidenceFile(fileBase64, contentType);
    if (!check.ok) {
      return jsonError(400, check.message);
    }

    // The chain decides what this claim is about. Everything below judges the
    // upload against the pool's own goal, not the caller's description of it.
    const pool = await loadClaimPool(BigInt(poolId));
    if (pool === null) {
      return jsonError(400, "That pool does not exist.");
    }

    if (evidenceTypeOf(pool.goalSpec) !== "document") {
      return jsonError(
        400,
        "That pool is not verified by document upload. Nothing was submitted.",
      );
    }
    if (pool.settled) {
      return jsonError(
        409,
        "That pool has already settled. Nothing was submitted.",
      );
    }

    // Membership gate before the enclave is touched: TEE inference costs real
    // money, and only the wallet holding this pool's one-wallet-one-entry slot
    // can ever be paid from it.
    if (!(await participantJoined(BigInt(poolId), address as Address))) {
      return jsonError(
        403,
        "Join this pool before submitting a record for it.",
      );
    }

    // Logged only for a caller who got this far: the supplied text is
    // untrusted, and a stranger must not be able to write lines into the log.
    goalSpecDiffers("evidence-submit", body.goalSpec, pool.goalSpec);

    // Bind the enclave signature to this claim's goalId (Tier C). Derived from
    // the contract, the single source of truth, so it matches the run route's
    // path goalId exactly. A read failure here is non-fatal: pass undefined and
    // the shim signs against the zero goal (verification is skipped unless a
    // signer is pinned AND a goalId is bound).
    let goalId: string | undefined;
    try {
      goalId = await computeGoalId(BigInt(poolId), address as Address);
    } catch (err) {
      console.warn(
        `[${cid}] could not derive goalId for the enclave signature binding: ${errorMessage(err)}`,
      );
    }

    // submitInference never throws: on a missing key or attester error it
    // returns a fail id (or, with DEMO_MODE on, a mock id) and logs loudly.
    const attesterId = await submitInference(
      pool.goalSpec,
      fileBase64,
      serverEvidenceFileName(contentType as SupportedContentType),
      contentType as SupportedContentType,
      goalId,
    );

    // The job belongs to this claim and no other. Written before the id is
    // handed out, so the run route can never see a job it cannot attribute.
    try {
      await rememberAttesterJob(attesterId, BigInt(poolId), address as Address);
    } catch (err) {
      // The inference is already running, but an unattributable job is one
      // the run route will refuse. Say so instead of returning a dead id.
      console.error(
        `[${cid}] attester job ${attesterId} could not be linked to pool ` +
          `${poolId}: ${errorMessage(err)}`,
        err,
      );
      return jsonError(
        503,
        "Verification started but could not be linked to your claim. Nothing was recorded. Please submit again.",
      );
    }

    return Response.json({ attesterId });
  } catch (err) {
    // Last-resort guard — the route must never crash, and must never hand the
    // caller the underlying failure text.
    return jsonError(500, safeError(err, cid));
  }
}
