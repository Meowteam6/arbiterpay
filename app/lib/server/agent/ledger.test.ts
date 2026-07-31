import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";

// The agent ledger is SPOTTER's public spending record, keyed by goalId. Two
// invariants from the spec are load-bearing and pinned here:
//   1. A plan entry must exist before any spend lands ("emit plan before any
//      spend") - an agent that spends without a printed plan is just a script
//      with a wallet.
//   2. Spends stop dead at the per-claim cap frozen into the plan entry.
// Violations throw and persist nothing.

async function loadLedger() {
  vi.stubEnv("DATA_DIR", mkdtempSync(path.join(os.tmpdir(), "agent-ledger-")));
  vi.resetModules();
  return import("@/lib/server/agent/ledger");
}

const GOAL = "0x" + "ab".repeat(32);

function plan(capUsd = "1.00") {
  return {
    kind: "plan" as const,
    steps: [
      { service: "attester-read", label: "document read (TEE)", estUsd: "0.02" },
    ],
    capUsd,
  };
}

function spend(amountUsd: string, ref = "job-1") {
  return {
    kind: "spend" as const,
    service: "attester-read",
    label: "document read (TEE)",
    amountUsd,
    ref,
    settlement: "prepaid" as const,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("agent ledger", () => {
  it("round-trips plan and spend entries in order, stamping timestamps", async () => {
    const { appendLedger, readLedger } = await loadLedger();
    await appendLedger(GOAL, plan());
    await appendLedger(GOAL, spend("0.02"));

    const entries = await readLedger(GOAL);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("plan");
    expect(entries[1].kind).toBe("spend");
    expect(entries[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects a spend before any plan and persists nothing", async () => {
    const { appendLedger, readLedger } = await loadLedger();
    await expect(appendLedger(GOAL, spend("0.02"))).rejects.toThrow(/plan/i);
    expect(await readLedger(GOAL)).toHaveLength(0);
  });

  it("rejects a second plan for the same goal", async () => {
    const { appendLedger } = await loadLedger();
    await appendLedger(GOAL, plan());
    await expect(appendLedger(GOAL, plan())).rejects.toThrow(/plan/i);
  });

  it("stops a spend that would break the cap and persists nothing", async () => {
    const { appendLedger, readLedger } = await loadLedger();
    await appendLedger(GOAL, plan("1.00"));
    await appendLedger(GOAL, spend("0.98", "job-1"));
    await expect(appendLedger(GOAL, spend("0.05", "job-2"))).rejects.toThrow(
      /cap/i,
    );
    const entries = await readLedger(GOAL);
    expect(entries.filter((e) => e.kind === "spend")).toHaveLength(1);
  });

  it("sums spends in exact cents", async () => {
    const { appendLedger, readLedger, totalSpentUsd } = await loadLedger();
    await appendLedger(GOAL, plan());
    await appendLedger(GOAL, spend("0.02", "job-1"));
    await appendLedger(GOAL, spend("0.35", "job-2"));
    expect(totalSpentUsd(await readLedger(GOAL))).toBe("0.37");
  });

  it("rejects amounts that are not whole cents", async () => {
    const { appendLedger } = await loadLedger();
    await appendLedger(GOAL, plan());
    await expect(appendLedger(GOAL, spend("0.001"))).rejects.toThrow(
      /amount/i,
    );
    await expect(appendLedger(GOAL, spend("abc"))).rejects.toThrow(/amount/i);
  });

  it("finds a prior spend by service and ref so callers can dedupe", async () => {
    const { appendLedger, readLedger, findSpend } = await loadLedger();
    await appendLedger(GOAL, plan());
    await appendLedger(GOAL, spend("0.02", "job-1"));

    const entries = await readLedger(GOAL);
    expect(findSpend(entries, "attester-read", "job-1")?.amountUsd).toBe(
      "0.02",
    );
    expect(findSpend(entries, "attester-read", "job-2")).toBeUndefined();
  });

  it("keeps ledgers for different goals separate", async () => {
    const { appendLedger, readLedger } = await loadLedger();
    const otherGoal = "0x" + "cd".repeat(32);
    await appendLedger(GOAL, plan());
    expect(await readLedger(otherGoal)).toHaveLength(0);
  });

  it("indexes each claim once, on its plan entry, newest first", async () => {
    const { appendLedger, listLedgerGoalIds } = await loadLedger();
    const otherGoal = "0x" + "cd".repeat(32);

    expect(await listLedgerGoalIds()).toHaveLength(0);

    await appendLedger(GOAL, plan());
    await appendLedger(GOAL, spend("0.02"));
    await appendLedger(otherGoal, plan());

    const index = await listLedgerGoalIds();
    expect(index.map((e) => e.goalId)).toEqual([
      otherGoal.toLowerCase(),
      GOAL.toLowerCase(),
    ]);
    expect(index[0].at).toBeTruthy();
  });

  it("caps the feed listing at the requested limit", async () => {
    const { appendLedger, listLedgerGoalIds } = await loadLedger();
    for (let i = 0; i < 4; i++) {
      await appendLedger(`0x${String(i).repeat(64)}`, plan());
    }
    expect(await listLedgerGoalIds(2)).toHaveLength(2);
  });
});
