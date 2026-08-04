// The sweep route is what makes settlement autonomous: no browser polling,
// just SPOTTER's own pending-settlement queue plus the cron. Pinned here: the
// bearer auth gate (Vercel cron's exact header form), the eligibility filter (a
// record entry, no settled settle, a stored pool linkage, no terminal settle
// failure), the outcome counts, the single-flight guard that stops a manual run
// from racing the cron, the elapsed-time budget that stops the loop cleanly
// instead of being killed mid-settle, and the rule that a claim still inside
// its pool period costs no chain call at all.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";

const settleRecordedClaim = vi.fn();

vi.mock("@/lib/server/agent/run", () => ({
  settleRecordedClaim: (...args: unknown[]) => settleRecordedClaim(...args),
  SETTLE_UNPAYABLE_MESSAGE:
    "pool settled before this claim completed; a one-shot settle cannot pay it retroactively",
}));
vi.mock("@/lib/server/agent/wallet", () => ({
  getCircleClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/server/agent/spotter", () => ({
  arcReader: vi.fn(() => ({})),
}));
vi.mock("@/lib/server/agent/x402", () => ({
  liveBuyDeps: vi.fn(() => ({})),
}));

const SECRET = "cron-secret-1";
const USER = "0x1111111111111111111111111111111111111111";

async function loadRoute() {
  vi.stubEnv("DATA_DIR", mkdtempSync(path.join(os.tmpdir(), "agent-sweep-")));
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.resetModules();
  const route = await import("@/app/api/agent/sweep/route");
  const ledger = await import("@/lib/server/agent/ledger");
  const lock = await import("@/lib/server/agent/lock");
  lock.resetLocalCoordinationState();
  return { ...route, ...ledger, ...lock };
}

function req(method: "GET" | "POST", auth?: string) {
  return new Request("http://localhost/api/agent/sweep", {
    method,
    headers: auth === undefined ? {} : { authorization: auth },
  });
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    kind: "plan" as const,
    steps: [
      {
        service: "attester-read",
        label: "document read (TEE attester)",
        estUsd: "0.02",
      },
    ],
    capUsd: "1.00",
    poolId: "7",
    participant: USER,
    ...overrides,
  };
}

