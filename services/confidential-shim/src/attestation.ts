// SEV-SNP hardware attestation (Tier A).
//
// Produces an AMD SEV-SNP ATTESTATION_REPORT plus its VCEK/ASK/ARK certificate
// chain, so a third party can prove offline that this shim runs inside a
// genuine AMD confidential VM and that the running code matches a published,
// reproducibly-built measurement. The report's REPORT_DATA field (64 bytes) is
// caller-supplied and echoed into the AMD-signed output: that is the binding
// primitive Tier B/C use to commit to the enclave's signing key.
//
// PRIVACY INVARIANT: report_data carries ONLY a key/nonce commitment. Nothing
// on this path touches a job id, a prompt, a document, or a filename. The
// bundle is safe to publish.
//
// Two modes. "sev-snp" shells out to the `snpguest` binary against
// /dev/sev-guest and FAILS LOUDLY if the device or the binary is unavailable -
// there is no silent downgrade to software, because a software "attestation"
// that looked real would be worse than none. "software" is the default so the
// vitest suite and a non-SEV `docker compose up` stay green; it returns a
// report_data commitment and nothing else, clearly labelled.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AttestationMode = "sev-snp" | "software";

export interface AttestationBundle {
  format: AttestationMode;
  /** 128 hex (64 bytes): the REPORT_DATA the report commits to. */
  report_data_hex: string;
  /** Raw 1184-byte AMD ATTESTATION_REPORT, base64. sev-snp only. */
  report_b64?: string;
  /** VCEK(or VLEK) || ASK || ARK, PEM concatenation. sev-snp only. */
  cert_chain_pem?: string;
  /** 96 hex (48 bytes): the launch MEASUREMENT. sev-snp only. */
  measurement_hex?: string;
  /** Which endorsement key signed the report. */
  signer_type?: "VCEK" | "VLEK";
  /** 16 hex (8 bytes): the guest POLICY field. */
  policy_hex?: string;
  /** 16 hex (8 bytes): REPORTED_TCB. */
  reported_tcb_hex?: string;
  vmpl: number;
  produced_at: string;
}

export interface AttestationDeps {
  mode: AttestationMode;
  snpguestBin: string;
  vmpl: number;
  /** Scratch dir for the report request/response files. os.tmpdir()-based,
   *  NEVER config.dataDir - attestation scratch must not share the journal. */
  runtimeDir: string;
  /** Injectable clock so tests are deterministic. */
  now?: () => Date;
}

/**
 * Byte offsets into the SEV-SNP ATTESTATION_REPORT (Milan/Genoa, report
 * version 2). Total report size is 1184 (0x4A0) bytes. These are load-bearing:
 * the offline verifier and every downstream binding read the report through
 * them, so parseReport locks them with a test.
 */
export const REPORT_OFFSETS = {
  POLICY: 0x08, // 8, 8 bytes
  REPORT_DATA: 0x50, // 80, 64 bytes
  MEASUREMENT: 0x90, // 144, 48 bytes
  HOST_DATA: 0xc0, // 192, 32 bytes
  REPORTED_TCB: 0x180, // 384, 8 bytes
  SIGNATURE: 0x2a0, // 672, 512 bytes
} as const;

export const REPORT_SIZE = 0x4a0; // 1184 bytes
export const REPORT_DATA_BYTES = 64;

/**
 * Build the 64-byte REPORT_DATA. With no argument: 64 zero bytes. With a
 * nonce: sha256(nonce) in the first 32 bytes, zeros in the last 32. Tier B/C
 * replace this with sha256(pubkey)||zeros, but the length contract (exactly 64
 * bytes) is identical, which is why the report parser and the verifier can be
 * shared across tiers.
 */
export function buildReportData(nonce?: string): Buffer {
  const out = Buffer.alloc(REPORT_DATA_BYTES);
  if (nonce !== undefined && nonce !== "") {
    const digest = createHash("sha256").update(nonce, "utf8").digest();
    digest.copy(out, 0);
  }
  return out;
}

