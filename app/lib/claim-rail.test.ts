import { describe, it, expect } from "vitest";
import { claimStepOf, claimStepIndex, CLAIM_STEPS } from "@/lib/claim-rail";

describe("claimStepOf", () => {
  it("is join until the wallet has joined", () => {
    expect(claimStepOf(false, false, null)).toBe("join");
    // Even a stray claim status cannot advance an unjoined wallet.
    expect(claimStepOf(false, true, "verifying")).toBe("join");
  });

  it("is prove once joined but before any claim exists", () => {
    expect(claimStepOf(true, false, null)).toBe("prove");
    // hasClaim false wins even if a status leaked through.
    expect(claimStepOf(true, false, "verifying")).toBe("prove");
    // Joined with a claim but an unreadable status falls back to prove, never
    // fabricates a later step.
    expect(claimStepOf(true, true, null)).toBe("prove");
  });

  it("is checking while a claim is mid-flight", () => {
    expect(claimStepOf(true, true, "verifying")).toBe("checking");
  });

  it("only reaches paid on a settled payout", () => {
    expect(claimStepOf(true, true, "paid")).toBe("paid");
  });

  it("keeps a verified-but-deferred verdict OUT of paid", () => {
    // The load-bearing rule: recorded is a deferred settlement, not a payout.
    expect(claimStepOf(true, true, "recorded")).toBe("verdict");
  });

  it("maps every non-paying terminal outcome to verdict", () => {
    for (const status of ["no-pay", "cap-exceeded", "blocked", "error"] as const) {
      expect(claimStepOf(true, true, status)).toBe("verdict");
    }
  });
});

describe("claimStepIndex", () => {
  it("orders the five steps join -> prove -> checking -> verdict -> paid", () => {
    expect(CLAIM_STEPS.map((s) => s.id)).toEqual([
      "join",
      "prove",
      "checking",
      "verdict",
      "paid",
    ]);
    expect(claimStepIndex("join")).toBe(0);
    expect(claimStepIndex("paid")).toBe(4);
    expect(claimStepIndex("checking")).toBeGreaterThan(claimStepIndex("prove"));
    expect(claimStepIndex("verdict")).toBeGreaterThan(claimStepIndex("checking"));
  });
});
