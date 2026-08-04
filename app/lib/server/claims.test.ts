import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";

// The claim flag is the last thing between one reward and two payouts, so the
// tests here are mostly about what happens when two requests arrive together:
// exactly one caller may win, and a goal claimed before this store changed
// shape must still read as claimed.

async function loadClaims() {
  vi.stubEnv("DATA_DIR", mkdtempSync(path.join(os.tmpdir(), "claims-")));
  vi.resetModules();
  return {
    claims: await import("@/lib/server/claims"),
    store: await import("@/lib/server/store"),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("claims store", () => {
  it("reports unclaimed goals as not claimed, then claimed after marking", async () => {
    const { claims } = await loadClaims();
    expect(await claims.isClaimed("goal-1")).toBe(false);
    await claims.markClaimed("goal-1");
    expect(await claims.isClaimed("goal-1")).toBe(true);
  });

  it("hands the claim to exactly one of many concurrent callers", async () => {
    const { claims } = await loadClaims();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => claims.tryMarkClaimed("goal-1")),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claims.isClaimed("goal-1")).toBe(true);
  });

  it("throws for the loser of a concurrent markClaimed rather than double-paying", async () => {
    const { claims } = await loadClaims();

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => claims.markClaimed("goal-1")),
    );

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of settled) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(claims.ClaimAlreadyHeldError);
      }
    }
  });

  it("treats goal ids as case-insensitive so one goal cannot be claimed twice", async () => {
    const { claims } = await loadClaims();
    expect(await claims.tryMarkClaimed("0xAB")).toBe(true);
    expect(await claims.tryMarkClaimed("0xab")).toBe(false);
    expect(await claims.isClaimed("0xaB")).toBe(true);
  });

  it("releases a claim so a failed payout can be retried", async () => {
    const { claims } = await loadClaims();
    expect(await claims.tryMarkClaimed("goal-1")).toBe(true);
    await claims.unmarkClaimed("goal-1");
    expect(await claims.isClaimed("goal-1")).toBe(false);
    expect(await claims.tryMarkClaimed("goal-1")).toBe(true);
  });

  it("honours claims recorded in the pre-migration blob", async () => {
    const { claims, store } = await loadClaims();
    await store.writeJson("claims.json", { "goal-legacy": true });

    expect(await claims.isClaimed("goal-legacy")).toBe(true);
    expect(await claims.tryMarkClaimed("goal-legacy")).toBe(false);

    await claims.unmarkClaimed("goal-legacy");
    expect(await claims.isClaimed("goal-legacy")).toBe(false);
    expect(await claims.tryMarkClaimed("goal-legacy")).toBe(true);
  });

  it("links and resolves a userId to an unlink address", async () => {
    const { claims } = await loadClaims();
    await claims.linkUnlinkAddress("user-A", "unlink1abc");
    expect(await claims.getUnlinkAddress("user-A")).toBe("unlink1abc");
    expect(await claims.userOwnsUnlinkAddress("user-A", "unlink1abc")).toBe(
      true,
    );
    expect(await claims.userOwnsUnlinkAddress("user-A", "unlink1xyz")).toBe(
      false,
    );
    expect(await claims.getUnlinkAddress("user-B")).toBeNull();
  });

  it("keeps every address when several users link at the same time", async () => {
    const { claims } = await loadClaims();
    const users = Array.from({ length: 20 }, (_, i) => `user-${i}`);

    await Promise.all(
      users.map((user) => claims.linkUnlinkAddress(user, `unlink1${user}`)),
    );

    for (const user of users) {
      expect(await claims.getUnlinkAddress(user)).toBe(`unlink1${user}`);
    }
  });

  it("still resolves addresses written to the pre-migration blob", async () => {
    const { claims, store } = await loadClaims();
    await store.writeJson("unlink-addresses.json", { "user-old": "unlink1old" });
    expect(await claims.getUnlinkAddress("user-old")).toBe("unlink1old");
  });
});
