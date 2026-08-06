// POST /api/blink/sign
//   (file path: app/app/api/blink/sign/route.ts -> route /api/blink/sign)
//
// Server-side signer for the Blink "For Apps" deposit SDK (@swype-org/deposit).
// The Web SDK cannot hold the merchant signing key, so on every requestDeposit
// it POSTs the deposit request to this endpoint and expects a signed payload
// back. Blink verifies the signature against the merchant's registered public
// key before pulling USDC, so this route is the trust anchor for the whole
// one-tap top-up flow.
//
// NO IN-REPO CALLER. The browser widget that pointed the SDK's `signer` at
// this path was never mounted on any page and has been removed. The route is
// left standing because it is a money endpoint and deleting it is a call for
// the repo owner, not a dead-code sweep. Anything reaching it now is external.
// Its limits below are what make that survivable; do not relax them.
//
// CONTRACT (confirmed from docs.blink.cash integration/signer-endpoint):
//
//   Request JSON the SDK POSTs to us:
//     { amount: number, chainId: number, address: string, token: string,
//       callbackScheme: string | null, url: string, version: string,
//       reference?: string, metadata?: Record<string, string> }
//     `callbackScheme` is null for web. We echo the request values into the
//     signed payload rather than trusting any other source.
//
//   Signed payload object (EXACT field order — order is part of the signed
//   bytes, so it must not change):
//     { amount, chainId, address, token, idempotencyKey, callbackScheme,
//       signatureTimestamp, version }
//     - idempotencyKey: fresh UUID v4 minted here
//     - signatureTimestamp: ISO 8601 (Blink enforces a 15-minute max age)
//     - merchantId is NOT part of the signed payload; it travels in the
//       response only.
//
//   Signing (the #1 documented integration bug is signing the raw JSON):
//     1. payload = base64url(JSON.stringify(payloadObject))
//     2. signature = base64url( ECDSA-P256-SHA256.sign(payload) )
//        i.e. sign the base64url-ENCODED payload STRING, not the raw JSON.
//
//   Response JSON the SDK expects:
//     { merchantId: string, payload: string, signature: string,
//       preview: { amount, chainId, address, token, idempotencyKey } }
//
//   On any validation failure: HTTP 400 { error: string }. Never crash.
//
// WHY THE LIMITS (added when this repo went public):
//   The Blink Web SDK cannot hold the merchant key, so this endpoint is
//   unauthenticated by design: anybody can POST to it and get back a payload
//   signed with the merchant key. That is only safe if a signed payload is
//   worthless to whoever obtains it, so the route now refuses to sign anything
//   except a deposit INTO our own merchant address, in our own token, on Base
//   Sepolia, under a hard amount ceiling. Before this it would sign an
//   arbitrary amount to an arbitrary destination on an arbitrary chain, which
//   turned the merchant key into a general-purpose authorization oracle.
//   The limits and their tests live in app/lib/money-guards.ts.
//
// ENV (server-only — never NEXT_PUBLIC):
//   BLINK_MERCHANT_ADDRESS      Base Sepolia address that receives deposits.
//                               The ONLY destination this route will sign for.
//                               Falls back to NEXT_PUBLIC_BLINK_MERCHANT_ADDRESS
//                               (the client copy of the same value).
//   NEXT_PUBLIC_BLINK_USDC_ADDRESS
//                               Base Sepolia USDC token address. The ONLY
//                               token this route will sign for. Public by
//                               nature (the browser needs it to build the
//                               deposit), read here as an allowlist.
//   BLINK_MERCHANT_PRIVATE_KEY  PEM PKCS8 ECDSA P-256 (prime256v1 / secp256r1)
//                               private key. Generate during Blink sandbox
//                               merchant registration with:
//                                 openssl ecparam -name prime256v1 -genkey \
//                                   -noout -out blink_ec.pem
//                                 openssl pkcs8 -topk8 -nocrypt \
//                                   -in blink_ec.pem -out blink_merchant_pkcs8.pem
//                               Register the matching public key with Blink:
//                                 openssl ec -in blink_ec.pem -pubout \
//                                   -out blink_merchant_pub.pem
//                               Store the PKCS8 PEM in env. Multi-line PEMs may
//                               be supplied with literal "\n" escapes; this
//                               route normalizes them back to newlines.
//   BLINK_MERCHANT_ID           Merchant UUID issued at Blink registration.
//                               Returned to the SDK; not part of signed bytes.

import { createSign, randomUUID } from "node:crypto";
import { optionalEnv, requireEnv } from "@/lib/server/env";
import { jsonError, readJsonBody } from "@/lib/server/http";
import {
  checkBlinkDeposit,
  serverFailure,
  type BlinkDepositLimits,
} from "@/lib/money-guards";

// node:crypto + PEM key signing requires the Node.js runtime; the Edge runtime
// cannot run createSign over a PEM key.
export const runtime = "nodejs";

// ----------------------------------------------------------------- request shape

interface BlinkSignRequest {
  amount: number;
  chainId: number;
  address: string;
  token: string;
  callbackScheme: string | null;
  url: string;
  version: string;
}

// The signed payload, in the exact field order Blink hashes over. Reordering
// these keys changes the signed bytes and breaks verification.
interface BlinkSignedPayload {
  amount: number;
  chainId: number;
  address: string;
  token: string;
  idempotencyKey: string;
  callbackScheme: string | null;
  signatureTimestamp: string;
  version: string;
}

interface BlinkSignResponse {
  merchantId: string;
  payload: string;
  signature: string;
  preview: {
    amount: number;
    chainId: number;
    address: string;
    token: string;
    idempotencyKey: string;
  };
}

// ------------------------------------------------------------------- validation

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const SCOPE = "api/blink/sign";

