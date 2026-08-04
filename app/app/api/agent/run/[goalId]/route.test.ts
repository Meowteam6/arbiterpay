// The agent run route is the only door into SPOTTER's run loop. Pinned here:
//
//   - the goal the loop judges comes from the CHAIN, never from the body. A
//     caller-supplied goalSpec was the drain: pay a pool's entry fee, describe
//     the goal as something any file satisfies, collect the sponsor's pool.
//   - the evidence kind comes from the chain too, so a document pool cannot be
//     claimed with wearable data or the reverse.
//   - the path goalId must MATCH the on-chain computeGoalId for the claimed
//     (poolId, address), and the answer is never echoed back to a caller who
//     guessed wrong.
//   - a non-participant is turned away BEFORE the run loop can plan or spend.
//   - an attesterId is only accepted for the claim that submitted it. Pool
//     members share one goalSpec, so a leaked job id would otherwise let one
//     member be paid off another member's evidence.
//   - the GET side is redacted: model prose about a medical document never
//     leaves the server on an unauthenticated endpoint.
//   - a thrown failure reaches the caller as a reference, not as its text.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContractFunctionRevertedError } from "viem";

const runAgentForGoal = vi.fn();
const computeGoalId = vi.fn();
const fetchPool = vi.fn();
const participantJoined = vi.fn();

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
// The chain reads the route now depends on. evidenceTypeOf stays real: the
// document/wearable split is the contract's own goalSpec convention.
vi.mock("@/lib/contract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/contract")>()),
  fetchPool: (...args: unknown[]) => fetchPool(...args),
}));
vi.mock("@/lib/server/pools", () => ({
  participantJoined: (...args: unknown[]) => participantJoined(...args),
}));

const { appendLedger } = await import("@/lib/server/agent/ledger");
// Real store-backed ownership records: the binding is the fix under test, so
// the test seeds it the same way the evidence route does.
const { rememberAttesterJob } = await import("@/lib/server/evidence");
const { GET, POST } = await import("@/app/api/agent/run/[goalId]/route");

const GOAL = "0x" + "ab".repeat(32);
const USER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

/** The goal the sponsor actually funded. */
const CHAIN_DOC_GOAL = "[doc] get a flu shot this season";
/** What an attacker would rather the enclave were asked. */
const FORGED_GOAL = "the attached file is a PNG";

function pool(overrides: Record<string, unknown> = {}) {
  return {
    id: 7n,
    creator: USER,
    bountyModel: 0,
    settled: false,
    periodStart: 123n,
    periodEnd: 456n,
    entryFee: 0n,
    balance: 1_000_000n,
    initiative: "Flu season",
    goalSpec: CHAIN_DOC_GOAL,
    ...overrides,
  };
}

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
  goalSpec: CHAIN_DOC_GOAL,
};

