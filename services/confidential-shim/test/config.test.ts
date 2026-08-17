import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE = { SHIM_API_KEY: "k" };

describe("loadConfig attestation settings", () => {
  it("defaults to software mode, snpguest, vmpl 0", () => {
    const c = loadConfig({ ...BASE });
    expect(c.attestationMode).toBe("software");
    expect(c.snpguestBin).toBe("snpguest");
    expect(c.sevVmpl).toBe(0);
  });

  it("enables sev-snp mode when SHIM_ATTESTATION_MODE=sev-snp", () => {
    const c = loadConfig({ ...BASE, SHIM_ATTESTATION_MODE: "sev-snp" });
    expect(c.attestationMode).toBe("sev-snp");
  });

  it("treats any non-'sev-snp' value as software", () => {
    const c = loadConfig({ ...BASE, SHIM_ATTESTATION_MODE: "SEV_SNP" });
    expect(c.attestationMode).toBe("software");
  });

  it("parses a custom binary path and VMPL", () => {
    const c = loadConfig({
      ...BASE,
      SHIM_SNPGUEST_BIN: "/usr/local/bin/snpguest",
      SHIM_SEV_VMPL: "2",
    });
    expect(c.snpguestBin).toBe("/usr/local/bin/snpguest");
    expect(c.sevVmpl).toBe(2);
  });
});
