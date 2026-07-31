// POST /api/evidence/submit
//   (file path: app/app/api/evidence/submit/route.ts → route /api/evidence/submit)
//
// Step 1 of the document-verified health-goal flow. A participant uploads a
// health document (flu-shot record, lab/cholesterol report, biometric screening);
// we submit it to the Chainlink Confidential AI Attester for confidential
// inference inside a TEE. Inference is asynchronous, so this route returns the
// attester job id immediately; the frontend then drives SPOTTER's run loop by
// polling POST /api/agent/run/<goalId> with it.
//
// Request JSON:
//   { poolId: number|string, address: string, goalSpec: string,
//     fileBase64: string, fileName: string, contentType: string }
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

import { isAddress } from "viem";
import {
  isSupportedContentType,
  submitInference,
  type SupportedContentType,
} from "@/lib/server/judge";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { poolId, address, goalSpec, fileBase64, fileName, contentType } =
      body;

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
    if (typeof goalSpec !== "string" || goalSpec.trim() === "") {
      return jsonError(400, "goalSpec must be a non-empty string");
    }
    if (typeof fileBase64 !== "string" || fileBase64.trim() === "") {
      return jsonError(400, "fileBase64 must be a non-empty base64 string");
    }
    if (typeof fileName !== "string" || fileName.trim() === "") {
      return jsonError(400, "fileName must be a non-empty string");
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

    // submitInference never throws: on a missing key or attester error it
    // returns a fail id (or, with DEMO_MODE on, a mock id) and logs loudly.
    const attesterId = await submitInference(
      goalSpec,
      fileBase64,
      fileName,
      contentType as SupportedContentType,
    );

    return Response.json({ attesterId });
  } catch (err) {
    // Last-resort guard — the route must never crash.
    return jsonError(500, errorMessage(err));
  }
}
