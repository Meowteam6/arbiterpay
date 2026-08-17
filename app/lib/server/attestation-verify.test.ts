// Tier C: the app's enclave-signature verifier must accept exactly what the
// shim's signer produces and reject every tampered variant. This builds a
// signature the same way services/confidential-shim/src/signing.ts does, so the
// two stay wire-compatible.

import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { verifyEnclaveVerdict } from "@/lib/server/judge";
import { verdictDigest } from "@/lib/server/verdict";

const GOAL: Hex = `0x${"ab".repeat(32)}`;
const OTHER_GOAL: Hex = `0x${"cd".repeat(32)}`;
const OUTPUT =
  '{"verified": true, "confidence": "high", "reason": "qualifying record present"}';

async function makeEnvelope(
  privateKey: Hex,
  goalId: Hex,
  verified: boolean,
  confidence: 0 | 1 | 2,
  output: string,
) {
  const account = privateKeyToAccount(privateKey);
  const ok = keccak256(toBytes(output));
  const digest = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bool" }, { type: "uint8" }, { type: "bytes32" }],
      [goalId, verified, confidence, ok],
    ),
  );
  const sig = await sign({ hash: digest, privateKey, to: "hex" });
  return {
    alg: "secp256k1-eth",
    v: 2,
    signer: account.address,
    goal_id: goalId,
    verified,
    confidence,
    output_keccak: ok,
    sig,
  };
}

describe("verifyEnclaveVerdict", () => {
  it("accepts a valid signature from the pinned signer", async () => {
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    const env = await makeEnvelope(pk, GOAL, true, 2, OUTPUT);
    expect(await verifyEnclaveVerdict(GOAL, OUTPUT, env, addr)).toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const pk = generatePrivateKey();
    const env = await makeEnvelope(pk, GOAL, true, 2, OUTPUT);
    const otherAddr = privateKeyToAccount(generatePrivateKey()).address;
    expect(await verifyEnclaveVerdict(GOAL, OUTPUT, env, otherAddr)).toBe(false);
  });

  it("rejects when the bound goalId differs (replay onto another claim)", async () => {
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    const env = await makeEnvelope(pk, OTHER_GOAL, true, 2, OUTPUT);
    // signed for OTHER_GOAL, presented against GOAL
    expect(await verifyEnclaveVerdict(GOAL, OUTPUT, env, addr)).toBe(false);
  });

  it("rejects a tampered output", async () => {
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    const env = await makeEnvelope(pk, GOAL, true, 2, OUTPUT);
    expect(await verifyEnclaveVerdict(GOAL, OUTPUT + " x", env, addr)).toBe(false);
  });

  it("rejects a flipped verified scalar", async () => {
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    const env = await makeEnvelope(pk, GOAL, true, 2, OUTPUT);
    expect(await verifyEnclaveVerdict(GOAL, OUTPUT, { ...env, verified: false }, addr)).toBe(false);
  });

  it("rejects a malformed or missing signature without throwing", async () => {
    const addr = privateKeyToAccount(generatePrivateKey()).address;
    expect(await verifyEnclaveVerdict(GOAL, OUTPUT, undefined, addr)).toBe(false);
    expect(await verifyEnclaveVerdict(GOAL, OUTPUT, {}, addr)).toBe(false);
    expect(await verifyEnclaveVerdict(GOAL, OUTPUT, { sig: "0xdead" }, addr)).toBe(false);
  });
});

describe("verdictDigest (on-chain, non-PHI)", () => {
  it("is deterministic and commits only to the routing scalars", () => {
    const d1 = verdictDigest(GOAL, true, "high");
    const d2 = verdictDigest(GOAL, true, "high");
    expect(d1).toBe(d2);
    expect(verdictDigest(OTHER_GOAL, true, "high")).not.toBe(d1);
    expect(verdictDigest(GOAL, false, "high")).not.toBe(d1);
    expect(verdictDigest(GOAL, true, "low")).not.toBe(d1);
    // It is NOT a hash of the output text.
    expect(d1).not.toBe(keccak256(toBytes(OUTPUT)));
  });
});
