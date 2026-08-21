// The redaction between SPOTTER's ledger and the public feed. Pinned here:
// no model prose, no notes, no goal text, and no error diagnostics survive
// the projection - only money facts, statuses, tx hashes, and timestamps.

import { describe, it, expect } from "vitest";
import { toPublicFeedClaim } from "@/lib/server/agent/feed-view";
import type { LedgerEntry } from "@/lib/server/agent/ledger";

const AT = "2026-08-01T00:00:00.000Z";
const GOAL = "0x" + "ab".repeat(32);

const VERDICT_PROSE =
  "the uploaded chart shows an influenza vaccination administered at a clinic on 2026-07-12";
const REASON_PROSE =
  "paying. the flu shot record is legible and matches the goal.";
const ERROR_PROSE =
  "settle: canSettle(0x9f3a) is false - settling now would pay this participant nothing. Record the verdict first.";

function fullLedger(): LedgerEntry[] {
  return [
    {
      kind: "plan",
      at: AT,
      capUsd: "1.00",
      steps: [
        {
          service: "attester-read",
          label: "document read (TEE attester)",
          estUsd: "0.02",
        },
      ],
    },
    {
      kind: "spend",
      at: AT,
      service: "attester-read",
      label: "document read (TEE attester)",
      amountUsd: "0.02",
      ref: "job-1",
      settlement: "x402",
      note: "escalating. i can't read this. gateway tx 0xgw123",
    },
    {
      kind: "verdict",
      at: AT,
      verified: true,
      confidence: "high",
      reason: VERDICT_PROSE,
      ref: "job-1",
    },
    { kind: "reason", at: AT, decision: "pay", note: REASON_PROSE },
    {
      kind: "record",
      at: AT,
      goalId: GOAL,
      resultTx: "0xresult",
      registryStatus: "recorded",
      registryTx: "0xregistry",
    },
    { kind: "error", at: AT, stage: "settle", message: ERROR_PROSE },
    {
      kind: "settle",
      at: AT,
      status: "settled",
      txHash: "0xsettle",
      paidUsd: "50.00",
    },
  ];
}

