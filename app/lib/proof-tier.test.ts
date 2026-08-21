// The verdict tier representation: how self-reported is kept distinct from the
// verified tier on every plane. Pinned here: the on-chain facet is 0 (asserts
// NO verified facet, never FACET_AI_ATTESTED), the multiplier is forced to 1x
// and confidence clamped to at most medium, and the receipt projection carries
// the selfReported flag so no self-reported verdict can render as "verified".

import { describe, it, expect } from "vitest";
import { VERDICT_FACETS } from "@/lib/server/verdict";
import {
  clampConfidenceForSelfReported,
  multiplierForConfidence,
  multiplierForVerdict,
} from "@/lib/server/judge";
import { projectReceipt, type LedgerEntry } from "@/lib/agent-receipt";
import {
  FACET_AI_ATTESTED,
  FACET_WEARABLE,
  challengeAwaitingSettleStatus,
  dashboardDeferredLead,
  profileWinPresentation,
  proofTierFromVerdict,
  railDeferredCopy,
  tallyWinTiers,
  type ProofTier,
} from "@/lib/proof-tier";

const AT = "2026-08-20T00:00:00.000Z";

describe("VERDICT_FACETS on-chain bitmap", () => {
  it("asserts no facet for self-reported (bitmap 0)", () => {
    expect(VERDICT_FACETS["self-reported"]).toBe(0);
  });

  it("never sets the AI-attested bit for self-reported", () => {
    // Document is the AI-attested tier; self-reported must be a different,
    // lower value that shares no bits with it.
    expect(VERDICT_FACETS["self-reported"] & VERDICT_FACETS.document).toBe(0);
    expect(VERDICT_FACETS["self-reported"]).not.toBe(VERDICT_FACETS.document);
    expect(VERDICT_FACETS["self-reported"]).not.toBe(VERDICT_FACETS.wearable);
  });
});

describe("multiplierForVerdict", () => {
  it("forces self-reported to 1x regardless of confidence", () => {
    expect(multiplierForVerdict("high", "self-reported")).toBe(10_000n);
    expect(multiplierForVerdict("medium", "self-reported")).toBe(10_000n);
    expect(multiplierForVerdict("low", "self-reported")).toBe(10_000n);
  });

  it("leaves the verified tiers on the confidence-scaled multiplier", () => {
    expect(multiplierForVerdict("high", "document")).toBe(
      multiplierForConfidence("high"),
    );
    expect(multiplierForVerdict("high", "document")).toBe(20_000n);
    expect(multiplierForVerdict("high", "wearable")).toBe(20_000n);
  });
});

describe("clampConfidenceForSelfReported", () => {
  it("caps high at medium but never drops a legible read to low", () => {
    expect(clampConfidenceForSelfReported("high")).toBe("medium");
    expect(clampConfidenceForSelfReported("medium")).toBe("medium");
    expect(clampConfidenceForSelfReported("low")).toBe("low");
  });
});

describe("projectReceipt tier flag", () => {
  it("marks a self-reported verdict row and never the verified one", () => {
    const ledger: LedgerEntry[] = [
      {
        kind: "verdict",
        at: AT,
        verified: true,
        confidence: "medium",
        reason: "the photo plausibly shows the workout",
        ref: "att-1",
        selfReported: true,
      },
    ];
    const row = projectReceipt(ledger).rows.find((r) => r.kind === "verdict");
    expect(row).toMatchObject({ kind: "verdict", selfReported: true });
  });

  it("treats a verdict with no flag as the verified tier (backward compatible)", () => {
    const ledger: LedgerEntry[] = [
      {
        kind: "verdict",
        at: AT,
        verified: true,
        confidence: "high",
        reason: "flu shot on record",
        ref: "att-1",
      },
    ];
    const row = projectReceipt(ledger).rows.find((r) => r.kind === "verdict");
    expect(row).toMatchObject({ kind: "verdict", selfReported: false });
  });
});

// ---------------------------------------------------------------- read-side tier
//
// The on-chain facet bitmap (bitmap 0 => self-reported) is the tamper-evident
// source every read surface uses to keep a self-reported win from ever reading
// as "Verified". These lock that classification and the copy each surface shows.

