import { describe, it, expect } from "vitest";
import {
  checkEmoji,
  checkHandle,
  displayNameFor,
  EMOJI_MAX,
  normalizeAddress,
  RESERVED_HANDLES,
  shortAddress,
} from "@/lib/social";

const ADDR = "0xAbC0000000000000000000000000000000000123";

describe("checkHandle", () => {
  it("lowercases and accepts a valid handle", () => {
    const result = checkHandle("IronHabit");
    expect(result).toEqual({ ok: true, handle: "ironhabit" });
  });

  it("accepts letters, numbers, and underscores", () => {
    expect(checkHandle("nova_eth_2").ok).toBe(true);
  });

  it("rejects too-short handles", () => {
    expect(checkHandle("ab").ok).toBe(false);
  });

  it("rejects too-long handles", () => {
    expect(checkHandle("a".repeat(21)).ok).toBe(false);
  });

  it("rejects disallowed characters", () => {
    expect(checkHandle("bad-handle").ok).toBe(false);
    expect(checkHandle("bad handle").ok).toBe(false);
    expect(checkHandle("@handle").ok).toBe(false);
  });

  it("rejects reserved handles", () => {
    for (const reserved of RESERVED_HANDLES) {
      expect(checkHandle(reserved).ok).toBe(false);
      expect(checkHandle(reserved.toUpperCase()).ok).toBe(false);
    }
  });
});

describe("checkEmoji", () => {
  it("treats absent or blank as null", () => {
    expect(checkEmoji(null)).toEqual({ ok: true, emoji: null });
    expect(checkEmoji(undefined)).toEqual({ ok: true, emoji: null });
    expect(checkEmoji("   ")).toEqual({ ok: true, emoji: null });
  });

  it("keeps a short glyph as data", () => {
    // An astral glyph built from its code point, so no literal emoji lives in
    // source; checkEmoji preserves it verbatim as user data.
    const glyph = String.fromCodePoint(0x1f98d);
    expect(checkEmoji(glyph)).toEqual({ ok: true, emoji: glyph });
  });

  it("counts length by code points, not UTF-16 units", () => {
    // Eight astral glyphs = 8 code points but 16 UTF-16 units. char_length in
    // Postgres counts 8, so the check must too and must accept this.
    const eight = String.fromCodePoint(0x1f98d).repeat(8);
    expect([...eight].length).toBe(8);
    expect(checkEmoji(eight).ok).toBe(true);
  });

  it("rejects an over-long value by code points", () => {
    const tooLong = "x".repeat(EMOJI_MAX + 1);
    expect(checkEmoji(tooLong).ok).toBe(false);
  });
});

describe("normalizeAddress", () => {
  it("lowercases a valid address", () => {
    expect(normalizeAddress(ADDR)).toBe(ADDR.toLowerCase());
  });

  it("returns null for a non-address", () => {
    expect(normalizeAddress("not-an-address")).toBeNull();
    expect(normalizeAddress("0x123")).toBeNull();
  });
});

describe("displayNameFor", () => {
  it("prefers the handle when one is claimed", () => {
    expect(displayNameFor(ADDR, "ironhabit")).toBe("@ironhabit");
  });

  it("falls back to the short address when unclaimed", () => {
    expect(displayNameFor(ADDR, null)).toBe(shortAddress(ADDR));
    expect(displayNameFor(ADDR, "")).toBe(shortAddress(ADDR));
  });
});
