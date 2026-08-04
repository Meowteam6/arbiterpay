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

async function loadLedgerAndStore() {
  vi.stubEnv("DATA_DIR", mkdtempSync(path.join(os.tmpdir(), "agent-ledger-")));
  vi.resetModules();
  return {
    ledger: await import("@/lib/server/agent/ledger"),
    store: await import("@/lib/server/store"),
  };
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

  it("round-trips the optional linkage fields other steps depend on", async () => {
    const { appendLedger, readLedger } = await loadLedger();
    await appendLedger(GOAL, {
      ...plan(),
      poolId: "7",
      participant: "0x1111111111111111111111111111111111111111",
    });
    await appendLedger(GOAL, {
      kind: "reason",
      decision: "no-pay",
      note: "not paying.",
      ref: "job-1",
    });
    await appendLedger(GOAL, {
      kind: "settle",
      status: "deferred",
      periodEndIso: "2026-08-01T00:00:00.000Z",
      note: "the pool period is still running",
    });

    const entries = await readLedger(GOAL);
    expect(entries[0]).toMatchObject({
      kind: "plan",
      poolId: "7",
      participant: "0x1111111111111111111111111111111111111111",
    });
    expect(entries[1]).toMatchObject({ kind: "reason", ref: "job-1" });
    expect(entries[2]).toMatchObject({
      kind: "settle",
      periodEndIso: "2026-08-01T00:00:00.000Z",
    });
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

// Storage-level races. The ledger used to be read-append-write over one blob
// per claim plus one global index blob, so concurrent writers dropped each
// other's entries: a lost "record" strands a claim outside the settlement
// sweep and a lost index member hides the claim from the feed entirely.
describe("agent ledger under concurrency", () => {
  it("keeps every concurrent append for one claim", async () => {
    const { appendLedger, readLedger } = await loadLedger();
    await appendLedger(GOAL, plan());

    const total = 20;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        appendLedger(GOAL, {
          kind: "record" as const,
          goalId: GOAL,
          registryStatus: "recorded" as const,
          registryTx: `0xtx${i}`,
        }),
      ),
    );

    const records = (await readLedger(GOAL)).filter((e) => e.kind === "record");
    expect(records).toHaveLength(total);
    expect(new Set(records.map((e) => e.registryTx)).size).toBe(total);
  });

  it("indexes every claim when several land at once", async () => {
    const { appendLedger, listLedgerGoalIds } = await loadLedger();
    const goals = Array.from(
      { length: 20 },
      (_, i) => `0x${String(i).padStart(2, "0").repeat(32)}`,
    );

    await Promise.all(goals.map((goalId) => appendLedger(goalId, plan())));

    const index = await listLedgerGoalIds(50);
    expect(index).toHaveLength(goals.length);
    expect(new Set(index.map((e) => e.goalId))).toEqual(
      new Set(goals.map((g) => g.toLowerCase())),
    );
  });

  it("holds the per-claim cap when spends race each other", async () => {
    const { appendLedger, readLedger, totalSpentUsd } = await loadLedger();
    await appendLedger(GOAL, plan("1.00"));

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        appendLedger(GOAL, spend("0.25", `job-${i}`)),
      ),
    );

    // Four spends of 0.25 fit under the 1.00 cap; the rest must be refused.
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(totalSpentUsd(await readLedger(GOAL))).toBe("1.00");
  });

  it("admits only one plan when two runs start together", async () => {
    const { appendLedger, readLedger } = await loadLedger();

    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => appendLedger(GOAL, plan())),
    );

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await readLedger(GOAL)).filter((e) => e.kind === "plan")).toHaveLength(
      1,
    );
  });
});

// Anything already written in the old shape has to keep working: a ledger the
// agent cannot read is a claim it will re-plan and re-charge for.
describe("agent ledger migration", () => {
  it("reads a ledger written as a single blob", async () => {
    const { ledger, store } = await loadLedgerAndStore();
    await store.writeJson(`agent-ledger-${GOAL.toLowerCase()}.json`, [
      { ...plan(), at: "2026-07-01T00:00:00.000Z" },
      { ...spend("0.02"), at: "2026-07-01T00:00:01.000Z" },
    ]);

    const entries = await ledger.readLedger(GOAL);
    expect(entries).toHaveLength(2);
    expect(ledger.totalSpentUsd(entries)).toBe("0.02");
  });

  it("carries blob entries into the list on the next append", async () => {
    const { ledger, store } = await loadLedgerAndStore();
    await store.writeJson(`agent-ledger-${GOAL.toLowerCase()}.json`, [
      { ...plan("1.00"), at: "2026-07-01T00:00:00.000Z" },
      { ...spend("0.90"), at: "2026-07-01T00:00:01.000Z" },
    ]);

    // The old plan and spend still count, so this one breaks the cap.
    await expect(
      ledger.appendLedger(GOAL, spend("0.20", "job-2")),
    ).rejects.toThrow(/cap/i);

    const entries = await ledger.appendLedger(GOAL, spend("0.05", "job-3"));
    expect(entries).toHaveLength(3);
    expect(ledger.totalSpentUsd(entries)).toBe("0.95");
    // A second plan is still refused: history was not lost in the move.
    await expect(ledger.appendLedger(GOAL, plan())).rejects.toThrow(/plan/i);
  });

  it("keeps pre-migration index entries visible in the feed", async () => {
    const { ledger, store } = await loadLedgerAndStore();
    const legacyGoal = "0x" + "ef".repeat(32);
    await store.writeJson("agent-ledger-index.json", [
      { goalId: legacyGoal, at: "2026-07-01T00:00:00.000Z" },
    ]);

    await ledger.appendLedger(GOAL, plan());

    const index = await ledger.listLedgerGoalIds(10);
    expect(index.map((e) => e.goalId)).toEqual([GOAL.toLowerCase(), legacyGoal]);
  });
});
