import { describe, it, expect } from "vitest";
import {
  currentAttesterIdOf,
  currentReasonEntry,
  currentVerdictEntry,
  deferredPeriodEndMs,
  failureModeOf,
  hasAttesterErrorForAttempt,
  projectReceipt,
  runStatusFromLedger,
  settleRepollDelayMs,
  SETTLE_REPOLL_BUFFER_MS,
  toUsd2,
  type LedgerEntry,
} from "@/lib/agent-receipt";

// The receipt projection is what stands between the ledger and the screen.
// Pinned here: planned rows print before their prices, an unplanned spend
// stays visibly unplanned, and paid money comes only from a settled entry.
// The current-attempt selectors and the ledger-derived run status are pinned
// too: they decide what a returning user is told about their money.

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

function verdictEntry(
  overrides: Partial<Extract<LedgerEntry, { kind: "verdict" }>> = {},
): LedgerEntry {
  return {
    kind: "verdict",
    at: AT,
    verified: false,
    confidence: "low",
    reason: "no readable text",
    ref: "job-1",
    ...overrides,
  };
}

// Reason refs and settle periodEndIso are optional fields the server is
// gaining; built through a cast so this file compiles on either side of that
// merge, exactly like the widened access in agent-receipt.ts itself.
function reasonEntry(
  decision: "pay" | "no-pay",
  ref?: string,
  note = "decided.",
): LedgerEntry {
  return { kind: "reason", at: AT, decision, note, ref } as LedgerEntry;
}

function errorEntry(stage: string, message = "boom"): LedgerEntry {
  return { kind: "error", at: AT, stage, message };
}

function deferredEntry(periodEndIso?: string): LedgerEntry {
  return {
    kind: "settle",
    at: AT,
    status: "deferred",
    note: "period ends soon",
    periodEndIso,
  } as LedgerEntry;
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
    const lowRead = verdictEntry();
    const confidentMiss = verdictEntry({
      confidence: "high",
      reason: "document shows a dental cleaning, not a flu shot",
    });
    expect(failureModeOf([lowRead, noPay])).toBe("evidence");
    expect(failureModeOf([confidentMiss, noPay])).toBe("goal-missed");
  });

  it("reports attester-offline on a fail-closed verdict ref, never blaming the photo", () => {
    const ledger = [
      planEntry(),
      spendEntry({ ref: "fail-abc123" }),
      verdictEntry({ ref: "fail-abc123", reason: "attester unreachable" }),
      noPay,
    ];
    expect(failureModeOf(ledger)).toBe("attester-offline");
    expect(failureModeOf(ledger, "fail-abc123")).toBe("attester-offline");
  });

  it("reports attester-offline on an attester-stage error for this attempt", () => {
    const ledger = [
      planEntry(),
      spendEntry({ ref: "job-2" }),
      errorEntry("attester", "poll transport failed"),
    ];
    expect(failureModeOf(ledger, "job-2")).toBe("attester-offline");
  });

  it("does not let an old attempt's attester error taint a later judged attempt", () => {
    const ledger = [
      planEntry(),
      spendEntry({ ref: "job-1" }),
      errorEntry("attester", "poll transport failed"),
      spendEntry({ ref: "job-2" }),
      verdictEntry({ ref: "job-2", confidence: "high" }),
      reasonEntry("no-pay", "job-2"),
    ];
    expect(failureModeOf(ledger, "job-2")).toBe("goal-missed");
  });

  it("scopes the verdict to the current attempt by ref", () => {
    const ledger = [
      verdictEntry({ ref: "job-1", confidence: "low" }),
      reasonEntry("no-pay", "job-1"),
      verdictEntry({ ref: "job-2", confidence: "high" }),
      reasonEntry("no-pay", "job-2"),
    ];
    expect(failureModeOf(ledger, "job-1")).toBe("evidence");
    expect(failureModeOf(ledger, "job-2")).toBe("goal-missed");
  });

  it("prefers the escalation's second opinion over the cheap read", () => {
    const ledger = [
      verdictEntry({ ref: "job-1", confidence: "low" }),
      verdictEntry({ ref: "job-1:vision-judge", confidence: "high" }),
      reasonEntry("no-pay", "job-1"),
    ];
    expect(failureModeOf(ledger, "job-1")).toBe("goal-missed");
  });

  it("falls back to the LAST entry of kind when no ref matches (legacy ledgers)", () => {
    const ledger = [
      verdictEntry({ ref: "old-a", confidence: "low" }),
      verdictEntry({ ref: "old-b", confidence: "high" }),
      noPay,
    ];
    expect(failureModeOf(ledger, "job-unknown")).toBe("goal-missed");
  });
});

