import { describe, it, expect, afterEach, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex,
  type Log,
} from "viem";
import {
  ACHIEVER_PAID_ABI,
  payoutFromLogs,
  revertKind,
  settlePoolAsSpotter,
  recordResultAsSpotter,
  recordVerdictAsSpotter,
  type PoolSettleLock,
  type SpotterDeps,
  type ArcReader,
  type SpotterExecutor,
} from "@/lib/server/agent/spotter";

// SPOTTER settles and records through its Circle wallet. The money rule from
// the spec is pinned here twice over: settle() is asserted on the AchieverPaid
// payout for the participant, never on transaction success (three live pools
// settle green while paying zero), and a canSettle=false participant is never
// settled into nothing.
//
// The second theme here is losing a race. Five claims in one pool all see
// settled == false; one lands and four revert. Those four must spend no gas
// (the pool-scoped settle lock) and, when they do send anyway, must decode the
// revert as "already on chain" rather than reporting a failure on a claim the
// winning transaction just paid.

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
    waitForInclusion: vi.fn().mockResolvedValue(undefined),
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

  it("stands down when another claim in the pool holds the settle lock", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor();
    const reader = fakeReader();
    const settleLock: PoolSettleLock = {
      acquire: vi.fn().mockResolvedValue(null),
      release: vi.fn(),
    };

    const result = await settlePoolAsSpotter(
      { ...deps(executor, reader), settleLock },
      { poolId: POOL, goalId: GOAL, participant: USER },
    );

    // No transaction, no gas, and nothing that reads as a failure: one
    // settle() pays everyone, so the holder's result is this claim's result.
    expect(result).toEqual({ status: "busy" });
    expect(executor.createContractExecutionTransaction).not.toHaveBeenCalled();
    expect(reader.canSettle).not.toHaveBeenCalled();
    expect(settleLock.release).not.toHaveBeenCalled();
  });

  it("re-reads under the lock: a claim queued behind the winner sends nothing", async () => {
    stubSpotterEnv();
    // The sequential race, which the lock alone does not cover: this claim's
    // first state read said unsettled, then the winner settled and released
    // the lock. Acting on the stale read would broadcast a settle() that is
    // certain to revert - handled, but paid for in gas.
    const executor = fakeExecutor();
    const getPoolState = vi
      .fn()
      .mockResolvedValueOnce({ settled: false, periodEnd: 1_000n })
      .mockResolvedValue({ settled: true, periodEnd: 1_000n });
    const reader = fakeReader({ getPoolState });
    const settleLock: PoolSettleLock = {
      acquire: vi.fn().mockResolvedValue("token-1"),
      release: vi.fn(),
    };

    const result = await settlePoolAsSpotter(
      { ...deps(executor, reader), settleLock },
      { poolId: POOL, goalId: GOAL, participant: USER },
    );

    expect(result).toEqual({ status: "already-settled" });
    expect(executor.createContractExecutionTransaction).not.toHaveBeenCalled();
    expect(reader.canSettle).not.toHaveBeenCalled();
    expect(settleLock.release).toHaveBeenCalledWith(POOL, "token-1");
  });

  it("releases the settle lock even when the settle throws", async () => {
    stubSpotterEnv();
    const reader = fakeReader({
      canSettle: vi.fn().mockResolvedValue(false),
    });
    const settleLock: PoolSettleLock = {
      acquire: vi.fn().mockResolvedValue("token-1"),
      release: vi.fn(),
    };

    await expect(
      settlePoolAsSpotter(
        { ...deps(fakeExecutor(), reader), settleLock },
        { poolId: POOL, goalId: GOAL, participant: USER },
      ),
    ).rejects.toThrow(/canSettle/);
    expect(settleLock.release).toHaveBeenCalledWith(POOL, "token-1");
  });

  it("decodes an ALREADY_SETTLED revert as already-settled, not as a failure", async () => {
    stubSpotterEnv();
    const executor = fakeExecutor({
      getTransaction: vi.fn().mockResolvedValue({
        data: {
          transaction: {
            id: "cx-1",
            state: "FAILED",
            errorReason: "execution reverted: ALREADY_SETTLED",
          },
        },
      }),
    });

    const result = await settlePoolAsSpotter(deps(executor), {
      poolId: POOL,
      goalId: GOAL,
      participant: USER,
    });

    expect(result).toEqual({ status: "already-settled" });
  });

  it("re-reads the pool when the receipt reverted and reports already-settled", async () => {
    stubSpotterEnv();
    const getPoolState = vi
      .fn()
      .mockResolvedValueOnce({ settled: false, periodEnd: 1_000n })
      .mockResolvedValueOnce({ settled: true, periodEnd: 1_000n });
    const reader = fakeReader({
      getPoolState,
      achieverPayouts: vi
        .fn()
        .mockRejectedValue(new Error("tx 0xfeed reverted on Arc testnet")),
    });

    const result = await settlePoolAsSpotter(deps(fakeExecutor(), reader), {
      poolId: POOL,
      goalId: GOAL,
      participant: USER,
    });

    // The winner paid every eligible achiever; the caller reconciles against
    // AchieverPaid in this same request instead of writing a red row.
    expect(result).toEqual({ status: "already-settled" });
    expect(getPoolState).toHaveBeenCalledTimes(2);
  });

  it("propagates a revert that is not the pool being settled", async () => {
    stubSpotterEnv();
    const reader = fakeReader({
      achieverPayouts: vi
        .fn()
        .mockRejectedValue(new Error("tx 0xfeed reverted on Arc testnet")),
    });

    await expect(
      settlePoolAsSpotter(deps(fakeExecutor(), reader), {
        poolId: POOL,
        goalId: GOAL,
        participant: USER,
      }),
    ).rejects.toThrow(/reverted/);
  });
});

