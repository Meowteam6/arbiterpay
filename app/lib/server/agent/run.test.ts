import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";
import type { Address, Hex } from "viem";
import type { ArcReader, SpotterExecutor } from "@/lib/server/agent/spotter";

// The run loop is SPOTTER's whole job: plan, buy, read the attester, decide,
// record, settle when settleable. Pinned here: the plan lands before any
// spend, a re-poll never double-buys, the cap aborts the run before money
// leaves, record dispatches to the Circle wallet only when the on-chain roles
// actually point at it, and "paid" is only ever reported off a real payout.

const GOAL = ("0x" + "ab".repeat(32)) as Hex;
const USER = "0x1111111111111111111111111111111111111111" as Address;
const SPOTTER = "0xd0d23b4ade9f55ca10e9c8a4e5b1e135f72c824d" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;

const INPUT = {
  goalId: GOAL,
  poolId: 7n,
  address: USER,
  goalSpec: "got a flu shot this season",
  attesterId: "job-1",
  evidenceKind: "document" as const,
};

async function loadRun() {
  vi.stubEnv("DATA_DIR", mkdtempSync(path.join(os.tmpdir(), "agent-run-")));
  vi.stubEnv("CIRCLE_WALLET_ID", "w-1");
  vi.stubEnv("SPOTTER_WALLET_ADDRESS", SPOTTER);
  vi.stubEnv(
    "HEALTH_POOLS_ADDRESS",
    "0xc4274eF2cBe28f77Af31b980055Cc1171818390C",
  );
  vi.stubEnv(
    "HEALTH_VERDICT_ADDRESS",
    "0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042",
  );
  vi.resetModules();
  return import("@/lib/server/agent/run");
}

function fakeExecutor() {
  return {
    createContractExecutionTransaction: vi
      .fn()
      .mockResolvedValue({ data: { id: "cx-1", state: "INITIATED" } }),
    getTransaction: vi.fn().mockResolvedValue({
      data: {
        transaction: { id: "cx-1", state: "CONFIRMED", txHash: "0xfeed" },
      },
    }),
  } as unknown as SpotterExecutor;
}

function fakeReader(overrides: Partial<ArcReader> = {}): ArcReader {
  return {
    getPoolState: vi
      .fn()
      .mockResolvedValue({ settled: false, periodEnd: 1_000n }),
    canSettle: vi.fn().mockResolvedValue(true),
    oracleAddress: vi.fn().mockResolvedValue(OTHER),
    attesterAddress: vi.fn().mockResolvedValue(OTHER),
    participantRecorded: vi.fn().mockResolvedValue(false),
    verdictRecorded: vi.fn().mockResolvedValue(false),
    achieverPayouts: vi
      .fn()
      .mockResolvedValue([{ participant: USER, amount: 50_000_000n }]),
    ...overrides,
  };
}

