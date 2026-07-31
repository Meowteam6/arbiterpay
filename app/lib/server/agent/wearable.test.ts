import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";

// The wearable evidence source is deterministic: a connection check plus a
// streak threshold over the pool period. Pinned here: the three verdict
// shapes of the contract (not connected / streak met / streak short), the
// goalSpec parameter parse with its defaults, the period-window scoping of
// the Junction read, and that a provider outage resolves to an unverified
// verdict rather than a crash - it can never pay a claim.

const isConnected = vi.fn();
const getProgress = vi.fn();

vi.mock("@/lib/server/junction", () => ({
  isConnected: (...args: unknown[]) => isConnected(...args),
  getProgress: (...args: unknown[]) => getProgress(...args),
}));

const { wearableEvidenceSource, parseWearableGoal, junctionReadQuote } =
  await import("@/lib/server/agent/wearable");

const USER = "0x1111111111111111111111111111111111111111" as Address;
// 2025-06-15T15:06:40Z .. 2025-06-22T15:06:40Z
const WINDOW = {
  address: USER,
  periodStart: 1_750_000_000n,
  periodEnd: 1_750_604_800n,
};

function progress(streakDays: number) {
  return {
    streakDays,
    lastNight: 80,
    qualified: false,
    baselineWeekAvg: null,
    days: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("junctionReadQuote", () => {
  it("always quotes prepaid - Junction is metered, never an invented payment", () => {
    expect(junctionReadQuote()).toEqual({
      service: "junction-read",
      label: "wearable summary (Junction)",
      estUsd: "0.01",
      url: null,
    });
  });
});

describe("parseWearableGoal", () => {
  it("reads day count and threshold out of the goal text", () => {
    expect(parseWearableGoal("sleep score 80 for 5 days")).toEqual({
      goalDays: 5,
      threshold: 80,
    });
    expect(parseWearableGoal("hit an 85+ sleep score for 3 nights")).toEqual({
      goalDays: 3,
      threshold: 85,
    });
    expect(parseWearableGoal("7-day sleep streak, score 75+")).toEqual({
      goalDays: 7,
      threshold: 75,
    });
  });

  it("falls back to 7 days at score 75 when the text is not parseable", () => {
    expect(parseWearableGoal("just sleep better")).toEqual({
      goalDays: 7,
      threshold: 75,
    });
    // Out-of-range numbers are treated as unparseable, not truncated.
    expect(parseWearableGoal("sleep score 900 for 500 days")).toEqual({
      goalDays: 7,
      threshold: 75,
    });
  });
});

describe("wearableEvidenceSource", () => {
  it("fails unverified when no wearable is connected", async () => {
    isConnected.mockResolvedValue(false);
    const poll = wearableEvidenceSource(WINDOW);

    const result = await poll("wearable-1750000000", "sleep score 75+ for 7 days");

    expect(result).toEqual({
      status: "failed",
      verdict: {
        verified: false,
        confidence: "low",
        reason:
          "No wearable is connected for this wallet. Connect one from the dashboard and run the check again.",
      },
    });
    expect(getProgress).not.toHaveBeenCalled();
  });

  it("verifies a met streak at high confidence, naming the streak", async () => {
    isConnected.mockResolvedValue(true);
    getProgress.mockResolvedValue(progress(7));
    const poll = wearableEvidenceSource(WINDOW);

    const result = await poll("wearable-1750000000", "sleep score 75+ for 7 days");

    expect(result.status).toBe("completed");
    expect(result.verdict).toMatchObject({ verified: true, confidence: "high" });
    expect(result.verdict?.reason).toContain("7 qualifying days");
    expect(result.verdict?.reason).toContain("7-day goal");
  });

  it("scopes the Junction read to the pool period window", async () => {
    isConnected.mockResolvedValue(true);
    getProgress.mockResolvedValue(progress(7));
    const poll = wearableEvidenceSource(WINDOW);

    await poll("wearable-1750000000", "sleep score 80 for 5 days");

    expect(getProgress).toHaveBeenCalledWith(
      USER,
      80,
      5,
      "2025-06-15",
      "2025-06-22",
    );
  });

  it("reports a short streak honestly, unverified at high confidence", async () => {
    isConnected.mockResolvedValue(true);
    getProgress.mockResolvedValue(progress(3));
    const poll = wearableEvidenceSource(WINDOW);

    const result = await poll("wearable-1750000000", "sleep score 75+ for 7 days");

    expect(result.status).toBe("completed");
    expect(result.verdict).toMatchObject({
      verified: false,
      confidence: "high",
    });
    expect(result.verdict?.reason).toContain("3 of 7");
  });

  it("resolves a Junction outage to a failed unverified verdict, never a throw", async () => {
    isConnected.mockRejectedValue(new Error("Junction /v2/user returned 503"));
    const poll = wearableEvidenceSource(WINDOW);

    const result = await poll("wearable-1750000000", "sleep score 75+ for 7 days");

    expect(result.status).toBe("failed");
    expect(result.verdict).toMatchObject({ verified: false, confidence: "low" });
    expect(result.verdict?.reason).toMatch(/could not be reached/);
  });
});
