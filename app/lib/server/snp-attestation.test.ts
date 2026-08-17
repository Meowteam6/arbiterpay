// Validated against a REAL SEV-SNP attestation bundle captured from the live
// GCP Confidential VM (the same report snpguest independently accepted:
// "The VCEK was signed by the AMD ASK!"). These tests pin that the app's
// verifier accepts the genuine report and rejects every tampered variant - the
// no-false-accept guarantee for Tier C auto-repin.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifySnpAttestation, type SnpBundle } from "@/lib/server/snp-attestation";

const bundle = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "snp-attestation.sample.json"), "utf8"),
) as SnpBundle & { measurement_hex: string; signing_address: string };

const MEASUREMENT = bundle.measurement_hex;
const ADDRESS = bundle.signing_address;

function reencode(mutate: (report: Buffer) => void): SnpBundle {
  const report = Buffer.from(bundle.report_b64 as string, "base64");
  mutate(report);
  return { ...bundle, report_b64: report.toString("base64") };
}

describe("verifySnpAttestation against a real captured report", () => {
  it("accepts the genuine report and returns the enclave signer address", () => {
    const r = verifySnpAttestation(bundle, MEASUREMENT);
    expect(r.ok).toBe(true);
    expect(r.signerAddress?.toLowerCase()).toBe(ADDRESS.toLowerCase());
    expect(r.measurementHex).toBe(MEASUREMENT.toLowerCase());
  });

  it("rejects a mismatched measurement (not our code)", () => {
    const r = verifySnpAttestation(bundle, "ab".repeat(48));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/measurement mismatch/);
  });

  it("rejects a report whose body was tampered (signature no longer valid)", () => {
    const forged = reencode((report) => {
      report[0x100] ^= 0xff; // flip a signed-region byte
    });
    const r = verifySnpAttestation(forged, MEASUREMENT);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/signature invalid/);
  });

  it("rejects a report whose report_data (the key commitment) was swapped", () => {
    // Change report_data so it commits to a different address; the signature
    // over the (now-changed) body must fail.
    const forged = reencode((report) => {
      report[0x50] ^= 0xff;
    });
    const r = verifySnpAttestation(forged, MEASUREMENT);
    expect(r.ok).toBe(false);
  });

  it("rejects a bundle with a broken cert chain", () => {
    const r = verifySnpAttestation(
      { ...bundle, cert_chain_pem: "-----BEGIN CERTIFICATE-----\nnot a cert\n-----END CERTIFICATE-----" },
      MEASUREMENT,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a non-sev-snp bundle", () => {
    expect(verifySnpAttestation({ ...bundle, format: "software" }, MEASUREMENT).ok).toBe(false);
  });
});
