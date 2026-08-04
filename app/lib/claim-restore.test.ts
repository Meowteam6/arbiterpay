// A restored claim has to reopen on the tab that owns it. These cases pin the
// two ledger shapes that carry the answer (the plan, and the cheap read that
// followed it) and the retry case, where the newest attempt wins.

import { describe, it, expect } from "vitest";
import { claimProofPathOf } from "@/lib/claim-restore";
import type { LedgerEntry } from "@/lib/agent-receipt";

const AT = "2026-08-04T10:00:00.000Z";

function plan(service: string): LedgerEntry {
  return {
    at: AT,
    kind: "plan",
    steps: [{ service, label: "cheap read", estUsd: "0.01" }],
    capUsd: "1.00",
  };
}

function spend(service: string, ref: string): LedgerEntry {
  return {
    at: AT,
    kind: "spend",
    service,
    label: "cheap read",
    amountUsd: "0.01",
    ref,
    settlement: "prepaid",
  };
}

const VERDICT: LedgerEntry = {
  at: AT,
  kind: "verdict",
  verified: true,
  confidence: "high",
  reason: "goal met",
  ref: "job-1",
};

describe("claimProofPathOf", () => {
  it("has no answer for an empty ledger", () => {
    expect(claimProofPathOf([])).toBeNull();
  });

  it("reads the wearable path off the junction read", () => {
    expect(
      claimProofPathOf([
        plan("junction-read"),
        spend("junction-read", "wearable-1750000000"),
        VERDICT,
      ]),
    ).toBe("wearable");
  });

  it("reads the document path off the attester read", () => {
    expect(
      claimProofPathOf([
        plan("attester-read"),
        spend("attester-read", "job-1"),
        VERDICT,
      ]),
    ).toBe("document");
  });

  it("answers from the plan alone when the buy never landed", () => {
    expect(claimProofPathOf([plan("junction-read")])).toBe("wearable");
    expect(claimProofPathOf([plan("attester-read")])).toBe("document");
  });

  it("treats a vision-judge escalation as the document path", () => {
    expect(
      claimProofPathOf([spend("vision-judge", "job-1:vision-judge")]),
    ).toBe("document");
  });

  it("ignores the settlement chain read, which both paths buy", () => {
    expect(
      claimProofPathOf([
        plan("junction-read"),
        spend("junction-read", "wearable-1"),
        spend("chain-read", "0xdeadbeef"),
      ]),
    ).toBe("wearable");
  });

  it("resolves a retried claim to the path that ran last", () => {
    expect(
      claimProofPathOf([
        plan("junction-read"),
        spend("junction-read", "wearable-1"),
        spend("attester-read", "job-2"),
      ]),
    ).toBe("document");
  });

  it("has no answer when nothing names a path", () => {
    expect(claimProofPathOf([VERDICT])).toBeNull();
    expect(claimProofPathOf([spend("chain-read", "0xdead")])).toBeNull();
  });
});
