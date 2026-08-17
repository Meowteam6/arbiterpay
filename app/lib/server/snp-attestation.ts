// SEV-SNP attestation verification (Tier C auto-repin, server only).
//
// Verifies an AMD SEV-SNP attestation bundle the shim serves at
// /v1/attestation, so the app can trust a NEW enclave signing key without a
// human re-pinning it. The trust anchor is the code MEASUREMENT plus AMD's root
// key, not any specific address, so when the enclave rotates its key (a host
// migration, or a redeploy of the same code) the app auto-accepts the new
// signer as long as a genuine SEV-SNP report vouches for it.
//
// Chain of trust, all four links required (skipping any is a forgery hole):
//   1. AMD ARK (root) is PINNED below - the received ARK is ignored.
//   2. ASK is signed by the pinned ARK.
//   3. VCEK is signed by ASK.
//   4. The report body is signed by VCEK (ECDSA P-384 / SHA-384).
// Then: the report's MEASUREMENT equals the pinned measurement (this is OUR
// code), the guest policy has DEBUG off (memory not inspectable), and the
// signer address is read out of report_data.
//
// The heavy work runs once per new signer and the result is cached, so the hot
// path stays a cheap signature check (see judge.ts).

import { X509Certificate, verify as cryptoVerify } from "node:crypto";
import type { Hex } from "viem";

