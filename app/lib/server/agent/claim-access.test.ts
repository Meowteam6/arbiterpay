// The rule that decides who reads a claim's prose. One function serves both
// verbs of the run route, so this is the only place the rule can drift.

import { describe, it, expect } from "vitest";
import type { LedgerEntry } from "@/lib/server/agent/ledger";
import {
  claimParticipantOf,
  isClaimOwner,
  projectClaimForCaller,
} from "@/lib/server/agent/claim-access";

const OWNER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const STRANGER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const GOAL = `0x${"ab".repeat(32)}`;

const PROSE = "the record shows a quadrivalent influenza vaccine on 2026-03-02";

function ledger(): LedgerEntry[] {
  return [
    {
      at: "2026-08-04T12:00:00.000Z",
      kind: "plan",
      steps: [{ service: "attester-read", label: "TEE read", estUsd: "0.10" }],
      capUsd: "1.00",
      poolId: "7",
      participant: OWNER,
    },
    {
      at: "2026-08-04T12:00:01.000Z",
      kind: "spend",
      service: "attester-read",
      label: "TEE read",
      amountUsd: "0.10",
      ref: "att-1",
      settlement: "x402",
    },
    {
      at: "2026-08-04T12:00:02.000Z",
      kind: "verdict",
      verified: true,
      confidence: "high",
      reason: PROSE,
      ref: "att-1",
    },
    {
      at: "2026-08-04T12:00:03.000Z",
      kind: "reason",
      decision: "pay",
      note: "the enclave read the immunisation record and it matches the goal",
      ref: "att-1",
    },
  ];
}

describe("claimParticipantOf", () => {
  it("reads the wallet the run loop froze into the plan", () => {
    expect(claimParticipantOf(ledger())).toBe(OWNER);
  });

  it("checksums whatever casing the ledger holds", () => {
    const entries = ledger();
    const plan = entries[0];
    if (plan.kind === "plan") plan.participant = OWNER.toLowerCase();
    expect(claimParticipantOf(entries)).toBe(OWNER);
  });

  it("has no answer for an empty ledger", () => {
    expect(claimParticipantOf([])).toBeNull();
  });

  it("fails closed on a ledger written before the plan carried a participant", () => {
    const entries = ledger();
    const plan = entries[0];
    if (plan.kind === "plan") delete plan.participant;
    expect(claimParticipantOf(entries)).toBeNull();
  });

  it("fails closed on a corrupt participant field", () => {
    const entries = ledger();
    const plan = entries[0];
    if (plan.kind === "plan") plan.participant = "not-an-address";
    expect(claimParticipantOf(entries)).toBeNull();
  });
});

describe("isClaimOwner", () => {
  it("recognises the participant", () => {
    expect(isClaimOwner(ledger(), OWNER)).toBe(true);
    expect(isClaimOwner(ledger(), OWNER.toLowerCase())).toBe(true);
  });

  it("refuses everybody else", () => {
    expect(isClaimOwner(ledger(), STRANGER)).toBe(false);
    expect(isClaimOwner(ledger(), null)).toBe(false);
    expect(isClaimOwner(ledger(), "0xnonsense")).toBe(false);
  });

  it("refuses when the claim has no derivable owner", () => {
    expect(isClaimOwner([], OWNER)).toBe(false);
  });
});

describe("projectClaimForCaller", () => {
  it("hands the owner the ledger verbatim", () => {
    const result = projectClaimForCaller({
      goalId: GOAL,
      ledger: ledger(),
      access: "owner",
    });
    expect(result.ledger).toEqual(ledger());
    expect(result.hasLedger).toBe(true);
    expect(result.access).toBe("owner");
  });

  it("encloses the ledger for the owner access level and no other", () => {
    for (const access of ["not-owner", "unproven"] as const) {
      const result = projectClaimForCaller({
        goalId: GOAL,
        ledger: ledger(),
        access,
      });
      expect(result.ledger).toBeNull();
      expect(result.access).toBe(access);
    }
  });

  it("gives everyone else money facts and no prose", () => {
    const result = projectClaimForCaller({
      goalId: GOAL,
      ledger: ledger(),
      access: "not-owner",
    });

    expect(result.ledger).toBeNull();
    expect(JSON.stringify(result)).not.toContain(PROSE);
    expect(JSON.stringify(result)).not.toMatch(/influenza|immunisation/i);
    // The machine states still cross - they are what the public feed shows.
    expect(result.claim.decision).toBe("pay");
    expect(result.claim.spends).toHaveLength(1);
  });

  it("says a claim exists without saying what is in it", () => {
    // This flag is the difference between "nothing here yet, upload" and
    // "there is a claim and it is being withheld". It discloses nothing new:
    // /api/agent/feed already publishes the goal ids of live claims.
    const result = projectClaimForCaller({
      goalId: GOAL,
      ledger: ledger(),
      access: "unproven",
    });
    expect(result.hasLedger).toBe(true);
  });

  it("reports an unknown goal as empty for the owner too", () => {
    const result = projectClaimForCaller({
      goalId: GOAL,
      ledger: [],
      access: "owner",
    });
    expect(result.hasLedger).toBe(false);
    expect(result.ledger).toEqual([]);
    expect(result.claim.at).toBe("");
  });
});
