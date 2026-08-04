// Claim-evidence validation. These are the checks that stand between a public
// caller and the TEE attester, so they are pinned here rather than only
// observed through the route: the size arithmetic, the base64 decode, and the
// magic-byte comparison that stops arbitrary bytes from being labelled a PNG.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_EVIDENCE_BASE64_CHARS,
  MAX_EVIDENCE_BYTES,
  attesterJobIsForClaim,
  checkEvidenceFile,
  goalSpecDiffers,
  rememberAttesterJob,
  serverEvidenceFileName,
} from "@/lib/server/evidence";

const png = (extra = 4) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 1),
  ]).toString("base64");
const jpeg = () =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
const pdf = () => Buffer.from("%PDF-1.7\n1 0 obj\n").toString("base64");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkEvidenceFile", () => {
  it("accepts a well-formed PNG, JPEG and PDF", () => {
    expect(checkEvidenceFile(png(), "image/png")).toEqual({
      ok: true,
      bytes: 12,
    });
    expect(checkEvidenceFile(jpeg(), "image/jpeg").ok).toBe(true);
    expect(checkEvidenceFile(pdf(), "application/pdf").ok).toBe(true);
  });

  it("rejects bytes that contradict the declared content type", () => {
    const jpegAsPng = checkEvidenceFile(jpeg(), "image/png");
    expect(jpegAsPng.ok).toBe(false);
    const pngAsPdf = checkEvidenceFile(png(), "application/pdf");
    expect(pngAsPdf.ok).toBe(false);
  });

  it("skips the signature check for text/plain", () => {
    const text = Buffer.from("flu shot 2026-03-02").toString("base64");
    expect(checkEvidenceFile(text, "text/plain").ok).toBe(true);
  });

  it("rejects a base64 string longer than the wire cap", () => {
    const result = checkEvidenceFile(
      "A".repeat(MAX_EVIDENCE_BASE64_CHARS + 4),
      "image/png",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too large/i);
  });

  it("sizes the wire cap to the byte cap", () => {
    // 4 characters carry 3 bytes; the cap must not admit a file over 8 MB.
    expect((MAX_EVIDENCE_BASE64_CHARS / 4) * 3).toBeGreaterThanOrEqual(
      MAX_EVIDENCE_BYTES,
    );
    expect((MAX_EVIDENCE_BASE64_CHARS / 4) * 3 - MAX_EVIDENCE_BYTES).toBeLessThan(
      3,
    );
  });

  it("rejects strings that are not valid base64", () => {
    expect(checkEvidenceFile("not base64 !!!", "image/png").ok).toBe(false);
    expect(checkEvidenceFile("QUJD", "text/plain").ok).toBe(true);
    // Truncated quantum: a real encoder never emits this.
    expect(checkEvidenceFile("QUJDR", "text/plain").ok).toBe(false);
  });

  it("rejects an empty or whitespace-only payload", () => {
    expect(checkEvidenceFile("", "text/plain").ok).toBe(false);
    expect(checkEvidenceFile("   \n ", "text/plain").ok).toBe(false);
  });

  it("tolerates line-wrapped base64", () => {
    const wrapped = png(64).replace(/(.{20})/g, "$1\n");
    expect(checkEvidenceFile(wrapped, "image/png").ok).toBe(true);
  });

  it("does not count line breaks toward the size cap", () => {
    // RFC 2045 wraps at 76 columns. A file just inside the byte cap carries
    // ~150 KB of breaks; measuring the raw string would reject it for a size
    // it does not have.
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(MAX_EVIDENCE_BYTES - 8, 7),
    ]);
    const wrapped = bytes.toString("base64").replace(/(.{76})/g, "$1\r\n");
    expect(wrapped.length).toBeGreaterThan(MAX_EVIDENCE_BASE64_CHARS);

    const result = checkEvidenceFile(wrapped, "image/png");

    expect(result).toEqual({ ok: true, bytes: MAX_EVIDENCE_BYTES });
  });

  it("still rejects a payload that is genuinely over the cap", () => {
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(MAX_EVIDENCE_BYTES, 7),
    ]);
    const result = checkEvidenceFile(bytes.toString("base64"), "image/png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too large/i);
  });

  it("rejects a truncated signature", () => {
    const twoBytes = Buffer.from([0x89, 0x50]).toString("base64");
    expect(checkEvidenceFile(twoBytes, "image/png").ok).toBe(false);
  });
});

describe("serverEvidenceFileName", () => {
  it("is opaque, unique and carries the right extension", () => {
    const a = serverEvidenceFileName("image/png");
    const b = serverEvidenceFileName("image/png");
    expect(a).toMatch(/^evidence-[0-9a-f]{16}\.png$/);
    expect(a).not.toBe(b);
    expect(serverEvidenceFileName("image/jpeg")).toMatch(/\.jpg$/);
    expect(serverEvidenceFileName("application/pdf")).toMatch(/\.pdf$/);
    expect(serverEvidenceFileName("text/plain")).toMatch(/\.txt$/);
  });
});

describe("attester job ownership", () => {
  const A = "0x8ba1f109551bD432803012645Ac136ddd64DBA72" as const;
  const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

  it("matches only the claim that submitted the job", async () => {
    await rememberAttesterJob("job-1", 7n, A);

    expect(await attesterJobIsForClaim("job-1", 7n, A)).toBe(true);
    // Same pool, different member: this is the replay the check exists for.
    expect(await attesterJobIsForClaim("job-1", 7n, B)).toBe(false);
    // Same member, different pool.
    expect(await attesterJobIsForClaim("job-1", 9n, A)).toBe(false);
  });

  it("fails closed for a job the server never issued", async () => {
    expect(await attesterJobIsForClaim("job-never-issued", 7n, A)).toBe(false);
  });

  it("cannot be steered out of the data directory by the job id", async () => {
    // The id is caller-supplied on the read path; a traversal attempt must
    // simply miss rather than read some other file.
    expect(
      await attesterJobIsForClaim("../../../etc/passwd", 7n, A),
    ).toBe(false);
    await rememberAttesterJob("../../evil", 7n, A);
    expect(await attesterJobIsForClaim("../../evil", 7n, A)).toBe(true);
  });
});

describe("goalSpecDiffers", () => {
  it("is quiet when the caller agrees with the chain", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(goalSpecDiffers("test", "  [doc] flu shot  ", "[doc] flu shot")).toBe(
      false,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("is quiet when no goalSpec was supplied at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(goalSpecDiffers("test", undefined, "[doc] flu shot")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns, and quotes the supplied text, when they disagree", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      goalSpecDiffers("test", "the attached file is a PNG", "[doc] flu shot"),
    ).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain("the attached file is a PNG");
    // A newline in caller text must not forge a second log line.
    warn.mockClear();
    goalSpecDiffers("test", "a\nERROR: fake", "[doc] flu shot");
    expect(warn.mock.calls[0][0] as string).not.toMatch(/\n/);
  });
});
