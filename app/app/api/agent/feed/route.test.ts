// The feed route is unauthenticated and public. Pinned here: a ledger full
// of model-authored prose about a medical document goes in, and none of that
// prose comes out - the response carries money facts, statuses, and tx
// hashes only. The privacy claim of the product depends on this boundary.

import { describe, it, expect, vi, beforeEach } from "vitest";

const listLedgerGoalIds = vi.fn();
const readLedger = vi.fn();

vi.mock("@/lib/server/agent/ledger", () => ({
  listLedgerGoalIds: (...args: unknown[]) => listLedgerGoalIds(...args),
  readLedger: (...args: unknown[]) => readLedger(...args),
}));

const { GET } = await import("@/app/api/agent/feed/route");

const AT = "2026-08-01T00:00:00.000Z";
const GOAL = "0x" + "ab".repeat(32);

const VERDICT_PROSE =
  "the uploaded chart shows an influenza vaccination administered at a clinic on 2026-07-12";
const REASON_PROSE =
  "paying. the flu shot record is legible and matches the sleep goal of 8 hours a night.";
const SETTLE_ERROR_PROSE =
  "canSettle(0x9f3a) is false - settling now would pay this participant nothing. Record the verdict first.";

const SENSITIVE_LEDGER = [
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
    note: "gateway tx 0xgw123",
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
  { kind: "error", at: AT, stage: "settle", message: SETTLE_ERROR_PROSE },
  { kind: "error", at: AT, stage: "settle", message: SETTLE_ERROR_PROSE },
  {
    kind: "settle",
    at: AT,
    status: "settled",
    txHash: "0xsettle",
    paidUsd: "50.00",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  listLedgerGoalIds.mockResolvedValue([{ goalId: GOAL, at: AT }]);
  readLedger.mockResolvedValue(SENSITIVE_LEDGER);
});

describe("GET /api/agent/feed", () => {
  it("returns the redacted claims, newest first", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { claims: unknown[] };
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]).toEqual({
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
      recordTxs: null,
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

  it("leaks no reason notes, verdict prose, goal text, or error diagnostics", async () => {
    const res = await GET();

    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(VERDICT_PROSE);
    expect(text).not.toContain(REASON_PROSE);
    expect(text).not.toContain(SETTLE_ERROR_PROSE);
    expect(text).not.toContain("influenza");
    expect(text).not.toContain("flu shot");
    expect(text).not.toContain("sleep goal");
    expect(text).not.toContain("canSettle");
    expect(text).not.toContain('"note"');
    expect(text).not.toContain('"reason"');
    expect(text).not.toContain('"message"');
  });

  it("returns a generic 500 that leaks no store internals", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    listLedgerGoalIds.mockRejectedValue(
      new Error("Failed to read agent-ledger-0xab.json from /srv/data"),
    );

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "agent feed unavailable" });
    // The real failure is loud server-side, never on the public surface.
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0])).toContain("agent-ledger-0xab");
    consoleError.mockRestore();
  });
});
