// Enclave verdict signing (Tier B + C, unified on secp256k1).
//
// The shim mints an ephemeral secp256k1 keypair in memory at boot. Its private
// half never touches /data, never leaves the process, and dies with it. Two
// things flow from that key:
//
//   1. report_data commitment (Tier B): the SEV-SNP attestation report's
//      REPORT_DATA field is set to keccak256(pubKey64)||zeros(32). Because the
//      report is AMD-signed, this proves the key lives inside the measured
//      enclave. The Ethereum address is the low 20 bytes of that keccak, i.e.
//      report_data_hex[24:64].
//
//   2. per-verdict signature (Tier B origin + C on-chain): every completed
//      verdict is signed over a digest that binds goalId, the verified/
//      confidence scalars, and keccak256(output). goalId is folded in so a
//      captured signature is NOT a replayable bearer token across claims
//      (ADV-2). The same key is an Ethereum key, so the on-chain
//      HealthVerdict.recordVerdict sender can BE this address (Tier C-strong),
//      giving a third party an unbroken chain: AMD report -> key in enclave ->
//      on-chain attester == that key.
//
// Ed25519 was the Tier-B intermediate in the design; folding both tiers onto
// the secp256k1 key removes a second keypair and a second wire format while
// keeping every property. The signature payload commits ONLY to non-PHI
// scalars plus a hash of the output - never the raw document, never prose.

import {
  encodeAbiParameters,
  keccak256,
  recoverAddress,
  toBytes,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";

export type { Hex } from "viem";

export type Confidence = 0 | 1 | 2;

export interface SignatureEnvelope {
  alg: "secp256k1-eth";
  v: 2;
  signer: Hex; // 0x + 40 hex, the enclave Ethereum address
  goal_id: Hex; // 0x + 64 hex
  verified: boolean;
  confidence: Confidence; // 0 low, 1 medium, 2 high
  output_keccak: Hex; // keccak256(utf8(output)); off-chain transcript hash
  sig: Hex; // 65-byte recoverable signature over the digest
}

export interface VerdictSigner {
  /** The enclave's Ethereum address (0x, checksummed). */
  address(): Hex;
  /** 64-byte REPORT_DATA: keccak256(pubKey64) || zeros(32). */
  reportData(): Buffer;
  /** Sign a completed verdict, binding goalId + scalars + output hash. */
  signVerdict(
    goalId: Hex,
    verified: boolean,
    confidence: Confidence,
    output: string,
  ): Promise<SignatureEnvelope>;
}

/**
 * The digest the signature covers, and the same value used as HealthVerdict's
 * on-chain `digest` argument (Tier C): keccak256(abi.encode(goalId, verified,
 * confidence, keccak256(output))). Pinned on both the shim and the app so a
 * verifier can recompute it.
 */
export function verdictDigest(
  goalId: Hex,
  verified: boolean,
  confidence: Confidence,
  outputKeccak: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bool" },
        { type: "uint8" },
        { type: "bytes32" },
      ],
      [goalId, verified, confidence, outputKeccak],
    ),
  );
}

/** keccak256(utf8(output)) - the off-chain transcript hash of the verdict. */
export function outputKeccak(output: string): Hex {
  return keccak256(toBytes(output));
}

/** Uncompressed public key (0x04||X||Y) -> the 64-byte X||Y body. */
function pubKey64(publicKey: Hex): Buffer {
  const hex = publicKey.slice(2);
  // 0x04 prefix (2 hex) + 128 hex of X||Y.
  return Buffer.from(hex.slice(2), "hex");
}

/**
 * Boot the enclave signer. Pass a resolved private key (see sealing.ts) to make
 * the address stable across restarts; omit it for an ephemeral in-memory key.
 */
export function bootEthSigner(privateKey: Hex = generatePrivateKey()): VerdictSigner {
  const account = privateKeyToAccount(privateKey);
  const keyBody = pubKey64(account.publicKey);
  const commitment = Buffer.from(keccak256(keyBody).slice(2), "hex"); // 32 bytes

  return {
    address(): Hex {
      return account.address;
    },
    reportData(): Buffer {
      const out = Buffer.alloc(64);
      commitment.copy(out, 0);
      return out;
    },
    async signVerdict(goalId, verified, confidence, output): Promise<SignatureEnvelope> {
      const ok = outputKeccak(output);
      const digest = verdictDigest(goalId, verified, confidence, ok);
      // Recoverable ECDSA signature over the 32-byte digest via viem's public
      // `sign` primitive (r||s||v, v in {27,28}) - matches ecrecover.
      const signature = await sign({ hash: digest, privateKey, to: "hex" });
      return {
        alg: "secp256k1-eth",
        v: 2,
        signer: account.address,
        goal_id: goalId,
        verified,
        confidence,
        output_keccak: ok,
        sig: signature,
      };
    },
  };
}

/**
 * Recover the signer address from an envelope and confirm every bound field.
 * Pure and dependency-light so both the shim tests and the app verifier share
 * it. Returns the recovered address on success.
 */
export async function recoverVerdictSigner(
  env: SignatureEnvelope,
  output: string,
): Promise<Hex> {
  const ok = outputKeccak(output);
  if (ok !== env.output_keccak) {
    throw new Error("output hash mismatch");
  }
  const digest = verdictDigest(
    env.goal_id,
    env.verified,
    env.confidence,
    env.output_keccak,
  );
  return recoverAddress({ hash: digest, signature: env.sig });
}