// AMD Milan ARK (root), self-signed (CN=ARK-Milan). Pinned so an attacker
// cannot substitute their own root. Verified genuine by snpguest on the live VM.
const AMD_MILAN_ARK_PEM = `-----BEGIN CERTIFICATE-----
MIIGYzCCBBKgAwIBAgIDAQAAMEYGCSqGSIb3DQEBCjA5oA8wDQYJYIZIAWUDBAIC
BQChHDAaBgkqhkiG9w0BAQgwDQYJYIZIAWUDBAICBQCiAwIBMKMDAgEBMHsxFDAS
BgNVBAsMC0VuZ2luZWVyaW5nMQswCQYDVQQGEwJVUzEUMBIGA1UEBwwLU2FudGEg
Q2xhcmExCzAJBgNVBAgMAkNBMR8wHQYDVQQKDBZBZHZhbmNlZCBNaWNybyBEZXZp
Y2VzMRIwEAYDVQQDDAlBUkstTWlsYW4wHhcNMjAxMDIyMTcyMzA1WhcNNDUxMDIy
MTcyMzA1WjB7MRQwEgYDVQQLDAtFbmdpbmVlcmluZzELMAkGA1UEBhMCVVMxFDAS
BgNVBAcMC1NhbnRhIENsYXJhMQswCQYDVQQIDAJDQTEfMB0GA1UECgwWQWR2YW5j
ZWQgTWljcm8gRGV2aWNlczESMBAGA1UEAwwJQVJLLU1pbGFuMIICIjANBgkqhkiG
9w0BAQEFAAOCAg8AMIICCgKCAgEA0Ld52RJOdeiJlqK2JdsVmD7FktuotWwX1fNg
W41XY9Xz1HEhSUmhLz9Cu9DHRlvgJSNxbeYYsnJfvyjx1MfU0V5tkKiU1EesNFta
1kTA0szNisdYc9isqk7mXT5+KfGRbfc4V/9zRIcE8jlHN61S1ju8X93+6dxDUrG2
SzxqJ4BhqyYmUDruPXJSX4vUc01P7j98MpqOS95rORdGHeI52Naz5m2B+O+vjsC0
60d37jY9LFeuOP4Meri8qgfi2S5kKqg/aF6aPtuAZQVR7u3KFYXP59XmJgtcog05
gmI0T/OitLhuzVvpZcLph0odh/1IPXqx3+MnjD97A7fXpqGd/y8KxX7jksTEzAOg
bKAeam3lm+3yKIcTYMlsRMXPcjNbIvmsBykD//xSniusuHBkgnlENEWx1UcbQQrs
+gVDkuVPhsnzIRNgYvM48Y+7LGiJYnrmE8xcrexekBxrva2V9TJQqnN3Q53kt5vi
Qi3+gCfmkwC0F0tirIZbLkXPrPwzZ0M9eNxhIySb2npJfgnqz55I0u33wh4r0ZNQ
eTGfw03MBUtyuzGesGkcw+loqMaq1qR4tjGbPYxCvpCq7+OgpCCoMNit2uLo9M18
fHz10lOMT8nWAUvRZFzteXCm+7PHdYPlmQwUw3LvenJ/ILXoQPHfbkH0CyPfhl1j
WhJFZasCAwEAAaN+MHwwDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBSFrBrRQ/fI
rFXUxR1BSKvVeErUUzAPBgNVHRMBAf8EBTADAQH/MDoGA1UdHwQzMDEwL6AtoCuG
KWh0dHBzOi8va2RzaW50Zi5hbWQuY29tL3ZjZWsvdjEvTWlsYW4vY3JsMEYGCSqG
SIb3DQEBCjA5oA8wDQYJYIZIAWUDBAICBQChHDAaBgkqhkiG9w0BAQgwDQYJYIZI
AWUDBAICBQCiAwIBMKMDAgEBA4ICAQC6m0kDp6zv4Ojfgy+zleehsx6ol0ocgVel
ETobpx+EuCsqVFRPK1jZ1sp/lyd9+0fQ0r66n7kagRk4Ca39g66WGTJMeJdqYriw
STjjDCKVPSesWXYPVAyDhmP5n2v+BYipZWhpvqpaiO+EGK5IBP+578QeW/sSokrK
dHaLAxG2LhZxj9aF73fqC7OAJZ5aPonw4RE299FVarh1Tx2eT3wSgkDgutCTB1Yq
zT5DuwvAe+co2CIVIzMDamYuSFjPN0BCgojl7V+bTou7dMsqIu/TW/rPCX9/EUcp
KGKqPQ3P+N9r1hjEFY1plBg93t53OOo49GNI+V1zvXPLI6xIFVsh+mto2RtgEX/e
pmMKTNN6psW88qg7c1hTWtN6MbRuQ0vm+O+/2tKBF2h8THb94OvvHHoFDpbCELlq
HnIYhxy0YKXGyaW1NjfULxrrmxVW4wcn5E8GddmvNa6yYm8scJagEi13mhGu4Jqh
3QU3sf8iUSUr09xQDwHtOQUVIqx4maBZPBtSMf+qUDtjXSSq8lfWcd8bLr9mdsUn
JZJ0+tuPMKmBnSH860llKk+VpVQsgqbzDIvOLvD6W1Umq25boxCYJ+TuBoa4s+HH
CViAvgT9kf/rBq1d+ivj6skkHxuzcxbk1xv6ZGxrteJxVH7KlX7YRdZ6eARKwLe4
AFZEAwoKCQ==
-----END CERTIFICATE-----`;

// SEV-SNP ATTESTATION_REPORT (v2) offsets. Report is 1184 bytes; the signature
// covers bytes [0, SIG_OFFSET). Kept in lockstep with the shim's REPORT_OFFSETS.
const REPORT_SIZE = 0x4a0;
const OFF_POLICY = 0x08;
const OFF_REPORT_DATA = 0x50;
const OFF_MEASUREMENT = 0x90;
const SIG_OFFSET = 0x2a0;
const P384_BYTES = 48;
const SIG_COMPONENT_SLOT = 72; // AMD stores each of r,s in a 72-byte slot
const POLICY_DEBUG_BIT = 19n; // guest policy bit 19 = DEBUG

export interface SnpBundle {
  report_b64?: unknown;
  cert_chain_pem?: unknown;
  format?: unknown;
}

export interface SnpVerifyResult {
  ok: boolean;
  signerAddress?: Hex;
  measurementHex?: string;
  reason?: string;
}