describe("current-attempt selectors", () => {
  it("recovers the current attester id from the last attester-read spend", () => {
    expect(currentAttesterIdOf([planEntry()])).toBeNull();
    const ledger = [
      planEntry(),
      spendEntry({ ref: "job-1" }),
      spendEntry({ service: "vision-judge", ref: "job-1" }),
      spendEntry({ ref: "job-2" }),
    ];
    expect(currentAttesterIdOf(ledger)).toBe("job-2");
  });

  it("selects verdicts by ref, escalation first, last-of-kind as fallback", () => {
    const cheap = verdictEntry({ ref: "job-1", confidence: "low" });
    const second = verdictEntry({ ref: "job-1:vision-judge", confidence: "medium" });
    const other = verdictEntry({ ref: "job-2", confidence: "high" });
    const ledger = [cheap, second, other];
    expect(currentVerdictEntry(ledger, "job-1")).toEqual(second);
    expect(currentVerdictEntry(ledger, "job-2")).toEqual(other);
    expect(currentVerdictEntry(ledger, "job-3")).toEqual(other);
    expect(currentVerdictEntry(ledger, null)).toEqual(other);
    expect(currentVerdictEntry([], "job-1")).toBeUndefined();
  });

  it("selects reasons by ref with last-of-kind fallback", () => {
    const first = reasonEntry("no-pay", "job-1");
    const second = reasonEntry("pay", "job-2");
    const ledger = [first, second];
    expect(currentReasonEntry(ledger, "job-1")).toEqual(first);
    expect(currentReasonEntry(ledger, "job-3")).toEqual(second);
    expect(currentReasonEntry(ledger, null)).toEqual(second);
  });

  it("scopes attester errors positionally to the attempt, last error for legacy", () => {
    const ledger = [
      spendEntry({ ref: "job-1" }),
      errorEntry("attester"),
      spendEntry({ ref: "job-2" }),
      errorEntry("record"),
    ];
    expect(hasAttesterErrorForAttempt(ledger, "job-1")).toBe(true);
    expect(hasAttesterErrorForAttempt(ledger, "job-2")).toBe(false);
    // Legacy path (no matching ref): only the LAST error entry counts.
    expect(hasAttesterErrorForAttempt(ledger, null)).toBe(false);
    expect(
      hasAttesterErrorForAttempt(
        [errorEntry("record"), errorEntry("attester")],
        null,
      ),
    ).toBe(true);
  });
});

describe("runStatusFromLedger", () => {
  const base = () => [planEntry(), spendEntry()];

  it("is null for an empty ledger (no claim; show the upload box)", () => {
    expect(runStatusFromLedger([])).toBeNull();
  });

  it("is paid whenever a settled entry exists", () => {
    expect(
      runStatusFromLedger([
        ...base(),
        { kind: "settle", at: AT, status: "settled", txHash: "0xfeed", paidUsd: "50" },
      ]),
    ).toBe("paid");
  });

  it("maps a trailing error to the run loop's terminal status", () => {
    expect(runStatusFromLedger([...base(), errorEntry("buy", "cap broken")])).toBe(
      "cap-exceeded",
    );
    expect(
      runStatusFromLedger([...base(), errorEntry("record", "NOT_PARTICIPANT")]),
    ).toBe("blocked");
    expect(runStatusFromLedger([...base(), errorEntry("settle")])).toBe("error");
  });

  it("is recorded on a deferred settle and no-pay on a no-pay decision", () => {
    expect(runStatusFromLedger([...base(), deferredEntry()])).toBe("recorded");
    expect(
      runStatusFromLedger([...base(), verdictEntry(), reasonEntry("no-pay", "job-1")]),
    ).toBe("no-pay");
  });

  it("treats a mid-flight ledger as verifying (resumable)", () => {
    expect(runStatusFromLedger(base())).toBe("verifying");
    expect(
      runStatusFromLedger([
        ...base(),
        verdictEntry({ verified: true, confidence: "high" }),
        reasonEntry("pay", "job-1"),
      ]),
    ).toBe("verifying");
  });
});

describe("deferred settle timing", () => {
  it("prefers the settle entry's periodEndIso over the pool's periodEnd", () => {
    const iso = "2026-08-02T10:00:00.000Z";
    const ledger = [deferredEntry(iso)];
    expect(deferredPeriodEndMs(ledger, 1_700_000_000)).toBe(Date.parse(iso));
  });

  it("falls back to the pool's on-chain periodEnd in seconds", () => {
    expect(deferredPeriodEndMs([deferredEntry()], 1_700_000_000)).toBe(
      1_700_000_000_000,
    );
    expect(deferredPeriodEndMs([deferredEntry("not-a-date")], 1_700_000_000)).toBe(
      1_700_000_000_000,
    );
  });

  it("is null when neither source is usable", () => {
    expect(deferredPeriodEndMs([deferredEntry()], null)).toBeNull();
    expect(deferredPeriodEndMs([], null)).toBeNull();
  });

  it("schedules the re-poll just after periodEnd, immediately-ish when already past", () => {
    const now = 1_700_000_000_000;
    expect(settleRepollDelayMs(now + 60_000, now)).toBe(
      60_000 + SETTLE_REPOLL_BUFFER_MS,
    );
    expect(settleRepollDelayMs(now - 60_000, now)).toBe(SETTLE_REPOLL_BUFFER_MS);
  });

  it("clamps far-future delays below the setTimeout overflow threshold", () => {
    const now = 0;
    const farFuture = 100 * 365 * 24 * 3_600 * 1000;
    expect(settleRepollDelayMs(farFuture, now)).toBe(2_147_483_647);
  });
});
