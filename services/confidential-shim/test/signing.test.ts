import { describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import {
  bootEthSigner,
  outputKeccak,
  recoverVerdictSigner,
  verdictDigest,
} from "../src/signing.js";

const GOAL_A: Hex = `0x${"11".repeat(32)}`;
const GOAL_B: Hex = `0x${"22".repeat(32)}`;
const OUTPUT = '{"verified": true, "confidence": "high", "reason": "qualifying_record_present"}';

describe("bootEthSigner report_data commitment", () => {
  it("commits to the pubkey and the address is the low 20 bytes of that keccak", () => {
    const signer = bootEthSigner();
    const rd = signer.reportData();
    expect(rd.length).toBe(64);
    // last 32 bytes are zero
    expect(rd.subarray(32, 64).equals(Buffer.alloc(32))).toBe(true);
    // address == report_data_hex[24:64] (bytes 12..32 of the commitment)
    const rdHex = rd.toString("hex");
    expect(`0x${rdHex.slice(24, 64)}`.toLowerCase()).toBe(signer.address().toLowerCase());
  });
});

describe("signVerdict", () => {
  it("produces an envelope that recovers to the signer address", async () => {
    const signer = bootEthSigner();
    const env = await signer.signVerdict(GOAL_A, true, 2, OUTPUT);
    expect(env.alg).toBe("secp256k1-eth");
    expect(env.v).toBe(2);
    expect(env.signer.toLowerCase()).toBe(signer.address().toLowerCase());
    expect(env.output_keccak).toBe(keccak256(Buffer.from(OUTPUT, "utf8")));
    const recovered = await recoverVerdictSigner(env, OUTPUT);
    expect(recovered.toLowerCase()).toBe(signer.address().toLowerCase());
  });

  it("binds goalId: a signature for goal A does not verify against goal B (ADV-2)", async () => {
    const signer = bootEthSigner();
    const env = await signer.signVerdict(GOAL_A, true, 2, OUTPUT);
    const forged = { ...env, goal_id: GOAL_B };
    const recovered = await recoverVerdictSigner(forged, OUTPUT);
    // Recovery yields SOME address, but not the signer's, because the digest changed.
    expect(recovered.toLowerCase()).not.toBe(signer.address().toLowerCase());
  });

  it("binds the output: tampering the output breaks recovery", async () => {
    const signer = bootEthSigner();
    const env = await signer.signVerdict(GOAL_A, true, 2, OUTPUT);
    await expect(
      recoverVerdictSigner(env, OUTPUT + " tampered"),
    ).rejects.toThrow(/output hash mismatch/);
  });

  it("binds verified/confidence: flipping either breaks recovery", async () => {
    const signer = bootEthSigner();
    const env = await signer.signVerdict(GOAL_A, true, 2, OUTPUT);
    const flipped = { ...env, verified: false };
    const recovered = await recoverVerdictSigner(flipped, OUTPUT);
    expect(recovered.toLowerCase()).not.toBe(signer.address().toLowerCase());
  });
});

describe("verdictDigest / outputKeccak are pure and pinned", () => {
  it("is stable for the same inputs", () => {
    const ok = outputKeccak(OUTPUT);
    const d1 = verdictDigest(GOAL_A, true, 2, ok);
    const d2 = verdictDigest(GOAL_A, true, 2, ok);
    expect(d1).toBe(d2);
  });

  it("changes when any bound field changes", () => {
    const ok = outputKeccak(OUTPUT);
    const base = verdictDigest(GOAL_A, true, 2, ok);
    expect(verdictDigest(GOAL_B, true, 2, ok)).not.toBe(base);
    expect(verdictDigest(GOAL_A, false, 2, ok)).not.toBe(base);
    expect(verdictDigest(GOAL_A, true, 1, ok)).not.toBe(base);
    expect(verdictDigest(GOAL_A, true, 2, outputKeccak("other"))).not.toBe(base);
  });
});
