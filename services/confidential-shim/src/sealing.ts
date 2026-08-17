// Enclave key sealing (production fix for the ephemeral-key problem).
//
// The signing key must survive a shim restart, or the app's pinned signer
// address goes stale and every verdict is rejected until an operator re-pins.
// But the key must NOT be recoverable off the box - a plaintext key on the
// /data disk could be read from a disk snapshot, defeating the whole "only the
// enclave can sign" guarantee.
//
// SEV-SNP resolves this with a firmware-DERIVED key. `snpguest key ... -g 8`
// asks the AMD firmware for a 32-byte key derived from the chip's secret (VCEK)
// mixed with the guest MEASUREMENT (guest-field-select bit 3). Properties,
// verified on the live VM:
//   - stable: same code + same chip -> identical key on every call and reboot.
//   - non-extractable: derived inside the firmware; never present off-enclave.
//   - measurement-bound: DIFFERENT code -> different key, so a swapped image
//     cannot unseal the previous key. A different chip (host migration) also
//     yields a different key -> unseal fails -> a fresh key is minted (that is
//     the case the app-side auto-repin handles).
//
// We use that derived key as an AES-256-GCM sealing key: the signing private
// key is encrypted at rest on /data and decrypted only inside the enclave.

import { execFileSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import type { ShimConfig } from "./config.js";

/** guest-field-select bit 3 = Measurement. Binds the derived key to the code. */
const GFS_MEASUREMENT = "8";
const SNPGUEST_TIMEOUT_MS = 5_000;
const SEALED_KEY_FILE = "enclave-key.sealed";
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Derive the 32-byte measurement-bound sealing key from SNP firmware. Throws if
 * snpguest fails or the key is the wrong size - sealing must fail loud, never
 * silently fall back to a weak or absent key.
 */
export function deriveSealingKey(snpguestBin: string, vmpl: number): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snp-seal-"));
  try {
    const out = path.join(dir, "sk.bin");
    execFileSync(
      snpguestBin,
      ["key", out, "vcek", "-v", String(vmpl), "-g", GFS_MEASUREMENT],
      { timeout: SNPGUEST_TIMEOUT_MS, stdio: ["ignore", "ignore", "pipe"] },
    );
    const key = fs.readFileSync(out);
    if (key.length !== 32) {
      throw new Error(`derived sealing key is ${key.length} bytes, expected 32`);
    }
    return key;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** AES-256-GCM seal: output is iv(12) || authTag(16) || ciphertext. */
export function seal(sealingKey: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** AES-256-GCM unseal. Throws on a wrong key or any tampering (GCM auth fail). */
export function unseal(sealingKey: Buffer, blob: Buffer): Buffer {
  if (blob.length < 28) throw new Error("sealed blob too short");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", sealingKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function sealedKeyPath(config: ShimConfig): string {
  // A sibling of the jobs dir, on the same persistent /data volume. The journal
  // loader ignores it (its filename is not a UUID.json).
  return path.join(config.dataDir, SEALED_KEY_FILE);
}

/**
 * Resolve the enclave signing private key.
 *
 * software mode (tests, non-SEV local): ephemeral - generate a fresh key each
 *   boot, never persist. Sealing has no hardware root here, so there is nothing
 *   to seal to; the ephemeral behavior is acceptable off-enclave.
 *
 * sev-snp mode: derive the measurement-bound sealing key, then
 *   - if a sealed key exists and unseals: reuse it (STABLE address across
 *     restarts - the fix).
 *   - else (first boot, or the measurement/chip changed so unseal fails):
 *     mint a fresh key, seal it, persist it 0600.
 *
 * `deriveKey` is injectable so tests can exercise the seal/persist path without
 * SEV hardware.
 */
export function resolveEnclaveKey(
  config: ShimConfig,
  deriveKey: (bin: string, vmpl: number) => Buffer = deriveSealingKey,
): Hex {
  if (config.attestationMode !== "sev-snp") {
    return generatePrivateKey();
  }

  let sealingKey: Buffer;
  try {
    sealingKey = deriveKey(config.snpguestBin, config.sevVmpl);
  } catch (err) {
    // sev-snp configured but the firmware key could not be derived: a
    // misconfiguration (snpguest missing, /dev/sev-guest not passed through).
    // Degrade to an ephemeral key rather than crashing the whole service - the
    // attestation route independently returns 503 in this state, so the app
    // fails closed on the money path instead. Loud, never silent.
    console.error(
      `[shim] SEV-SNP key derivation failed (${err instanceof Error ? err.message : String(err)}); ` +
        "falling back to an EPHEMERAL, unsealed key. Attestation will be unavailable.",
    );
    return generatePrivateKey();
  }
  const keyPath = sealedKeyPath(config);

  if (fs.existsSync(keyPath)) {
    try {
      const pk = unseal(sealingKey, fs.readFileSync(keyPath)).toString("utf8");
      if (PRIVATE_KEY_RE.test(pk)) {
        console.log("[shim] reusing sealed enclave key (stable address)");
        return pk as Hex;
      }
      console.error("[shim] sealed key unsealed to a malformed value; minting a new one");
    } catch {
      // Unseal failed: the measurement or the chip changed. Correct to mint a
      // new identity - the old one belonged to different code or hardware.
      console.warn(
        "[shim] could not unseal the stored key (measurement or chip changed); minting a new one",
      );
    }
  }

  const pk = generatePrivateKey();
  fs.writeFileSync(keyPath, seal(sealingKey, Buffer.from(pk, "utf8")), {
    mode: 0o600,
  });
  console.log("[shim] minted and sealed a new enclave key");
  return pk;
}
