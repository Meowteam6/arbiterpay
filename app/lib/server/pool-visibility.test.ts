// The pure decision helpers behind pool visibility. The store-first resolution
// and fail-safe-private posture are exercised end to end against Supabase and
// the chain at runtime; pinned here are the two rules that must never drift:
// the enum coercion, and the initiative default that keeps a challenge private
// and every other pool public when no store row exists.

import { describe, it, expect } from "vitest";
import {
  defaultVisibilityForInitiative,
  normalizeVisibility,
} from "@/lib/server/pool-visibility";

describe("normalizeVisibility", () => {
  it("passes through the two valid enum values", () => {
    expect(normalizeVisibility("public")).toBe("public");
    expect(normalizeVisibility("private")).toBe("private");
  });

  it("rejects anything else as null so a bad row is never trusted", () => {
    expect(normalizeVisibility("")).toBeNull();
    expect(normalizeVisibility("PUBLIC")).toBeNull();
    expect(normalizeVisibility("hidden")).toBeNull();
    expect(normalizeVisibility(null)).toBeNull();
    expect(normalizeVisibility(undefined)).toBeNull();
  });
});

describe("defaultVisibilityForInitiative", () => {
  it("defaults a challenge to private", () => {
    expect(defaultVisibilityForInitiative("challenge")).toBe("private");
  });

  it("defaults every other initiative to public", () => {
    expect(defaultVisibilityForInitiative("sleep")).toBe("public");
    expect(defaultVisibilityForInitiative("flu-shot")).toBe("public");
    expect(defaultVisibilityForInitiative("")).toBe("public");
  });
});