describe("revertKind", () => {
  it("decodes the three reverts that mean the chain already has this state", () => {
    expect(revertKind(new Error("execution reverted: ALREADY_RECORDED"))).toBe(
      "already-recorded",
    );
    expect(revertKind(new Error("reverted: ALREADY_SETTLED"))).toBe(
      "already-settled",
    );
    expect(revertKind(new Error("reverted: NOT_PARTICIPANT"))).toBe(
      "not-participant",
    );
  });

  it("walks the cause chain, where viem and the Circle SDK bury the reason", () => {
    const err = new Error("Circle transaction cx-1 ended FAILED", {
      cause: new Error("execution reverted: ALREADY_RECORDED"),
    });
    expect(revertKind(err)).toBe("already-recorded");
  });

  it("does not confuse a different revert for one of these", () => {
    expect(revertKind(new Error("reverted: ALREADY_JOINED"))).toBeNull();
    expect(revertKind(new Error("reverted: SETTLED"))).toBeNull();
    expect(revertKind(new Error("connection reset"))).toBeNull();
  });
});

describe("payoutFromLogs", () => {
  function paidLog(poolId: bigint, participant: Address, amount: bigint) {
    return {
      address: "0xc4274eF2cBe28f77Af31b980055Cc1171818390C",
      topics: encodeEventTopics({
        abi: ACHIEVER_PAID_ABI,
        eventName: "AchieverPaid",
        args: { poolId, participant },
      }),
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
      transactionHash: "0xsettle",
    } as unknown as Log;
  }

  it("finds this participant's payout in a settlement that paid several", () => {
    const other = "0x3333333333333333333333333333333333333333" as Address;
    const logs = [
      paidLog(POOL, other, 10_000_000n),
      paidLog(POOL, USER, 25_000_000n),
    ];

    expect(payoutFromLogs(logs, POOL, USER)).toEqual({
      txHash: "0xsettle",
      amount: 25_000_000n,
    });
  });

  it("returns null when the settlement paid this participant nothing", () => {
    const other = "0x3333333333333333333333333333333333333333" as Address;

    expect(payoutFromLogs([paidLog(POOL, other, 10_000_000n)], POOL, USER)).toBeNull();
    expect(payoutFromLogs([paidLog(POOL, USER, 0n)], POOL, USER)).toBeNull();
    expect(payoutFromLogs([paidLog(9n, USER, 10n)], POOL, USER)).toBeNull();
    expect(payoutFromLogs([], POOL, USER)).toBeNull();
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
    expect(executor.getTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cx-1", waitForState: "CONFIRMED" }),
    );
    expect(result).toEqual({ status: "recorded", txHash: "0xfeed" });
  });

  it("waits for inclusion on the reading RPC before reporting recorded", async () => {
    stubSpotterEnv();
    const reader = fakeReader();

    const result = await recordResultAsSpotter(deps(fakeExecutor(), reader), {
      poolId: POOL,
      user: USER,
      verdict: true,
      multiplierBps: 10_000,
    });

    expect(reader.waitForInclusion).toHaveBeenCalledWith("0xfeed");
    expect(result).toEqual({ status: "recorded", txHash: "0xfeed" });
  });

  it("propagates a reverted result write instead of reporting recorded", async () => {
    stubSpotterEnv();
    const reader = fakeReader({
      waitForInclusion: vi
        .fn()
        .mockRejectedValue(new Error("tx 0xfeed reverted on Arc testnet")),
    });

    await expect(
      recordResultAsSpotter(deps(fakeExecutor(), reader), {
        poolId: POOL,
        user: USER,
        verdict: true,
        multiplierBps: 10_000,
      }),
    ).rejects.toThrow(/reverted/);
  });

  it("treats an ALREADY_RECORDED revert as the end state it wanted", async () => {
    stubSpotterEnv();
    // The preflight read went stale: another instance recorded first.
    const reader = fakeReader({
      waitForInclusion: vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: ALREADY_RECORDED")),
    });

    const result = await recordResultAsSpotter(deps(fakeExecutor(), reader), {
      poolId: POOL,
      user: USER,
      verdict: true,
      multiplierBps: 10_000,
    });

    expect(result).toEqual({ status: "already-recorded" });
  });

  it("never swallows NOT_PARTICIPANT - the claim is blocked, not recorded", async () => {
    stubSpotterEnv();
    const reader = fakeReader({
      waitForInclusion: vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: NOT_PARTICIPANT")),
    });

    await expect(
      recordResultAsSpotter(deps(fakeExecutor(), reader), {
        poolId: POOL,
        user: USER,
        verdict: true,
        multiplierBps: 10_000,
      }),
    ).rejects.toThrow(/NOT_PARTICIPANT/);
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

  it("waits for registry inclusion before reporting recorded - the canSettle gate", async () => {
    stubSpotterEnv();
    const reader = fakeReader();

    const result = await recordVerdictAsSpotter(deps(fakeExecutor(), reader), {
      goalId: GOAL,
      verified: true,
      confidence: "high",
      attesterRef: "job-1",
      facets: 6,
    });

    expect(reader.waitForInclusion).toHaveBeenCalledWith("0xfeed");
    expect(result).toEqual({ status: "recorded", txHash: "0xfeed" });
  });

  it("propagates a reverted registry write instead of reporting recorded", async () => {
    stubSpotterEnv();
    const reader = fakeReader({
      waitForInclusion: vi
        .fn()
        .mockRejectedValue(new Error("tx 0xfeed reverted on Arc testnet")),
    });

    await expect(
      recordVerdictAsSpotter(deps(fakeExecutor(), reader), {
        goalId: GOAL,
        verified: true,
        confidence: "high",
        attesterRef: "job-1",
        facets: 6,
      }),
    ).rejects.toThrow(/reverted/);
  });

  it("treats an ALREADY_RECORDED revert as the open canSettle gate it wanted", async () => {
    stubSpotterEnv();
    const reader = fakeReader({
      waitForInclusion: vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: ALREADY_RECORDED")),
    });

    const result = await recordVerdictAsSpotter(deps(fakeExecutor(), reader), {
      goalId: GOAL,
      verified: true,
      confidence: "high",
      attesterRef: "job-1",
      facets: 6,
    });

    expect(result).toEqual({ status: "already-recorded" });
  });
});