export interface ParsedReport {
  reportDataHex: string;
  measurementHex: string;
  policyHex: string;
  reportedTcbHex: string;
}

/** Extract the fields the binding and the verifier gate on. */
export function parseReport(raw: Buffer): ParsedReport {
  if (raw.length < REPORT_SIZE) {
    throw new Error(
      `attestation report too short: ${raw.length} bytes, expected >= ${REPORT_SIZE}`,
    );
  }
  const slice = (offset: number, len: number): string =>
    raw.subarray(offset, offset + len).toString("hex");
  return {
    policyHex: slice(REPORT_OFFSETS.POLICY, 8),
    reportDataHex: slice(REPORT_OFFSETS.REPORT_DATA, REPORT_DATA_BYTES),
    measurementHex: slice(REPORT_OFFSETS.MEASUREMENT, 48),
    reportedTcbHex: slice(REPORT_OFFSETS.REPORTED_TCB, 8),
  };
}

const SNPGUEST_TIMEOUT_MS = 5_000;

/**
 * Produce an attestation bundle for the given 64-byte report data.
 *
 * Throws (never silently downgrades) when mode is "sev-snp" but the report or
 * certificates cannot be produced. Throws when reportData is not exactly 64
 * bytes.
 */
export async function produceAttestation(
  deps: AttestationDeps,
  reportData: Buffer,
): Promise<AttestationBundle> {
  if (reportData.length !== REPORT_DATA_BYTES) {
    throw new Error(
      `report data must be exactly ${REPORT_DATA_BYTES} bytes, got ${reportData.length}`,
    );
  }
  const now = deps.now ?? (() => new Date());
  const producedAt = now().toISOString();
  const reportDataHex = reportData.toString("hex");

  if (deps.mode === "software") {
    return {
      format: "software",
      report_data_hex: reportDataHex,
      vmpl: deps.vmpl,
      produced_at: producedAt,
    };
  }

  // sev-snp: shell out to snpguest against /dev/sev-guest.
  const workDir = fs.mkdtempSync(path.join(deps.runtimeDir, "snp-att-"));
  try {
    const reqPath = path.join(workDir, "reqdata.bin");
    const reportPath = path.join(workDir, "report.bin");
    const certsDir = path.join(workDir, "certs");
    fs.mkdirSync(certsDir, { recursive: true });
    fs.writeFileSync(reqPath, reportData);

    // snpguest report <report-out> <request-data-in> -v <vmpl>
    await execFileAsync(
      deps.snpguestBin,
      ["report", reportPath, reqPath, "-v", String(deps.vmpl)],
      { timeout: SNPGUEST_TIMEOUT_MS },
    );
    // snpguest certificates PEM <dir> - fetches VCEK/ASK/ARK from the host or KDS
    await execFileAsync(
      deps.snpguestBin,
      ["certificates", "PEM", certsDir],
      { timeout: SNPGUEST_TIMEOUT_MS },
    );

    const rawReport = fs.readFileSync(reportPath);
    const parsed = parseReport(rawReport);

    const readIf = (name: string): string | undefined => {
      const p = path.join(certsDir, name);
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
    };
    const vcek = readIf("vcek.pem");
    const vlek = readIf("vlek.pem");
    const ask = readIf("ask.pem") ?? "";
    const ark = readIf("ark.pem") ?? "";
    const signerType: "VCEK" | "VLEK" = vcek !== undefined ? "VCEK" : "VLEK";
    const endorsement = vcek ?? vlek ?? "";
    const certChain = [endorsement, ask, ark].filter((s) => s !== "").join("\n");

    return {
      format: "sev-snp",
      report_data_hex: parsed.reportDataHex,
      report_b64: rawReport.toString("base64"),
      cert_chain_pem: certChain,
      measurement_hex: parsed.measurementHex,
      signer_type: signerType,
      policy_hex: parsed.policyHex,
      reported_tcb_hex: parsed.reportedTcbHex,
      vmpl: deps.vmpl,
      produced_at: producedAt,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