/**
 * The single destination and token this route will ever sign for. Resolved per
 * request so a config change does not need a redeploy, and so a missing value
 * is a loud 500 rather than an accidentally permissive signer.
 */
function depositLimits(): BlinkDepositLimits {
  const merchantAddress = optionalEnv(
    "BLINK_MERCHANT_ADDRESS",
    optionalEnv("NEXT_PUBLIC_BLINK_MERCHANT_ADDRESS", ""),
  );
  if (!HEX_ADDRESS.test(merchantAddress)) {
    throw new Error(
      "Missing or malformed BLINK_MERCHANT_ADDRESS. The signer refuses to run without a pinned destination.",
    );
  }
  const tokenAddress = requireEnv("NEXT_PUBLIC_BLINK_USDC_ADDRESS");
  if (!HEX_ADDRESS.test(tokenAddress)) {
    throw new Error(
      "Malformed NEXT_PUBLIC_BLINK_USDC_ADDRESS. The signer refuses to run without a pinned token.",
    );
  }
  return { merchantAddress, tokenAddress };
}

/**
 * Validate and narrow the SDK-supplied body into a BlinkSignRequest. Throws a
 * plain Error (caught by POST) on any malformed field so the route answers 400
 * with a precise reason instead of signing garbage.
 */
function parseSignRequest(body: Record<string, unknown>): BlinkSignRequest {
  const { amount, chainId, address, token, callbackScheme, url, version } = body;

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount must be a positive number");
  }
  if (
    typeof chainId !== "number" ||
    !Number.isInteger(chainId) ||
    chainId <= 0
  ) {
    throw new Error("chainId must be a positive integer");
  }
  if (typeof address !== "string" || !HEX_ADDRESS.test(address)) {
    throw new Error("address must be a valid 0x-prefixed 20-byte address");
  }
  if (typeof token !== "string" || !HEX_ADDRESS.test(token)) {
    throw new Error("token must be a valid 0x-prefixed 20-byte address");
  }
  // Web deposits send null; native flows may send a scheme string.
  if (callbackScheme !== null && typeof callbackScheme !== "string") {
    throw new Error("callbackScheme must be a string or null");
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("url must be a non-empty string");
  }
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("version must be a non-empty string");
  }

  return {
    amount,
    chainId,
    address,
    token,
    callbackScheme,
    url,
    version,
  };
}

// --------------------------------------------------------------------- signing

/**
 * Normalize a PEM that may arrive with literal "\n" escapes (common when a
 * multi-line key is stored in a single-line env var) back into real newlines.
 */
function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

/**
 * Build the canonical signed payload, base64url-encode it, then ECDSA-P256-
 * SHA256-sign the ENCODED STRING (not the raw JSON — that is the documented
 * #1 integration bug). Returns the base64url payload and base64url signature.
 */
function signPayload(
  payloadObject: BlinkSignedPayload,
  privateKeyPem: string,
): { payload: string; signature: string } {
  // Field order is fixed by the interface literal below, so the serialized JSON
  // is deterministic for a given input.
  const payload = Buffer.from(
    JSON.stringify(payloadObject),
    "utf8",
  ).toString("base64url");

  const signer = createSign("SHA256");
  signer.update(payload);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");

  return { payload, signature };
}

// ---------------------------------------------------------------------- handler

export async function POST(request: Request): Promise<Response> {
  try {
    // Read merchant config first so a misconfigured deployment fails as a 500
    // with the missing variable name rather than signing with a bad key.
    let privateKeyPem: string;
    let merchantId: string;
    let limits: BlinkDepositLimits;
    try {
      privateKeyPem = normalizePem(requireEnv("BLINK_MERCHANT_PRIVATE_KEY"));
      merchantId = requireEnv("BLINK_MERCHANT_ID");
      limits = depositLimits();
    } catch (err) {
      // The message names env vars, so it goes to the log, not to the caller.
      return serverFailure(SCOPE, err, {
        message: "The deposit signer is not configured.",
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Body must be a JSON object.");
    }

    let req: BlinkSignRequest;
    try {
      req = parseSignRequest(body);
    } catch (err) {
      // Shape errors are the caller's own input, safe to echo back.
      return jsonError(
        400,
        err instanceof Error ? err.message : "Malformed deposit request",
      );
    }

    // Refuse anything the merchant key must not authorize. A signed payload is
    // then only ever good for depositing into our own merchant address.
    const violation = checkBlinkDeposit(req, limits);
    if (violation !== null) {
      return jsonError(400, violation);
    }

    const idempotencyKey = randomUUID();
    const signatureTimestamp = new Date().toISOString();

    // Echo the request values into the signed payload in the exact documented
    // field order. Do not pull from any other source.
    const payloadObject: BlinkSignedPayload = {
      amount: req.amount,
      chainId: req.chainId,
      address: req.address,
      token: req.token,
      idempotencyKey,
      callbackScheme: req.callbackScheme,
      signatureTimestamp,
      version: req.version,
    };

    let signed: { payload: string; signature: string };
    try {
      signed = signPayload(payloadObject, privateKeyPem);
    } catch (err) {
      // A bad PEM or unsupported key curve surfaces here. This is a server
      // configuration fault, not bad client input, and the message would
      // describe our key material.
      return serverFailure(SCOPE, err, {
        message: "Could not sign the deposit payload.",
      });
    }

    const response: BlinkSignResponse = {
      merchantId,
      payload: signed.payload,
      signature: signed.signature,
      preview: {
        amount: req.amount,
        chainId: req.chainId,
        address: req.address,
        token: req.token,
        idempotencyKey,
      },
    };

    return Response.json(response);
  } catch (err) {
    // Last-resort guard — the signer must never crash the request.
    return serverFailure(SCOPE, err);
  }
}