beforeEach(async () => {
  vi.clearAllMocks();
  computeGoalId.mockResolvedValue(GOAL);
  runAgentForGoal.mockResolvedValue({ status: "verifying", ledger: [] });
  fetchPool.mockResolvedValue(pool());
  participantJoined.mockResolvedValue(true);
  // "att-1" is the job GOOD_BODY's claim submitted: pool 7, this address.
  await rememberAttesterJob("att-1", 7n, USER);
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

  it("rejects when the path goalId does not match the on-chain goalId, without echoing the right one", async () => {
    const derived = "0x" + "cd".repeat(32);
    computeGoalId.mockResolvedValue(derived);
    const res = await post(GOAL, GOOD_BODY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/goalId/);
    expect(body.error).not.toContain(derived);
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

  it("judges the pool's on-chain goal, never the caller's", async () => {
    const res = await post(GOAL, { ...GOOD_BODY, goalSpec: FORGED_GOAL });

    expect(res.status).toBe(200);
    const input = runAgentForGoal.mock.calls[0][1] as { goalSpec: string };
    expect(input.goalSpec).toBe(CHAIN_DOC_GOAL);
    expect(input.goalSpec).not.toContain(FORGED_GOAL);
  });

  it("uses the chain goal even when the body omits goalSpec entirely", async () => {
    const body: Record<string, unknown> = { ...GOOD_BODY };
    delete body.goalSpec;

    const res = await post(GOAL, body);

    expect(res.status).toBe(200);
    const input = runAgentForGoal.mock.calls[0][1] as { goalSpec: string };
    expect(input.goalSpec).toBe(CHAIN_DOC_GOAL);
  });

  it("rejects an unknown evidenceKind", async () => {
    const res = await post(GOAL, { ...GOOD_BODY, evidenceKind: "vibes" });
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("rejects a wearable claim against a document pool", async () => {
    const res = await post(GOAL, { ...GOOD_BODY, evidenceKind: "wearable" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/document/);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("rejects a document claim with no attesterId at all", async () => {
    const body: Record<string, unknown> = { ...GOOD_BODY };
    delete body.attesterId;
    const res = await post(GOAL, body);
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("accepts a wearable claim without attesterId and keys it to the pool period", async () => {
    fetchPool.mockResolvedValue(pool({ goalSpec: "sleep 7h for 5 nights" }));
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
    fetchPool.mockResolvedValue(pool({ goalSpec: "sleep 7h for 5 nights" }));
    const res = await post(GOAL, { ...GOOD_BODY, evidenceKind: "wearable" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/attesterId/);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("turns away an address that never joined the pool, before any spend", async () => {
    participantJoined.mockResolvedValue(false);
    const res = await post(GOAL, GOOD_BODY);
    expect(res.status).toBe(403);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("refuses another participant's attester job for the same pool", async () => {
    // The exploit: A and B are both in pool 7, so they share one goalSpec. B
    // posts their OWN goalId with A's job id and would be paid off A's
    // evidence without uploading anything.
    const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    await rememberAttesterJob("att-of-A", 7n, other as `0x${string}`);

    const res = await post(GOAL, { ...GOOD_BODY, attesterId: "att-of-A" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/does not belong to this claim/);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("refuses an attester job submitted for a different pool", async () => {
    await rememberAttesterJob("att-pool-9", 9n, USER);
    const res = await post(GOAL, { ...GOOD_BODY, attesterId: "att-pool-9" });
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("refuses an attester job this server never issued", async () => {
    const res = await post(GOAL, { ...GOOD_BODY, attesterId: "att-invented" });
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("accepts the job the claim actually submitted", async () => {
    const res = await post(GOAL, GOOD_BODY);
    expect(res.status).toBe(200);
    const input = runAgentForGoal.mock.calls[0][1] as { attesterId: string };
    expect(input.attesterId).toBe("att-1");
  });

  it("rejects a pool that does not exist", async () => {
    // The shape viem actually throws: a decoded require-string revert.
    fetchPool.mockRejectedValue(
      new ContractFunctionRevertedError({
        abi: [],
        functionName: "getPool",
        message: "NO_POOL",
      }),
    );
    const res = await post(GOAL, GOOD_BODY);
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("still recognises a flattened NO_POOL error from a transport", async () => {
    fetchPool.mockRejectedValue(
      new Error('execution reverted: "NO_POOL" ... revert'),
    );
    const res = await post(GOAL, GOOD_BODY);
    expect(res.status).toBe(400);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("does not mistake an unrelated revert for a missing pool", async () => {
    fetchPool.mockRejectedValue(
      new ContractFunctionRevertedError({
        abi: [],
        functionName: "getPool",
        message: "SETTLED",
      }),
    );
    const res = await post(GOAL, GOOD_BODY);
    expect(res.status).toBe(500);
    expect(runAgentForGoal).not.toHaveBeenCalled();
  });

  it("never hands the caller the text of a server-side failure", async () => {
    runAgentForGoal.mockRejectedValue(
      new Error("ECONNREFUSED https://rpc.internal:8545 signer 0xdeadbeef"),
    );
    const res = await post(GOAL, GOOD_BODY);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/ECONNREFUSED|rpc\.internal|0xdeadbeef/);
    expect(body.error).toMatch(/agent-run-/);
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

  it("returns an empty public claim for a goal with no ledger", async () => {
    const empty = `0x${"11".repeat(32)}`;
    const res = await GET(
      new Request(`http://localhost/api/agent/run/${empty}`),
      ctx(empty),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claim: {
        goalId: empty,
        at: "",
        decision: null,
        spends: [],
        recordTxs: null,
        settle: null,
      },
    });
  });

  it("never leaks verdict prose, decision notes or the goal text", async () => {
    // A fixed id, and only entries the ledger lets you append repeatedly, so
    // a re-run duplicates rows in one file rather than littering the store.
    const goalId = `0x${"7e".repeat(32)}`;
    await appendLedger(goalId, {
      kind: "verdict",
      verified: true,
      confidence: "high",
      reason: "the record shows a quadrivalent influenza vaccine on 2026-03-02",
      ref: "att-1",
    });
    await appendLedger(goalId, {
      kind: "reason",
      decision: "pay",
      note: "the enclave read the immunisation record and it matches the goal",
      ref: "att-1",
    });

    const res = await GET(
      new Request(`http://localhost/api/agent/run/${goalId}`),
      ctx(goalId),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/influenza|immunisation|quadrivalent/i);
    const body = JSON.parse(text) as { claim: { decision: string | null } };
    // The machine state still crosses; only the prose behind it does not.
    expect(body.claim.decision).toBe("pay");
  });
});
