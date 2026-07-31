import { describe, it, expect, afterEach, vi } from "vitest";
import type { Address, Hex } from "viem";
import {
  settlePoolAsSpotter,
  recordResultAsSpotter,
  recordVerdictAsSpotter,
  type SpotterDeps,
  type ArcReader,
  type SpotterExecutor,
} from "@/lib/server/agent/spotter";

// SPOTTER settles and records through its Circle wallet. The money rule from
// the spec is pinned here twice over: settle() is asserted on the AchieverPaid
// payout for the participant, never on transaction success (three live pools
// settle green while paying zero), and a canSettle=false participant is never
// settled into nothing.

const POOL = 7n;
const GOAL = ("0x" + "ab".repeat(32)) as Hex;
const USER = "0x1111111111111111111111111111111111111111" as Address;

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubSpotterEnv() {
  vi.stubEnv("CIRCLE_WALLET_ID", "w-1");
  vi.stubEnv(
    "HEALTH_POOLS_ADDRESS",
    "0xc4274eF2cBe28f77Af31b980055Cc1171818390C",
  );
  vi.stubEnv(
    "HEALTH_VERDICT_ADDRESS",
    "0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042",
  );
}

function fakeExecutor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    createContractExecutionTransaction: vi
      .fn()
      .mockResolvedValue({ data: { id: "cx-1", state: "INITIATED" } }),
    getTransaction: vi.fn().mockResolvedValue({
      data: {
        transaction: { id: "cx-1", state: "CONFIRMED", txHash: "0xfeed" },
      },
    }),
    ...overrides,
  } as unknown as SpotterExecutor;
}

function fakeReader(overrides: Partial<ArcReader> = {}): ArcReader {
  return {
    getPoolState: vi
      .fn()
      .mockResolvedValue({ settled: false, periodEnd: 1_000n }),
    canSettle: vi.fn().mockResolvedValue(true),
    oracleAddress: vi.fn().mockResolvedValue(USER),
    attesterAddress: vi.fn().mockResolvedValue(USER),
    participantRecorded: vi.fn().mockResolvedValue(false),
    verdictRecorded: vi.fn().mockResolvedValue(false),
    achieverPayouts: vi
      .fn()
      .mockResolvedValue([{ participant: USER, amount: 50_000_000n }]),
    ...overrides,
  };
}

function deps(
  executor = fakeExecutor(),
  reader = fakeReader(),
  nowSeconds = 2_000n,
): SpotterDeps {
  return { circle: executor, reader, nowSeconds: () => nowSeconds };
}

describe("settlePoolAsSpotter", () => {
  it("defers when the pool period has not ended, without touching Circle", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();
    const d = deps(executor, fakeReader(), 500n);

    const result = await settlePoolAsSpotter(d, {
      poolId: POOL,
      goalId: GOAL,
      participant: USER,
    });

    expect(result).toEqual({ status: "not-due", periodEnd: 1_000n });
    expect(executor.createContractExecutionTransaction).not.toHaveBeenCalled();
  });

  it("reports an already-settled pool without touching Circle", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();
    const reader = fakeReader({
      getPoolState: vi
        .fn()
        .mockResolvedValue({ settled: true, periodEnd: 1_000n }),
    });

    const result = await settlePoolAsSpotter(deps(executor, reader), {
      poolId: POOL,
      goalId: GOAL,
      participant: USER,
    });

    expect(result).toEqual({ status: "already-settled" });
    expect(executor.createContractExecutionTransaction).not.toHaveBeenCalled();
  });

  it("refuses to settle a participant whose canSettle gate is closed", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();
    const reader = fakeReader({
      canSettle: vi.fn().mockResolvedValue(false),
    });

    await expect(
      settlePoolAsSpotter(deps(executor, reader), {
        poolId: POOL,
        goalId: GOAL,
        participant: USER,
      }),
    ).rejects.toThrow(/canSettle/);
    expect(executor.createContractExecutionTransaction).not.toHaveBeenCalled();
  });

  it("settles via the Circle wallet and reports the participant payout", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();

    const result = await settlePoolAsSpotter(deps(executor), {
      poolId: POOL,
      goalId: GOAL,
      participant: USER,
    });

    expect(executor.createContractExecutionTransaction).toHaveBeenCalledWith({
      walletId: "w-1",
      contractAddress: "0xc4274eF2cBe28f77Af31b980055Cc1171818390C",
      abiFunctionSignature: "settle(uint256)",
      abiParameters: ["7"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    expect(result).toEqual({
      status: "settled",
      txHash: "0xfeed",
      participantPaidUsd: "50",
      payouts: [{ participant: USER, amount: 50_000_000n }],
    });
  });

  it("throws when the settle transaction lands but pays the participant nothing", async () => {
    stubSpotterEnv();
    const reader = fakeReader({
      achieverPayouts: vi.fn().mockResolvedValue([]),
    });

    await expect(
      settlePoolAsSpotter(deps(fakeExecutor(), reader), {
        poolId: POOL,
        goalId: GOAL,
        participant: USER,
      }),
    ).rejects.toThrow(/paid nothing|no payout/i);
  });

  it("throws when Circle reports the transaction FAILED", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor({
      getTransaction: vi.fn().mockResolvedValue({
        data: { transaction: { id: "cx-1", state: "FAILED" } },
      }),
    });

    await expect(
      settlePoolAsSpotter(deps(executor), {
        poolId: POOL,
        goalId: GOAL,
        participant: USER,
      }),
    ).rejects.toThrow(/FAILED/);
  });
});

