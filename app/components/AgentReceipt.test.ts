// The receipt's display rules, pinned as pure functions: repeated errors
// collapse only when stage AND message match, calm labels map to the real
// messages run.ts and spotter.ts emit, gateway refs round-trip out of spend
// notes, and a deferred settle row never renders a raw epoch.

import { describe, it, expect } from "vitest";
import {
  collapseErrors,
  deferredSettleCopy,
  errorPresentation,
  formatSettleMoment,
  gatewayRefOf,
  noteWithoutGatewayRef,
  settleMomentLine,
} from "@/components/AgentReceipt";
import type { ReceiptRow } from "@/lib/agent-receipt";

const SETTLE_PREFLIGHT =
  "canSettle(0x9f3a) is false - settling now would pay this participant nothing. Record the verdict first.";

function errorRow(stage: string, message: string): ReceiptRow {
  return { kind: "error", stage, message };
}

describe("collapseErrors", () => {
  it("collapses consecutive identical errors into one item with a count", () => {
    const rows: ReceiptRow[] = [
      { kind: "reason", decision: "pay", note: "paying" },
      errorRow("settle", SETTLE_PREFLIGHT),
      errorRow("settle", SETTLE_PREFLIGHT),
      errorRow("settle", SETTLE_PREFLIGHT),
    ];

    const items = collapseErrors(rows);

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "errors",
      stage: "settle",
      message: SETTLE_PREFLIGHT,
      count: 3,
    });
  });

  it("never merges errors that differ in stage or message", () => {
    const items = collapseErrors([
      errorRow("settle", SETTLE_PREFLIGHT),
      errorRow("settle", "rpc timeout"),
      errorRow("record", "rpc timeout"),
    ]);

    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === "errors" && i.count === 1)).toBe(true);
  });

  it("passes non-error rows through untouched, keying by original index", () => {
    const reason: ReceiptRow = { kind: "reason", decision: "pay", note: "ok" };
    const items = collapseErrors([errorRow("buy", "x"), reason]);

    expect(items[1]).toEqual({ kind: "row", key: 1, row: reason });
  });
});

describe("errorPresentation", () => {
  it("reads a settle preflight as calm waiting, not failure", () => {
    expect(errorPresentation("settle", SETTLE_PREFLIGHT)).toEqual({
      label: "settlement is waiting on the chain",
      transient: true,
    });
  });

  it("names the pool-settled-first dead end", () => {
    const p = errorPresentation(
      "settle",
      "pool settled before this claim completed; a one-shot settle cannot pay it retroactively",
    );
    expect(p.transient).toBe(false);
    expect(p.label).toContain("pool settled before this claim finished");
  });

  it("does not call a post-settlement cap break a clean stop", () => {
    const p = errorPresentation(
      "buy",
      "vision-judge purchase of 0.90 USDC exceeded the estimate and broke the claim cap AFTER settlement (gateway tx 0xgw): over cap",
    );
    expect(p.label).toBe(
      "a purchase cost more than estimated after it was paid",
    );
    const clean = errorPresentation(
      "buy",
      "buying vision-judge at 0.90 USDC would break the 1.00 USDC cap for this claim (already spent 0.20)",
    );
    expect(clean.label).toBe("stopped at the spend cap for this claim");
  });

  it("treats the attester stage as transient and unknown stages as generic", () => {
    expect(errorPresentation("attester", "socket hang up").transient).toBe(
      true,
    );
    expect(errorPresentation("telemetry", "whatever")).toEqual({
      label: "this step did not complete",
      transient: false,
    });
  });
});

describe("gateway ref parsing", () => {
  const NOTE =
    "escalating. i can't read this and i'm not paying out 50 USDC on something i can't read. gateway tx 0xdeadbeef01";

  it("round-trips the run.ts note format", () => {
    expect(gatewayRefOf(NOTE)).toBe("0xdeadbeef01");
    expect(noteWithoutGatewayRef(NOTE)).toBe(
      "escalating. i can't read this and i'm not paying out 50 USDC on something i can't read.",
    );
  });

  it("collapses a gateway-only note to nothing", () => {
    expect(gatewayRefOf("gateway tx 0xabc")).toBe("0xabc");
    expect(noteWithoutGatewayRef("gateway tx 0xabc")).toBeNull();
  });

  it("leaves notes without a gateway ref alone", () => {
    expect(gatewayRefOf("plain note")).toBeNull();
    expect(noteWithoutGatewayRef("plain note")).toBe("plain note");
    expect(gatewayRefOf(null)).toBeNull();
    expect(noteWithoutGatewayRef(null)).toBeNull();
  });
});

describe("deferred settle copy", () => {
  const FUTURE_ISO = new Date(Date.now() + 3_600_000).toISOString();
  const PAST_ISO = new Date(Date.now() - 3_600_000).toISOString();
  const EPOCH_NOTE_TEXT =
    "pool period ends at 1791000000; settling the moment it does";

  it("renders a future periodEndIso as a promise with a local time", () => {
    const copy = deferredSettleCopy(FUTURE_ISO, null);
    expect(copy).toMatch(/^SPOTTER settles this automatically at /);
  });

  it("does not promise a future settle for a past periodEndIso", () => {
    const copy = deferredSettleCopy(PAST_ISO, null);
    expect(copy).toContain("SPOTTER settles this on its next pass");
    expect(copy).not.toContain("settles this automatically at");
  });

  it("converts a recognizable epoch note and never renders the raw epoch", () => {
    const copy = deferredSettleCopy(undefined, EPOCH_NOTE_TEXT);
    expect(copy).not.toContain("1791000000");
    expect(copy).toMatch(/SPOTTER settles this/);
  });

  it("falls back to generic copy on an out-of-range epoch, still no raw epoch", () => {
    const copy = deferredSettleCopy(
      undefined,
      "pool period ends at 12345; settling the moment it does",
    );
    expect(copy).toBe(
      "SPOTTER settles this automatically the moment the pool period ends",
    );
  });

  it("survives a runtime null periodEndIso without rendering Jan 1 1970", () => {
    const copy = deferredSettleCopy(
      null as unknown as undefined,
      EPOCH_NOTE_TEXT,
    );
    expect(copy).not.toContain("1970");
    expect(copy).not.toContain("1791000000");
  });

  it("renders epoch-free notes verbatim and pends without any note", () => {
    expect(deferredSettleCopy(undefined, "waiting on the pool")).toBe(
      "waiting on the pool",
    );
    expect(deferredSettleCopy(undefined, null)).toBe("settlement pending");
  });
});

describe("settle moments", () => {
  it("returns null for invalid dates end to end", () => {
    expect(formatSettleMoment(new Date("not-a-date"))).toBeNull();
    expect(settleMomentLine(new Date("not-a-date"))).toBeNull();
  });
});