describe("proofTierFromVerdict", () => {
  it("maps a passing verdict with no facet (bitmap 0) to self-reported", () => {
    expect(proofTierFromVerdict(true, 0)).toBe("self-reported");
  });

  it("maps a passing verdict with a trust facet to verified", () => {
    expect(proofTierFromVerdict(true, FACET_WEARABLE)).toBe("verified");
    expect(proofTierFromVerdict(true, FACET_AI_ATTESTED)).toBe("verified");
  });

  it("maps a non-passing (or absent) verdict to unknown, never verified", () => {
    expect(proofTierFromVerdict(false, 0)).toBe("unknown");
    expect(proofTierFromVerdict(false, FACET_WEARABLE)).toBe("unknown");
  });

  it("agrees with the on-chain facets the agent actually writes", () => {
    // The write side (VERDICT_FACETS) and this read side must never disagree,
    // or a self-reported win recorded as bitmap 0 could read back as verified.
    expect(proofTierFromVerdict(true, VERDICT_FACETS["self-reported"])).toBe(
      "self-reported",
    );
    expect(proofTierFromVerdict(true, VERDICT_FACETS.document)).toBe("verified");
    expect(proofTierFromVerdict(true, VERDICT_FACETS.wearable)).toBe("verified");
  });
});

describe("tallyWinTiers (the verified-wins stat)", () => {
  it("never folds self-reported wins into the verified count", () => {
    const tiers: ProofTier[] = [
      "verified",
      "self-reported",
      "verified",
      "self-reported",
      "self-reported",
      "unknown",
    ];
    expect(tallyWinTiers(tiers)).toEqual({
      verifiedWins: 2,
      selfReportedWins: 3,
    });
  });

  it("counts a profile with only self-reported wins as zero verified", () => {
    expect(tallyWinTiers(["self-reported", "self-reported"])).toEqual({
      verifiedWins: 0,
      selfReportedWins: 2,
    });
  });
});

describe("profileWinPresentation (paid-wall win rows)", () => {
  it("renders a self-reported achiever win as self-reported, never verified", () => {
    const p = profileWinPresentation("achiever", "self-reported");
    expect(p.label).toBe("Self-reported win");
    expect(p.label).not.toMatch(/verified/i);
    expect(p.showCheck).toBe(false);
    expect(p.tone).toBe("warning");
    expect(p.sublabel).toMatch(/unverified/i);
  });

  it("renders a verified achiever win with a check badge", () => {
    const p = profileWinPresentation("achiever", "verified");
    expect(p.label).toBe("Verified win");
    expect(p.showCheck).toBe(true);
  });

  it("never presents an unknown-tier win as verified", () => {
    const p = profileWinPresentation("achiever", "unknown");
    expect(p.label).not.toMatch(/verified/i);
    expect(p.showCheck).toBe(false);
  });

  it("leaves a backer win unchanged", () => {
    const p = profileWinPresentation("backer", null);
    expect(p.label).toBe("Backed a winner");
  });
});

describe("dashboardDeferredLead (settling-claim card)", () => {
  it("never leads a self-reported deferred claim with Verified", () => {
    const d = dashboardDeferredLead("self-reported");
    expect(d.lead).not.toMatch(/^Verified/);
    expect(d.lead).toMatch(/self-reported/i);
    expect(d.lead).toMatch(/not verified/i);
    expect(d.tone).toBe("warning");
    expect(d.selfReported).toBe(true);
  });

  it("leads a verified deferred claim with Verified", () => {
    expect(dashboardDeferredLead("verified").lead).toMatch(/^Verified/);
  });

  it("stays neutral (never Verified) when the tier is unknown", () => {
    const d = dashboardDeferredLead("unknown");
    expect(d.lead).not.toMatch(/verified/i);
    expect(dashboardDeferredLead(null).lead).not.toMatch(/verified/i);
  });
});

describe("challengeAwaitingSettleStatus", () => {
  it("never labels a self-reported challenge Verified", () => {
    const s = challengeAwaitingSettleStatus("self-reported");
    expect(s.label).toBe("Self-reported - awaiting settle");
    expect(s.label).not.toMatch(/verified/i);
    expect(s.tone).toBe("warning");
  });

  it("labels a verified challenge Verified - awaiting settle", () => {
    expect(challengeAwaitingSettleStatus("verified").label).toBe(
      "Verified - awaiting settle",
    );
  });

  it("stays neutral when the tier is unknown", () => {
    expect(challengeAwaitingSettleStatus("unknown").label).not.toMatch(
      /verified/i,
    );
    expect(challengeAwaitingSettleStatus(null).label).not.toMatch(/verified/i);
  });
});

describe("railDeferredCopy (claim rail)", () => {
  it("never reads as a positive Verified for a self-reported deferred verdict", () => {
    // "unverified" (the negation) is fine; a positive "Verified" claim is the
    // leak, so guard the leading positive assertion, not the substring.
    expect(railDeferredCopy(true)).not.toMatch(/^Verified\b/);
    expect(railDeferredCopy(true)).toMatch(/self-reported/i);
    expect(railDeferredCopy(true)).toMatch(/unverified/i);
  });

  it("reads Verified for a verified deferred verdict", () => {
    expect(railDeferredCopy(false)).toMatch(/^Verified/);
  });
});