describe("recordResultAsSpotter", () => {
  it("skips when the participant result is already recorded", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();
    const reader = fakeReader({
      participantRecorded: vi.fn().mockResolvedValue(true),
    });

    const result = await recordResultAsSpotter(deps(executor, reader), {
      poolId: POOL,
      user: USER,
      verdict: true,
      multiplierBps: 10_000,
    });

    expect(result).toEqual({ status: "already-recorded" });
    expect(executor.createContractExecutionTransaction).not.toHaveBeenCalled();
  });

  it("records the result through the Circle wallet", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();

    const result = await recordResultAsSpotter(deps(executor), {
      poolId: POOL,
      user: USER,
      verdict: true,
      multiplierBps: 12_500,
    });

    expect(executor.createContractExecutionTransaction).toHaveBeenCalledWith({
      walletId: "w-1",
      contractAddress: "0xc4274eF2cBe28f77Af31b980055Cc1171818390C",
      abiFunctionSignature: "recordResult(uint256,address,bool,uint16)",
      abiParameters: ["7", USER, true, 12_500],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    expect(result).toEqual({ status: "recorded", txHash: "0xfeed" });
  });
});

describe("recordVerdictAsSpotter", () => {
  it("skips when the goal already has a registry verdict", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();
    const reader = fakeReader({
      verdictRecorded: vi.fn().mockResolvedValue(true),
    });

    const result = await recordVerdictAsSpotter(deps(executor, reader), {
      goalId: GOAL,
      verified: true,
      confidence: "high",
      attesterRef: "job-1",
      facets: 6,
    });

    expect(result).toEqual({ status: "already-recorded" });
    expect(executor.createContractExecutionTransaction).not.toHaveBeenCalled();
  });

  it("writes the verdict through the Circle wallet", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();

    const result = await recordVerdictAsSpotter(deps(executor), {
      goalId: GOAL,
      verified: true,
      confidence: "high",
      attesterRef: "job-1",
      facets: 6,
    });

    const call = (
      executor.createContractExecutionTransaction as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as {
      abiFunctionSignature: string;
      abiParameters: unknown[];
      contractAddress: string;
    };
    expect(call.contractAddress).toBe(
      "0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042",
    );
    expect(call.abiFunctionSignature).toBe(
      "recordVerdict(bytes32,bool,uint8,bytes32,uint16)",
    );
    expect(call.abiParameters[0]).toBe(GOAL);
    expect(call.abiParameters[1]).toBe(true);
    expect(call.abiParameters[2]).toBe(2);
    expect(call.abiParameters[4]).toBe(6);
    expect(result).toEqual({ status: "recorded", txHash: "0xfeed" });
  });
});
