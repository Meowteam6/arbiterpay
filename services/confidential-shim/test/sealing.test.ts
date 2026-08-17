import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShimConfig } from "../src/config.js";
import { resolveEnclaveKey, seal, unseal } from "../src/sealing.js";

describe("seal / unseal", () => {
  it("round-trips a private key", () => {
    const key = randomBytes(32);
    const pk = "0x" + "ab".repeat(32);
    const blob = seal(key, Buffer.from(pk, "utf8"));
    expect(unseal(key, blob).toString("utf8")).toBe(pk);
  });

  it("fails to unseal with a different key (GCM auth)", () => {
    const blob = seal(randomBytes(32), Buffer.from("secret"));
    expect(() => unseal(randomBytes(32), blob)).toThrow();
  });

  it("fails to unseal a tampered blob", () => {
    const key = randomBytes(32);
    const blob = seal(key, Buffer.from("secret"));
    blob[blob.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => unseal(key, blob)).toThrow();
  });
});

describe("resolveEnclaveKey", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-seal-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function cfg(mode: "sev-snp" | "software"): ShimConfig {
    return {
      apiKey: "k",
      ollamaUrl: "http://x",
      model: "m",
      dataDir,
      port: 0,
      inferenceTimeoutMs: 1,
      attestationMode: mode,
      snpguestBin: "snpguest",
      sevVmpl: 0,
    };
  }

  it("software mode is ephemeral: a new key each call, nothing persisted", () => {
    const k1 = resolveEnclaveKey(cfg("software"));
    const k2 = resolveEnclaveKey(cfg("software"));
    expect(k1).not.toBe(k2);
    expect(fs.readdirSync(dataDir)).toHaveLength(0);
  });

  it("sev-snp mode: seals on first boot, reuses the SAME key on the next boot", () => {
    const fakeDerive = () => Buffer.alloc(32, 7); // stable fake firmware key
    const first = resolveEnclaveKey(cfg("sev-snp"), fakeDerive);
    expect(fs.existsSync(path.join(dataDir, "enclave-key.sealed"))).toBe(true);
    const second = resolveEnclaveKey(cfg("sev-snp"), fakeDerive);
    expect(second).toBe(first); // STABLE address across restarts - the fix
  });

  it("sev-snp mode: a changed measurement (different derived key) mints a NEW key", () => {
    const first = resolveEnclaveKey(cfg("sev-snp"), () => Buffer.alloc(32, 7));
    // Different derived key => unseal fails => new identity, correctly.
    const second = resolveEnclaveKey(cfg("sev-snp"), () => Buffer.alloc(32, 9));
    expect(second).not.toBe(first);
  });
});