describe("toPublicFeedClaim", () => {
  it("carries only money facts, statuses, tx hashes, and timestamps", () => {
    const claim = toPublicFeedClaim(GOAL, AT, fullLedger());

    expect(claim).toEqual({
      goalId: GOAL,
      at: AT,
      decision: "pay",
      spends: [
        {
          at: AT,
          label: "document read (TEE attester)",
          amountUsd: "0.02",
          settlement: "x402",
        },
      ],
      recordTxs: { resultTx: "0xresult", registryTx: "0xregistry" },
      settle: {
        at: AT,
        status: "settled",
        paidUsd: "50.00",
        txHash: "0xsettle",
        periodEndIso: null,
      },
      selfReported: false,
    });
  });

  it("drops every piece of prose in the ledger", () => {
    const text = JSON.stringify(toPublicFeedClaim(GOAL, AT, fullLedger()));

    expect(text).not.toContain("influenza");
    expect(text).not.toContain("flu shot");
    expect(text).not.toContain("escalating");
    expect(text).not.toContain("canSettle");
    expect(text).not.toContain(VERDICT_PROSE);
    expect(text).not.toContain(REASON_PROSE);
    expect(text).not.toContain('"note"');
    expect(text).not.toContain('"reason"');
    expect(text).not.toContain('"message"');
  });

  it("passes periodEndIso through on a deferred settle without its note", () => {
    const deferred = {
      kind: "settle",
      at: AT,
      status: "deferred",
      note: "pool period ends at 1791000000; settling the moment it does",
      periodEndIso: "2026-10-03T08:00:00.000Z",
    } as LedgerEntry;

    const claim = toPublicFeedClaim(GOAL, AT, [deferred]);

    expect(claim.settle).toEqual({
      at: AT,
      status: "deferred",
      paidUsd: null,
      txHash: null,
      periodEndIso: "2026-10-03T08:00:00.000Z",
    });
    expect(JSON.stringify(claim)).not.toContain("pool period ends");
  });

  it("promotes deferred to settled in the order real ledgers write them", () => {
    // Every real ledger defers first and settles later; the settled entry
    // must win or every paid claim degrades to an eternal "deferred".
    const ledger: LedgerEntry[] = [
      { kind: "settle", at: AT, status: "deferred", note: "waiting" },
      {
        kind: "settle",
        at: AT,
        status: "settled",
        txHash: "0xsettle",
        paidUsd: "50.00",
      },
    ];

    const claim = toPublicFeedClaim(GOAL, AT, ledger);

    expect(claim.settle?.status).toBe("settled");
    expect(claim.settle?.paidUsd).toBe("50.00");
    expect(claim.settle?.txHash).toBe("0xsettle");
  });

  it("never lets a later settle row displace the settled end state", () => {
    const ledger: LedgerEntry[] = [
      {
        kind: "settle",
        at: AT,
        status: "settled",
        txHash: "0xsettle",
        paidUsd: "50.00",
      },
      { kind: "settle", at: AT, status: "deferred", note: "late duplicate" },
    ];

    const claim = toPublicFeedClaim(GOAL, AT, ledger);

    expect(claim.settle?.status).toBe("settled");
    expect(claim.settle?.paidUsd).toBe("50.00");
  });

  it("fails closed on unknown ledger kinds carrying prose", () => {
    // Future entry kinds (a Gemini reasoning step, say) must be dropped by
    // default, not leaked by default.
    const unknown = {
      kind: "gemini-thought",
      at: AT,
      note: "the patient chart mentions a chronic condition",
    } as unknown as LedgerEntry;

    const claim = toPublicFeedClaim(GOAL, AT, [unknown]);

    expect(JSON.stringify(claim)).not.toContain("chronic condition");
    expect(claim).toEqual({
      goalId: GOAL,
      at: AT,
      decision: null,
      spends: [],
      recordTxs: null,
      settle: null,
      selfReported: false,
    });
  });

  it("drops corrupt runtime values instead of crashing the public console", () => {
    const corruptSpend = {
      kind: "spend",
      at: AT,
      service: "attester-read",
      label: "document read (TEE attester)",
      amountUsd: undefined,
      ref: "job-1",
      settlement: "x402",
    } as unknown as LedgerEntry;
    const corruptSettle = {
      kind: "settle",
      at: AT,
      status: "deferred",
      periodEndIso: 1791000000,
      paidUsd: null,
    } as unknown as LedgerEntry;

    const claim = toPublicFeedClaim(GOAL, AT, [corruptSpend, corruptSettle]);

    // A spend without a string amount is dropped whole; a non-string
    // periodEndIso becomes null rather than a 1970 date downstream.
    expect(claim.spends).toEqual([]);
    expect(claim.settle).toEqual({
      at: AT,
      status: "deferred",
      paidUsd: null,
      txHash: null,
      periodEndIso: null,
    });
  });

  it("projects an empty ledger to an empty claim", () => {
    expect(toPublicFeedClaim(GOAL, AT, [])).toEqual({
      goalId: GOAL,
      at: AT,
      decision: null,
      spends: [],
      recordTxs: null,
      settle: null,
      selfReported: false,
    });
  });

  it("marks a claim self-reported when a verdict carries the flag", () => {
    const ledger: LedgerEntry[] = [
      {
        kind: "verdict",
        at: AT,
        verified: true,
        confidence: "medium",
        reason: "a gym selfie that plausibly shows the workout",
        ref: "att-self-1",
        selfReported: true,
      },
    ];
    const claim = toPublicFeedClaim(GOAL, AT, ledger);
    expect(claim.selfReported).toBe(true);
    // The tier flag crosses, but the verdict prose never does.
    expect(JSON.stringify(claim)).not.toContain("gym selfie");
  });
});
