import { describe, it, expect } from "vitest";
import {
  failureModeOf,
  projectReceipt,
  toUsd2,
  type LedgerEntry,
} from "@/lib/agent-receipt";

// The receipt projection is what stands between the ledger and the screen.
// Pinned here: planned rows print before their prices, an unplanned spend
// stays visibly unplanned, and paid money comes only from a settled entry.

const AT = "2026-08-01T00:00:00.000Z";

function planEntry(): LedgerEntry {
  return {
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
  };
}

function spendEntry(overrides: Partial<Extract<LedgerEntry, { kind: "spend" }>> = {}): LedgerEntry {
  return {
    kind: "spend",
    at: AT,
    service: "attester-read",
    label: "document read (TEE attester)",
    amountUsd: "0.02",
    ref: "job-1",
    settlement: "prepaid",
    ...overrides,
  };
}

describe("toUsd2", () => {
  it("normalizes chain-formatted amounts to two decimals without rounding up", () => {
    expect(toUsd2("50")).toBe("50.00");
    expect(toUsd2("0.410000")).toBe("0.41");
    expect(toUsd2("0.5")).toBe("0.50");
    expect(toUsd2("12.999")).toBe("12.99");
  });
});

describe("projectReceipt", () => {
  it("prints a planned step before its price, then fills it in place", () => {
    const planned = projectReceipt([planEntry()]);
    expect(planned.capUsd).toBe("1.00");
    expect(planned.spentUsd).toBe("0.00");
    expect(planned.rows).toEqual([
      {
        kind: "spend",
        label: "document read (TEE attester)",
        planned: true,
        estUsd: "0.02",
        paidUsd: null,
        settlement: null,
        note: null,
      },
    ]);

    const bought = projectReceipt([planEntry(), spendEntry()]);
    expect(bought.rows).toHaveLength(1);
    expect(bought.rows[0]).toMatchObject({ planned: true, paidUsd: "0.02" });
    expect(bought.spentUsd).toBe("0.02");
  });

  it("renders an escalation as an unplanned row and keeps the running total", () => {
    const ledger: LedgerEntry[] = [
      planEntry(),
      spendEntry(),
      {
        kind: "verdict",
        at: AT,
        verified: false,
        confidence: "low",
        reason: "no readable text",
        ref: "job-1",
      },
      spendEntry({
        service: "vision-judge",
        label: "vision judge (Gemini)",
        amountUsd: "0.35",
        note: "escalating. i can't read this and i'm not paying out 50.00 USDC on something i can't read.",
      }),
    ];

    const receipt = projectReceipt(ledger);

    expect(receipt.spentUsd).toBe("0.37");
    const spends = receipt.rows.filter((r) => r.kind === "spend");
    expect(spends[1]).toMatchObject({
      planned: false,
      estUsd: null,
      paidUsd: "0.35",
    });
    // Chronology holds: the escalation row lands after the verdict it reacts to.
    expect(receipt.rows.map((r) => r.kind)).toEqual([
      "spend",
      "verdict",
      "spend",
    ]);
  });

  it("reports paid money only from a settled entry", () => {
    const base: LedgerEntry[] = [planEntry(), spendEntry()];
    expect(projectReceipt(base).paidUsd).toBeNull();

    const deferred = projectReceipt([
      ...base,
      { kind: "settle", at: AT, status: "deferred", note: "period ends soon" },
    ]);
    expect(deferred.paidUsd).toBeNull();

    const settled = projectReceipt([
      ...base,
      { kind: "settle", at: AT, status: "settled", txHash: "0xfeed", paidUsd: "50" },
    ]);
    expect(settled.paidUsd).toBe("50.00");
  });
});

describe("failureModeOf", () => {
  const noPay: LedgerEntry = {
    kind: "reason",
    at: AT,
    decision: "no-pay",
    note: "not paying.",
  };

  it("is null while undecided or on a pay", () => {
    expect(failureModeOf([planEntry()])).toBeNull();
    expect(
      failureModeOf([
        { kind: "reason", at: AT, decision: "pay", note: "paying." },
      ]),
    ).toBeNull();
  });

  it("blames the photo on a low-confidence read and the goal on a confident miss", () => {
    const lowRead: LedgerEntry = {
      kind: "verdict",
      at: AT,
      verified: false,
      confidence: "low",
      reason: "no readable text",
      ref: "job-1",
    };
    const confidentMiss: LedgerEntry = {
      kind: "verdict",
      at: AT,
      verified: false,
      confidence: "high",
      reason: "document shows a dental cleaning, not a flu shot",
      ref: "job-1",
    };
    expect(failureModeOf([lowRead, noPay])).toBe("evidence");
    expect(failureModeOf([confidentMiss, noPay])).toBe("goal-missed");
  });
});