function derInteger(be: Buffer): Buffer {
  let i = 0;
  while (i < be.length - 1 && be[i] === 0) i++;
  let v = be.subarray(i);
  if ((v[0] ?? 0) & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return Buffer.concat([Buffer.from([0x02, v.length]), v]);
}

/** AMD report signature field (r || s, little-endian, 48 bytes each) -> DER. */
function amdSigToDer(report: Buffer): Buffer {
  const field = report.subarray(SIG_OFFSET);
  const r = Buffer.from(field.subarray(0, P384_BYTES)).reverse();
  const s = Buffer.from(
    field.subarray(SIG_COMPONENT_SLOT, SIG_COMPONENT_SLOT + P384_BYTES),
  ).reverse();
  const seq = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

function splitCerts(pem: string): X509Certificate[] {
  const blocks = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (blocks === null) return [];
  return blocks.map((b) => new X509Certificate(b));
}

/**
 * Verify an SEV-SNP attestation bundle against the pinned AMD root and the
 * expected measurement. Returns the enclave signer address on success. Never
 * throws - any problem is { ok: false, reason }.
 */
export function verifySnpAttestation(
  bundle: SnpBundle,
  expectedMeasurementHex: string,
): SnpVerifyResult {
  try {
    if (bundle.format !== "sev-snp") {
      return { ok: false, reason: "not a sev-snp bundle" };
    }
    if (typeof bundle.report_b64 !== "string" || typeof bundle.cert_chain_pem !== "string") {
      return { ok: false, reason: "missing report or cert chain" };
    }
    const report = Buffer.from(bundle.report_b64, "base64");
    if (report.length < REPORT_SIZE) {
      return { ok: false, reason: `report too short (${report.length})` };
    }

    // Chain: pinned ARK -> ASK -> VCEK. The received ARK is ignored.
    const certs = splitCerts(bundle.cert_chain_pem);
    if (certs.length < 2) {
      return { ok: false, reason: "cert chain missing VCEK/ASK" };
    }
    const vcek = certs[0];
    const ask = certs[1];
    const ark = new X509Certificate(AMD_MILAN_ARK_PEM);
    if (!ask.verify(ark.publicKey)) {
      return { ok: false, reason: "ASK not signed by the pinned AMD ARK" };
    }
    if (!vcek.verify(ask.publicKey)) {
      return { ok: false, reason: "VCEK not signed by ASK" };
    }

    // Report body signed by VCEK (ECDSA P-384 / SHA-384).
    const body = report.subarray(0, SIG_OFFSET);
    const der = amdSigToDer(report);
    if (!cryptoVerify("sha384", body, vcek.publicKey, der)) {
      return { ok: false, reason: "report signature invalid" };
    }

    // Measurement == our pinned code.
    const measurementHex = report
      .subarray(OFF_MEASUREMENT, OFF_MEASUREMENT + 48)
      .toString("hex");
    if (measurementHex.toLowerCase() !== expectedMeasurementHex.toLowerCase()) {
      return { ok: false, reason: "measurement mismatch", measurementHex };
    }

    // Guest policy DEBUG must be off (else enclave memory is inspectable).
    const policy = report.subarray(OFF_POLICY, OFF_POLICY + 8);
    let policyVal = 0n;
    for (let i = policy.length - 1; i >= 0; i--) {
      policyVal = (policyVal << 8n) | BigInt(policy[i] ?? 0);
    }
    if (((policyVal >> POLICY_DEBUG_BIT) & 1n) === 1n) {
      return { ok: false, reason: "guest policy has DEBUG enabled" };
    }

    // Signer address = low 20 bytes of report_data[0:32] = report_data_hex[24:64].
    const reportDataHex = report
      .subarray(OFF_REPORT_DATA, OFF_REPORT_DATA + 64)
      .toString("hex");
    const signerAddress = (`0x${reportDataHex.slice(24, 64)}`) as Hex;

    return { ok: true, signerAddress, measurementHex };
  } catch (err) {
    return {
      ok: false,
      reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