function record(goalId: string) {
  return {
    kind: "record" as const,
    goalId,
    registryStatus: "recorded" as const,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("sweep auth", () => {
  it("rejects a request with no authorization header", async () => {
    const { POST } = await loadRoute();
    const res = await POST(req("POST"));
    expect(res.status).toBe(401);
    expect(settleRecordedClaim).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    const { POST } = await loadRoute();
    const res = await POST(req("POST", "Bearer wrong"));
    expect(res.status).toBe(401);
  });

  it("accepts Vercel cron's GET with the bearer header", async () => {
    const { GET } = await loadRoute();
    const res = await GET(req("GET", `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      swept: [],
      settled: 0,
      deferred: 0,
      errors: 0,
      truncated: false,
    });
  });
});

describe("sweep eligibility", () => {
  it("settles only recorded, unsettled claims with a stored pool linkage", async () => {
    const { POST, appendLedger } = await loadRoute();

    const eligible = "0x" + "aa".repeat(32);
    const alreadyPaid = "0x" + "bb".repeat(32);
    const unrecorded = "0x" + "cc".repeat(32);
    const noLinkage = "0x" + "dd".repeat(32);
    const terminal = "0x" + "ee".repeat(32);

    await appendLedger(eligible, plan());
    await appendLedger(eligible, record(eligible));

    await appendLedger(alreadyPaid, plan());
    await appendLedger(alreadyPaid, record(alreadyPaid));
    await appendLedger(alreadyPaid, {
      kind: "settle",
      status: "settled",
      txHash: "0xfeed",
      paidUsd: "50.00",
    });

    await appendLedger(unrecorded, plan());

    await appendLedger(noLinkage, plan({ poolId: undefined, participant: undefined }));
    await appendLedger(noLinkage, record(noLinkage));

    await appendLedger(terminal, plan());
    await appendLedger(terminal, record(terminal));
    await appendLedger(terminal, {
      kind: "error",
      stage: "settle",
      message:
        "pool settled before this claim completed; a one-shot settle cannot pay it retroactively",
    });

    settleRecordedClaim.mockResolvedValue({ status: "settled", ledger: [] });

    const res = await POST(req("POST", `Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      swept: [eligible],
      settled: 1,
      deferred: 0,
      errors: 0,
      truncated: false,
    });
    expect(settleRecordedClaim).toHaveBeenCalledTimes(1);
    const [, input] = settleRecordedClaim.mock.calls[0] as [
      unknown,
      { goalId: string; poolId: bigint; participant: string },
    ];
    expect(input.goalId).toBe(eligible);
    expect(input.poolId).toBe(7n);
    expect(input.participant).toBe(USER);
  });

  it("counts settled, deferred and error outcomes separately", async () => {
    const { POST, appendLedger } = await loadRoute();

    const goals = ["0x" + "1a".repeat(32), "0x" + "2b".repeat(32), "0x" + "3c".repeat(32)];
    for (const goalId of goals) {
      await appendLedger(goalId, plan());
      await appendLedger(goalId, record(goalId));
    }
    const outcomes: Record<string, string> = {
      [goals[0]]: "settled",
      [goals[1]]: "deferred",
      [goals[2]]: "error",
    };
    settleRecordedClaim.mockImplementation(
      async (_deps: unknown, input: { goalId: string }) => ({
        status: outcomes[input.goalId],
        ledger: [],
      }),
    );

    const res = await POST(req("POST", `Bearer ${SECRET}`));
    const body = (await res.json()) as {
      swept: string[];
      settled: number;
      deferred: number;
      errors: number;
    };

    expect(body.swept.sort()).toEqual([...goals].sort());
    expect(body.settled).toBe(1);
    expect(body.deferred).toBe(1);
    expect(body.errors).toBe(1);
  });

  it("leaves a claim still inside its pool period alone, without a chain call", async () => {
    const { POST, appendLedger, listDuePendingSettlements } = await loadRoute();
    const goalId = "0x" + "7f".repeat(32);
    const periodEnd = new Date(Date.now() + 3_600_000);

    await appendLedger(goalId, plan());
    await appendLedger(goalId, record(goalId));
    await appendLedger(goalId, {
      kind: "settle",
      status: "deferred",
      periodEndIso: periodEnd.toISOString(),
    });

    const res = await POST(req("POST", `Bearer ${SECRET}`));

    expect(await res.json()).toMatchObject({ swept: [], settled: 0 });
    expect(settleRecordedClaim).not.toHaveBeenCalled();
    // It is queued for the moment it becomes settleable, so later sweeps find
    // it without walking the whole index.
    expect(await listDuePendingSettlements(Date.now() / 1000, 10)).toEqual([]);
    expect(
      await listDuePendingSettlements(periodEnd.getTime() / 1000, 10),
    ).toEqual([goalId.toLowerCase()]);
  });

  it("drops a settled claim from the pending queue", async () => {
    const { POST, appendLedger, addPendingSettlement, listDuePendingSettlements } =
      await loadRoute();
    const goalId = "0x" + "5e".repeat(32);

    await appendLedger(goalId, plan());
    await appendLedger(goalId, record(goalId));
    await appendLedger(goalId, {
      kind: "settle",
      status: "settled",
      txHash: "0xfeed",
      paidUsd: "50.00",
    });
    await addPendingSettlement(goalId, 1);

    await POST(req("POST", `Bearer ${SECRET}`));

    expect(await listDuePendingSettlements(Date.now() / 1000, 10)).toEqual([]);
  });
});

describe("sweep concurrency", () => {
  it("refuses to run while another sweep holds the lock", async () => {
    const { POST, appendLedger, acquireLock } = await loadRoute();
    const goalId = "0x" + "9a".repeat(32);
    await appendLedger(goalId, plan());
    await appendLedger(goalId, record(goalId));
    settleRecordedClaim.mockResolvedValue({ status: "settled", ledger: [] });

    // Stand in for a cron tick that is already mid-sweep on another instance.
    const held = await acquireLock("agent:sweep", 30_000);
    expect(held).not.toBeNull();

    const res = await POST(req("POST", `Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      swept: [],
      skipped: "a sweep is already running",
    });
    expect(settleRecordedClaim).not.toHaveBeenCalled();
  });

  it("stops on its time budget and reports the sweep truncated", async () => {
    const { POST, appendLedger } = await loadRoute();
    for (let i = 0; i < 4; i += 1) {
      const goalId = "0x" + String(i).repeat(2).padStart(2, "0").repeat(32);
      await appendLedger(goalId, plan());
      await appendLedger(goalId, record(goalId));
    }
    // Each settle burns most of the window; the loop must stop cleanly rather
    // than be killed mid-claim with no checkpoint.
    const realNow = Date.now;
    let clock = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    settleRecordedClaim.mockImplementation(async () => {
      clock += 30_000;
      return { status: "settled", ledger: [] };
    });

    const res = await POST(req("POST", `Bearer ${SECRET}`));
    const body = (await res.json()) as { settled: number; truncated: boolean };

    expect(body.truncated).toBe(true);
    expect(body.settled).toBe(2);
    expect(settleRecordedClaim).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockRestore();
  });
});
