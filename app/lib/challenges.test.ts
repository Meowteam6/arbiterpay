import { describe, it, expect } from "vitest";
import {
  INVITE_TOKEN_PATTERN,
  INVITE_TOKEN_BYTES,
  TARGET_HANDLE_MAX,
  MESSAGE_MAX,
  base64UrlNoPad,
  generateInviteToken,
  isValidInviteToken,
  checkMessage,
  checkTargetHandle,
  challengeShareUrl,
} from "@/lib/challenges";

describe("invite tokens", () => {
  it("encodes bytes into the URL-safe alphabet with no padding", () => {
    // 0xfb 0xff 0xbf would base64 to "+/+/"; url-safe swaps to "-_-_".
    const encoded = base64UrlNoPad(new Uint8Array([0xfb, 0xff, 0xbf]));
    expect(encoded).toBe("-_-_");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("generates tokens that satisfy the DB CHECK pattern", () => {
    // A deterministic 24-byte source proves the length lands in range and the
    // alphabet is legal; the live generator uses crypto-random bytes.
    const bytes = Uint8Array.from({ length: INVITE_TOKEN_BYTES }, (_, i) => i);
    const token = generateInviteToken(() => bytes);
    expect(INVITE_TOKEN_PATTERN.test(token)).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token.length).toBeLessThanOrEqual(64);
  });

  it("produces distinct tokens from the live crypto source", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(isValidInviteToken(a)).toBe(true);
    expect(isValidInviteToken(b)).toBe(true);
  });

  it("rejects the sequential pool id and other malformed tokens", () => {
    expect(isValidInviteToken("1")).toBe(false); // a pool id is not a token
    expect(isValidInviteToken("42")).toBe(false);
    expect(isValidInviteToken("short")).toBe(false);
    expect(isValidInviteToken("has spaces in it aaaaaaaaaaaaaaaa")).toBe(false);
    expect(isValidInviteToken("contains/slash/aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      false,
    );
    expect(isValidInviteToken("a".repeat(65))).toBe(false); // too long
  });
});

describe("checkMessage", () => {
  it("treats absent or blank as null (the column is nullable)", () => {
    expect(checkMessage(undefined)).toEqual({ ok: true, message: null });
    expect(checkMessage(null)).toEqual({ ok: true, message: null });
    expect(checkMessage("   ")).toEqual({ ok: true, message: null });
  });

  it("trims and keeps a normal message", () => {
    expect(checkMessage("  bet you can't  ")).toEqual({
      ok: true,
      message: "bet you can't",
    });
  });

  it("rejects a message over the column length", () => {
    const result = checkMessage("x".repeat(MESSAGE_MAX + 1));
    expect(result.ok).toBe(false);
  });

  it("accepts exactly the max length", () => {
    const result = checkMessage("x".repeat(MESSAGE_MAX));
    expect(result).toEqual({ ok: true, message: "x".repeat(MESSAGE_MAX) });
  });
});

describe("checkTargetHandle", () => {
  it("treats absent or blank as null", () => {
    expect(checkTargetHandle(undefined)).toEqual({
      ok: true,
      targetHandle: null,
    });
    expect(checkTargetHandle("")).toEqual({ ok: true, targetHandle: null });
  });

  it("trims and keeps a normal label", () => {
    expect(checkTargetHandle("  my son  ")).toEqual({
      ok: true,
      targetHandle: "my son",
    });
  });

  it("rejects a label over the column length", () => {
    const result = checkTargetHandle("x".repeat(TARGET_HANDLE_MAX + 1));
    expect(result.ok).toBe(false);
  });
});

describe("challengeShareUrl", () => {
  it("builds the /c/<token> path and does not double the slash", () => {
    expect(challengeShareUrl("https://gohealthme.app", "tok_abc")).toBe(
      "https://gohealthme.app/c/tok_abc",
    );
    expect(challengeShareUrl("https://gohealthme.app/", "tok_abc")).toBe(
      "https://gohealthme.app/c/tok_abc",
    );
  });
});