const verifiedPoll = vi.fn().mockResolvedValue({
  status: "completed",
  verdict: { verified: true, confidence: "high", reason: "flu shot on record" },
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    spotter: {
      circle: fakeExecutor(),
      reader: fakeReader(),
      nowSeconds: () => 2_000n,
    },
    poll: verifiedPoll,
    legacyRecordResult: vi.fn().mockResolvedValue("0xbeef" as Hex),
    legacyRecordVerdict: vi
      .fn()
      .mockResolvedValue({ status: "recorded", txHash: "0xcafe", goalId: GOAL }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("runAgentForGoal", () => {
  it("emits the plan before the spend and reports verifying without duplicating buys", async () => {
    const { runAgentForGoal } = await loadRun();
    const poll = vi.fn().mockResolvedValue({ status: "verifying", verdict: null });
    const deps = makeDeps({ poll });

    const first = await runAgentForGoal(deps, INPUT);
    expect(first.status).toBe("verifying");
    expect(first.ledger[0].kind).toBe("plan");
    expect(first.ledger[1].kind).toBe("spend");

    const second = await runAgentForGoal(deps, INPUT);
    expect(
      second.ledger.filter((e) => e.kind === "spend"),
    ).toHaveLength(1);
  });

  it("decides no-pay on a failed inference and never touches the chain", async () => {
    const { runAgentForGoal } = await loadRun();
    const poll = vi.fn().mockResolvedValue({
      status: "failed",
      verdict: { verified: false, confidence: "low", reason: "unreadable" },
    });
    const deps = makeDeps({ poll });

    const result = await runAgentForGoal(deps, INPUT);

    expect(result.status).toBe("no-pay");
    expect(result.ledger.some((e) => e.kind === "reason")).toBe(true);
    expect(deps.legacyRecordResult).not.toHaveBeenCalled();
    expect(
      (deps.spotter as { circle: SpotterExecutor }).circle
        .createContractExecutionTransaction,
    ).not.toHaveBeenCalled();
  });

  it("records via the legacy signer while the on-chain roles still point at it, deferring settlement", async () => {
    const { runAgentForGoal } = await loadRun();
    const deps = makeDeps();
    (deps.spotter as { nowSeconds: () => bigint }).nowSeconds = () => 500n;

    const result = await runAgentForGoal(deps, INPUT);

    expect(result.status).toBe("recorded");
    expect(deps.legacyRecordResult).toHaveBeenCalledWith(
      7n,
      USER,
      true,
      20_000n,
    );
    expect(deps.legacyRecordVerdict).toHaveBeenCalled();
    expect(
      (deps.spotter as { circle: SpotterExecutor }).circle
        .createContractExecutionTransaction,
    ).not.toHaveBeenCalled();
    const settle = result.ledger.find((e) => e.kind === "settle");
    expect(settle).toMatchObject({ status: "deferred" });
  });

  it("records and settles through the Circle wallet once the roles point at SPOTTER", async () => {
    const { runAgentForGoal } = await loadRun();
    const reader = fakeReader({
      oracleAddress: vi.fn().mockResolvedValue(SPOTTER),
      attesterAddress: vi.fn().mockResolvedValue(SPOTTER),
    });
    const executor = fakeExecutor();
    const deps = makeDeps({
      spotter: { circle: executor, reader, nowSeconds: () => 2_000n },
    });

    const result = await runAgentForGoal(deps, INPUT);

    expect(result.status).toBe("paid");
    expect(deps.legacyRecordResult).not.toHaveBeenCalled();
    expect(deps.legacyRecordVerdict).not.toHaveBeenCalled();
    const settle = result.ledger.find((e) => e.kind === "settle");
    expect(settle).toMatchObject({
      status: "settled",
      txHash: "0xfeed",
      paidUsd: "50",
    });
  });

  it("aborts before buying when the claim cap cannot cover the spend", async () => {
    vi.stubEnv("AGENT_CLAIM_CAP_USD", "0.01");
    const { runAgentForGoal } = await loadRun();
    const poll = vi.fn();
    const deps = makeDeps({ poll });

    const result = await runAgentForGoal(deps, INPUT);

    expect(result.status).toBe("cap-exceeded");
    expect(poll).not.toHaveBeenCalled();
    expect(
      result.ledger.find((e) => e.kind === "error"),
    ).toMatchObject({ stage: "buy" });
  });

  it("surfaces a settle that paid the participant nothing as an error, never as paid", async () => {
    const { runAgentForGoal } = await loadRun();
    const reader = fakeReader({
      achieverPayouts: vi.fn().mockResolvedValue([]),
    });
    const deps = makeDeps({
      spotter: { circle: fakeExecutor(), reader, nowSeconds: () => 2_000n },
    });

    const result = await runAgentForGoal(deps, INPUT);

    expect(result.status).toBe("error");
    expect(
      result.ledger.find((e) => e.kind === "error"),
    ).toMatchObject({ stage: "settle" });
  });

  it("reports blocked when the participant never joined the pool", async () => {
    const { runAgentForGoal } = await loadRun();
    const deps = makeDeps({
      legacyRecordResult: vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: NOT_PARTICIPANT")),
    });

    const result = await runAgentForGoal(deps, INPUT);

    expect(result.status).toBe("blocked");
    expect(
      result.ledger.find((e) => e.kind === "error"),
    ).toMatchObject({ stage: "record" });
  });

  it("returns paid from the ledger fast path without re-running anything", async () => {
    const { runAgentForGoal } = await loadRun();
    const reader = fakeReader({
      oracleAddress: vi.fn().mockResolvedValue(SPOTTER),
      attesterAddress: vi.fn().mockResolvedValue(SPOTTER),
    });
    const poll = verifiedPoll;
    const deps = makeDeps({
      spotter: { circle: fakeExecutor(), reader, nowSeconds: () => 2_000n },
      poll,
    });

    const first = await runAgentForGoal(deps, INPUT);
    expect(first.status).toBe("paid");
    const pollCalls = poll.mock.calls.length;

    const second = await runAgentForGoal(deps, INPUT);
    expect(second.status).toBe("paid");
    expect(poll.mock.calls.length).toBe(pollCalls);
  });
});
