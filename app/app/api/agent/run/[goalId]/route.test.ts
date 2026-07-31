// The agent run route is the only door into SPOTTER's run loop. Pinned here:
// the path goalId must MATCH the on-chain computeGoalId for the claimed
// (poolId, address) - otherwise a caller could run one claim's evidence under
// another claim's ledger - and malformed input never reaches the loop.

import { describe, it, expect, vi, beforeEach } from "vitest";

const runAgentForGoal = vi.fn();
const computeGoalId = vi.fn();

vi.mock("@/lib/server/agent/run", () => ({
  runAgentForGoal: (...args: unknown[]) => runAgentForGoal(...args),
}));
vi.mock("@/lib/server/verdict", () => ({
  computeGoalId: (...args: unknown[]) => computeGoalId(...args),
  recordVerdict: vi.fn(),
  VERDICT_FACETS: { document: 4, wearable: 1 },
}));
vi.mock("@/lib/server/agent/wallet", () => ({
  getCircleClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/server/agent/spotter", () => ({
  arcReader: vi.fn(() => ({
    getPoolState: vi.fn().mockResolvedValue({
      settled: false,
      periodStart: 123n,
      periodEnd: 456n,
    }),
  })),
}));
vi.mock("@/lib/server/agent/x402", () => ({
  liveBuyDeps: vi.fn(() => ({})),
}));
vi.mock("@/lib/server/agent/reason", () => ({
  geminiReason: vi.fn(),
}));

const { GET, POST } = await import("@/app/api/agent/run/[goalId]/route");

const GOAL = "0x" + "ab".repeat(32);
const USER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

function ctx(goalId: string) {
  return { params: Promise.resolve({ goalId }) };
}

function post(goalId: string, body: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/agent/run/${goalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(goalId),
  );
}

const GOOD_BODY = {
  attesterId: "att-1",
  poolId: "7",
  address: USER,
  goalSpec: "got a flu shot this season",
};

beforeEach(() => {
  vi.clearAllMocks();
  computeGoalId.mockResolvedValue(GOAL);
  runAgentForGoal.mockResolvedValue({ status: "verifying", ledger: [] });
});

describe("POST /api/agent/run/[goalId]", () => {
  it("rejects a malformed goalId path segment", async () => {
    const res = await post("not-a-goal", GOOD_BODY);
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("rejects a body with no attesterId", async () => {
    const res = await post(GOAL, { ...GOOD_BODY, attesterId: "" });
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("rejects when the path goalId does not match the on-chain goalId", async () => {
    computeGoalId.mockResolvedValue("0x" + "cd".repeat(32));
    const res = await post(GOAL, GOOD_BODY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/goalId/);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("runs the agent and returns its status and ledger", async () => {
    runAgentForGoal.mockResolvedValue({
      status: "paid",
      ledger: [{ kind: "plan" }],
    });

    const res = await post(GOAL, GOOD_BODY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "paid",
      ledger: [{ kind: "plan" }],
    });
    const input = runAgentForGoal.mock.calls[0][1] as {
      poolId: bigint;
      goalId: string;
      evidenceKind: string;
    };
    expect(input.poolId).toBe(7n);
    expect(input.goalId).toBe(GOAL);
    expect(input.evidenceKind).toBe("document");
  });

  it("rejects an unknown evidenceKind", async () => {
    const res = await post(GOAL, { ...GOOD_BODY, evidenceKind: "vibes" });
    expect(res.status).toBe(400);
  });

  it("rejects a document claim with no attesterId at all", async () => {
    const body: Record<string, unknown> = { ...GOOD_BODY };
    delete body.attesterId;
    const res = await post(GOAL, body);
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("accepts a wearable claim without attesterId and keys it to the pool period", async () => {
    const body: Record<string, unknown> = {
      ...GOOD_BODY,
      evidenceKind: "wearable",
    };
    delete body.attesterId;

    const res = await post(GOAL, body);

    expect(res.status).toBe(200);
    const input = runAgentForGoal.mock.calls[0][1] as {
      attesterId: string;
      evidenceKind: string;
    };
    // The ref is derived from the chain's periodStart, never from the caller.
    expect(input.attesterId).toBe("wearable-123");
    expect(input.evidenceKind).toBe("wearable");
  });

  it("rejects a wearable claim that supplies its own attesterId", async () => {
    const res = await post(GOAL, { ...GOOD_BODY, evidenceKind: "wearable" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/attesterId/);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });
});

describe("GET /api/agent/run/[goalId]", () => {
  it("rejects a malformed goalId", async () => {
    const res = await GET(
      new Request(`http://localhost/api/agent/run/xyz`),
      ctx("xyz"),
    );
    expect(res.status).toBe(400);
  });

  it("returns the ledger for a goal", async () => {
    const res = await GET(
      new Request(`http://localhost/api/agent/run/${GOAL}`),
      ctx(GOAL),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ledger: [] });
  });
});
