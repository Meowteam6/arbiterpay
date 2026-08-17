import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReportData,
  parseReport,
  produceAttestation,
  REPORT_OFFSETS,
  REPORT_SIZE,
  type AttestationDeps,
} from "../src/attestation.js";

const runtimeDir = os.tmpdir();

function softwareDeps(): AttestationDeps {
  return {
    mode: "software",
    snpguestBin: "snpguest",
    vmpl: 0,
    runtimeDir,
    now: () => new Date("2026-08-17T00:00:00.000Z"),
  };
}

describe("buildReportData", () => {
  it("returns 64 zero bytes with no nonce", () => {
    const rd = buildReportData();
    expect(rd.length).toBe(64);
    expect(rd.equals(Buffer.alloc(64))).toBe(true);
  });

  it("puts sha256(nonce) in the first 32 bytes, zeros after", () => {
    const rd = buildReportData("deadbeef");
    const digest = createHash("sha256").update("deadbeef", "utf8").digest();
    expect(rd.subarray(0, 32).equals(digest)).toBe(true);
    expect(rd.subarray(32, 64).equals(Buffer.alloc(32))).toBe(true);
  });
});

describe("parseReport", () => {
  it("extracts POLICY, REPORT_DATA, MEASUREMENT, REPORTED_TCB at their offsets", () => {
    const raw = Buffer.alloc(REPORT_SIZE);
    // Distinct fill per field so a wrong offset is caught.
    raw.fill(0xaa, REPORT_OFFSETS.POLICY, REPORT_OFFSETS.POLICY + 8);
    raw.fill(0xbb, REPORT_OFFSETS.REPORT_DATA, REPORT_OFFSETS.REPORT_DATA + 64);
    raw.fill(0xcc, REPORT_OFFSETS.MEASUREMENT, REPORT_OFFSETS.MEASUREMENT + 48);
    raw.fill(0xdd, REPORT_OFFSETS.REPORTED_TCB, REPORT_OFFSETS.REPORTED_TCB + 8);
    const parsed = parseReport(raw);
    expect(parsed.policyHex).toBe("aa".repeat(8));
    expect(parsed.reportDataHex).toBe("bb".repeat(64));
    expect(parsed.measurementHex).toBe("cc".repeat(48));
    expect(parsed.reportedTcbHex).toBe("dd".repeat(8));
  });

  it("rejects a report shorter than the fixed size", () => {
    expect(() => parseReport(Buffer.alloc(100))).toThrow(/too short/);
  });
});

describe("produceAttestation software mode", () => {
  it("returns format software with the report_data commitment and no report/certs", async () => {
    const bundle = await produceAttestation(softwareDeps(), buildReportData("deadbeef"));
    expect(bundle.format).toBe("software");
    const expected = createHash("sha256").update("deadbeef", "utf8").digest().toString("hex") + "00".repeat(32);
    expect(bundle.report_data_hex).toBe(expected);
    expect(bundle.report_b64).toBeUndefined();
    expect(bundle.cert_chain_pem).toBeUndefined();
    expect(bundle.measurement_hex).toBeUndefined();
    expect(bundle.vmpl).toBe(0);
    expect(bundle.produced_at).toBe("2026-08-17T00:00:00.000Z");
  });

  it("throws if report data is not exactly 64 bytes", async () => {
    await expect(
      produceAttestation(softwareDeps(), Buffer.alloc(32)),
    ).rejects.toThrow(/64 bytes/);
  });
});

describe("produceAttestation sev-snp failure path", () => {
  it("throws (never downgrades to software) when the snpguest binary fails", async () => {
    // A binary guaranteed to exit non-zero: `false`.
    const deps: AttestationDeps = {
      mode: "sev-snp",
      snpguestBin: "false",
      vmpl: 0,
      runtimeDir,
    };
    await expect(
      produceAttestation(deps, buildReportData("x")),
    ).rejects.toThrow();
  });
});

// Real-hardware chain check. Un-skip once a genuine report + VCEK/ASK/ARK
// capture from the live n2d SEV-SNP VM lands in test/fixtures/.
describe.skip("produceAttestation sev-snp real capture", () => {
  it("returns a genuine report and cert chain", async () => {
    const fixture = path.join(__dirname, "fixtures", "report.milan.sample.bin");
    expect(fs.existsSync(fixture)).toBe(true);
  });
});
