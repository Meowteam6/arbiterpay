// The sweep route is what makes settlement autonomous: no browser polling,
// just SPOTTER's own ledger index plus the cron. Pinned here: the bearer
// auth gate (Vercel cron's exact header form), the eligibility filter (a
// record entry, no settled settle, a stored pool linkage, no terminal
// settle failure), and the outcome counts in the response.

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
  return { ...route, ...ledger };
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
});
