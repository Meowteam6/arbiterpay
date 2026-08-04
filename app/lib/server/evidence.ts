// Server-side validation of claim evidence (server only).
//
// WHY this exists: /api/evidence/submit is the one route where a public
// caller hands us raw bytes, and everything downstream trusts what it is told
// about them — the TEE attester is asked to judge a "document" that is
// whatever the body said it was, under a filename the body chose. The
// browser's own 8 MB cap and content-type sniff live in the client bundle
// (components/EvidenceUpload.tsx), where a caller who never loads the page
// simply does not run them. A curl with a 200 MB body, or arbitrary bytes
// labelled image/png, reaches the enclave otherwise.
//
// These are pure functions on purpose: the size math, the base64 decode and
// the magic-byte comparison are the parts worth pinning in unit tests, and
// vitest here is node-env .ts only.

import { createHash } from "crypto";
import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
} from "viem";
import { fetchPool, type PoolInfo } from "@/lib/contract";
import { errorMessage } from "@/lib/server/http";
import { readJson, writeJson } from "@/lib/server/store";
import type { SupportedContentType } from "@/lib/server/judge";

/**
 * Whether a failed pool read is HealthPools saying "no such pool".
 *
 * The decoded revert is the authority: viem parses `require(..., "NO_POOL")`
 * into ContractFunctionRevertedError.reason, and would parse a future custom
 * error into data.errorName. The message substring is only a fallback for a
 * transport that hands back an already-flattened error, so a formatting change
 * inside viem cannot silently turn a missing pool into a 500.
 */
function isMissingPool(err: unknown): boolean {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.reason === "NO_POOL" || revert.data?.errorName === "NO_POOL";
    }
  }
  return errorMessage(err).includes("NO_POOL");
}

/**
 * Read a pool from the chain, or null when no such pool exists.
 *
 * Both claim routes start here because the pool is the authority on what the
 * claim actually is: its goalSpec is the goal the enclave judges, and nothing
 * a caller sends may stand in for it. HealthPools reverts with NO_POOL for an
 * id outside 1..poolCount; every other failure (a dead RPC, an unconfigured
 * contract address) is rethrown so it fails loudly rather than reading as a
 * missing pool.
 */
export async function loadClaimPool(poolId: bigint): Promise<PoolInfo | null> {
  try {
    return await fetchPool(poolId);
  } catch (err) {
    if (isMissingPool(err)) return null;
    throw err;
  }
}

/** Raw-byte ceiling for one uploaded record. Mirrors MAX_FILE_BYTES in
 *  components/EvidenceUpload.tsx — that copy is a courtesy, this one is the
 *  rule. */
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

/** Base64 turns every 3 bytes into 4 characters, so the ceiling on the wire
 *  is 4/3 of the byte ceiling rounded up to the next 4-character quantum
 *  (about 11 MB of characters for an 8 MB file). Checked before decoding: a
 *  string this long must never be expanded into a buffer first. */
export const MAX_EVIDENCE_BASE64_CHARS = 4 * Math.ceil(MAX_EVIDENCE_BYTES / 3);

/** Standard base64 alphabet with at most two padding characters. Whitespace
 *  is stripped before this runs; anything else fails. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The bytes every accepted binary format is required to begin with. A caller
 * can still lie about what a well-formed PNG depicts — that is the attester's
 * problem — but it can no longer label arbitrary bytes as an image and have
 * the enclave, or a downstream renderer, meet something else entirely.
 *
 * text/plain has no signature and is checked for size and encoding only.
 */
const MAGIC_BYTES: Partial<Record<SupportedContentType, readonly number[]>> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "application/pdf": [0x25, 0x50, 0x44, 0x46], // "%PDF"
};

const FILE_EXTENSION: Record<SupportedContentType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

export type EvidenceCheck =
  | { ok: true; bytes: number }
  | { ok: false; message: string };

/**
 * Validate one uploaded record against its declared content type.
 *
 * The message on a rejection is written for the person who uploaded the file
 * and echoes nothing the caller supplied.
 */
export function checkEvidenceFile(
  fileBase64: string,
  contentType: SupportedContentType,
): EvidenceCheck {
  // Strip first, then measure. RFC 2045 encoders wrap base64 at 76 columns,
  // so a legitimate near-8 MB record carries ~150 KB of line breaks; measuring
  // the raw string would reject it for a size it does not have. Stripping is
  // a linear pass over a string already in memory - the length gate that
  // follows is still what stops an enormous payload from being decoded.
  const normalized = fileBase64.replace(/\s+/g, "");
  if (normalized === "") {
    return { ok: false, message: "That file was empty." };
  }
  if (normalized.length > MAX_EVIDENCE_BASE64_CHARS) {
    return {
      ok: false,
      message: `That file is too large. Records must be under ${Math.floor(
        MAX_EVIDENCE_BYTES / (1024 * 1024),
      )} MB.`,
    };
  }
  if (normalized.length % 4 !== 0 || !BASE64_RE.test(normalized)) {
    return { ok: false, message: "That file was not valid base64." };
  }

  const decoded = Buffer.from(normalized, "base64");
  // Buffer.from silently drops characters it cannot use, so the only proof
  // the string really decoded is that the byte count matches the arithmetic.
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  if (decoded.length !== (normalized.length / 4) * 3 - padding) {
    return { ok: false, message: "That file was not valid base64." };
  }
  if (decoded.length === 0) {
    return { ok: false, message: "That file was empty." };
  }
  if (decoded.length > MAX_EVIDENCE_BYTES) {
    return {
      ok: false,
      message: `That file is too large. Records must be under ${Math.floor(
        MAX_EVIDENCE_BYTES / (1024 * 1024),
      )} MB.`,
    };
  }

  const magic = MAGIC_BYTES[contentType];
  if (magic !== undefined) {
    const matches =
      decoded.length >= magic.length &&
      magic.every((byte, i) => decoded[i] === byte);
    if (!matches) {
      return {
        ok: false,
        message: `That file's contents do not match ${contentType}. Upload the original PNG, JPG or PDF record.`,
      };
    }
  }

  return { ok: true, bytes: decoded.length };
}

// ------------------------------------------------- attester job ownership
//
// An attester job id is the receipt for one TEE inference, and the run route
// pays out on whatever verdict that job returns. Nothing tied a job to the
// claim it was submitted for: the run route accepted any attesterId as long
// as the caller had joined a pool matching the goalId in the path. Two
// participants in the SAME pool share one goalSpec, so if A uploaded a real
// record and their job id leaked or was shared, B could POST their own
// goalId with A's attesterId and be paid off A's evidence without uploading
// anything. The ledger's spend dedupe does not help: it is scoped to one
// goalId, and B's replay happens under a different one.
//
// So the submit route records who a job belongs to, and the run route checks
// it before polling or spending.

/** The claim an attester job was submitted for. */
export interface AttesterJobClaim {
  poolId: string;
  participant: string;
  at: string;
}

/** Store key for one job. The id is caller-supplied on the read path and the
 *  file store joins the key onto a directory, so it is hashed rather than
 *  interpolated: a lookup can never walk out of the data directory. */
function attesterJobFile(attesterId: string): string {
  const key = createHash("sha256").update(attesterId).digest("hex");
  return `attester-job-${key}.json`;
}

/** Record which claim an attester job was submitted for. Written by the
 *  evidence route the moment the job id comes back, before the caller sees
 *  it, so the run route can never race ahead of the record. */
export async function rememberAttesterJob(
  attesterId: string,
  poolId: bigint,
  participant: Address,
): Promise<void> {
  const claim: AttesterJobClaim = {
    poolId: poolId.toString(),
    participant: participant.toLowerCase(),
    at: new Date().toISOString(),
  };
  await writeJson(attesterJobFile(attesterId), claim);
}

/**
 * Whether this attester job was submitted for exactly this claim.
 *
 * False for a job belonging to another pool or another participant, for a job
 * this server never issued, and for a corrupt record. Fail closed: an
 * unrecognised job must not be paid out on, and re-uploading the record costs
 * the participant one submission.
 */
export async function attesterJobIsForClaim(
  attesterId: string,
  poolId: bigint,
  participant: Address,
): Promise<boolean> {
  const claim = await readJson<AttesterJobClaim | null>(
    attesterJobFile(attesterId),
    null,
  );
  if (
    claim === null ||
    typeof claim.poolId !== "string" ||
    typeof claim.participant !== "string"
  ) {
    return false;
  }
  return (
    claim.poolId === poolId.toString() &&
    claim.participant === participant.toLowerCase()
  );
}

/**
 * An opaque server-generated filename for the attester resource.
 *
 * The attester needs *a* filename; it does not need the caller's. The
 * uploaded name is unvalidated caller text that would otherwise travel into
 * the enclave request beside the prompt — a second injection channel next to
 * goalSpec, and a small privacy leak besides (people name files after their
 * condition).
 */
export function serverEvidenceFileName(
  contentType: SupportedContentType,
): string {
  const id = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `evidence-${id}.${FILE_EXTENSION[contentType]}`;
}

/**
 * Note, once, that a caller's goalSpec disagreed with the chain's.
 *
 * The chain value is the only one ever used, so a mismatch changes nothing —
 * but it is either a stale client or someone probing the enclave prompt, and
 * both are worth seeing. Returns whether they differed so callers can test
 * this without reading logs. The supplied value is truncated and quoted: it
 * is untrusted text and must not forge log lines.
 */
export function goalSpecDiffers(
  context: string,
  supplied: unknown,
  onChain: string,
): boolean {
  if (typeof supplied !== "string") return false;
  if (supplied.trim() === onChain.trim()) return false;
  console.warn(
    `[${context}] ignoring a caller-supplied goalSpec that does not match the ` +
      `pool's on-chain goal; using the chain value. supplied=${JSON.stringify(
        supplied.slice(0, 120),
      )}`,
  );
  return true;
}
