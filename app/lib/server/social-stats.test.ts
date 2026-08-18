// The on-chain stat math. Pinned here: counts, USDC sums, win streak, peer
// sets, and recent payout rows are derived correctly from HealthPools events,
// and nothing but addresses/amounts/tx hashes is ever read.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const BACKER1 = "0x00000000000000000000000000000000000000b1";
const BACKER2 = "0x00000000000000000000000000000000000000b2";
const PART1 = "0x00000000000000000000000000000000000000c1";

// A fake Arc client whose getLogs returns canned logs per event + arg key, and
// whose getBlock returns a fixed timestamp. The module passes real event
// objects and indexed-arg filters; the fake keys off the event name we assign.
function fakeLog(args: Record<string, unknown>, block: number, tx: string) {
  return {
    args,
    blockNumber: BigInt(block),
    logIndex: 0,
    transactionHash: tx,
  };
}

const fakeClient = {
  getLogs: vi.fn(
    async ({
      event,
      args,
    }: {
      event: { name: string };
      args?: Record<string, unknown>;
    }) => {
      switch (event.name) {
        case "AchieverPaid":
          return [
            fakeLog({ amount: 40_000_000n }, 10, "0xa1"),
            fakeLog({ amount: 60_000_000n }, 12, "0xa2"),
          ];
        case "BackerPaid":
          return [fakeLog({ amount: 25_000_000n }, 11, "0xb1")];
        case "PoolJoined":
          return [
            fakeLog({}, 3, "0xj1"),
            fakeLog({}, 4, "0xj2"),
            fakeLog({}, 5, "0xj3"),
          ];
        case "ResultRecorded":
          return [
            fakeLog({ verdict: true }, 5, "0xr1"),
            fakeLog({ verdict: false }, 6, "0xr2"),
            fakeLog({ verdict: true }, 7, "0xr3"),
            fakeLog({ verdict: true }, 8, "0xr4"),
          ];
        case "GoalBacked":
          // Two calls: backers-of-A filters by participant; A-is-backing
          // filters by backer.
          if (args?.participant !== undefined) {
            return [
              fakeLog({ backer: BACKER1 }, 2, "0xg1"),
              fakeLog({ backer: BACKER2 }, 3, "0xg2"),
              fakeLog({ backer: BACKER1 }, 4, "0xg3"), // duplicate
            ];
          }
          return [fakeLog({ participant: PART1 }, 2, "0xg4")];
        default:
          return [];
      }
    },
  ),
  getBlock: vi.fn(async () => ({ timestamp: 1_790_000_000n })),
};

vi.mock("@/lib/contract", () => ({
  getHealthPoolsAddress: () => "0x0000000000000000000000000000000000009999",
  getArcPublicClient: () => fakeClient,
  formatUsdc: (amount: bigint) => (Number(amount) / 1e6).toFixed(2),
  achieverPaidEvent: { name: "AchieverPaid" },
  backerPaidEvent: { name: "BackerPaid" },
  goalBackedEvent: { name: "GoalBacked" },
  poolJoinedEvent: { name: "PoolJoined" },
  resultRecordedEvent: { name: "ResultRecorded" },
}));

const { getSocialStats, clearSocialStatsCache } = await import(
  "@/lib/server/social-stats"
);

beforeEach(() => {
  clearSocialStatsCache();
  vi.clearAllMocks();
});

describe("getSocialStats", () => {
  it("counts wins, sums USDC, and derives the win streak", async () => {
    const stats = await getSocialStats(ADDRESS);
    expect(stats.goalsHit).toBe(2);
    expect(stats.backerWins).toBe(1);
    expect(stats.poolsJoined).toBe(3);
    // 40 + 60 (achiever) + 25 (backer) = 125 USDC in base units.
    expect(stats.usdcEarned).toBe(125_000_000n);
    // Trailing run of verdict==true after the last false: blocks 7 and 8.
    expect(stats.winStreak).toBe(2);
  });

  it("builds distinct peer sets from GoalBacked", async () => {
    const stats = await getSocialStats(ADDRESS);
    expect(stats.backerAddresses).toEqual([
      BACKER1.toLowerCase(),
      BACKER2.toLowerCase(),
    ]);
    expect(stats.backingAddresses).toEqual([PART1.toLowerCase()]);
  });

  it("returns recent payout rows newest first with amounts and tx hashes", async () => {
    const stats = await getSocialStats(ADDRESS);
    expect(stats.recentWins).toHaveLength(3);
    // block 12 is newest: the 60 USDC achiever payout.
    expect(stats.recentWins[0]).toMatchObject({
      amountUsd: "60.00",
      txHash: "0xa2",
      role: "achiever",
    });
    expect(stats.recentWins[1]).toMatchObject({
      amountUsd: "25.00",
      txHash: "0xb1",
      role: "backer",
    });
    expect(stats.recentWins[2]).toMatchObject({
      amountUsd: "40.00",
      txHash: "0xa1",
      role: "achiever",
    });
    // Block time resolved to an ISO string.
    expect(stats.recentWins[0].at).toBe(
      new Date(1_790_000_000 * 1000).toISOString(),
    );
  });

  it("returns zeroed stats for a malformed address without hitting the chain", async () => {
    const stats = await getSocialStats("not-an-address");
    expect(stats.goalsHit).toBe(0);
    expect(stats.usdcEarned).toBe(0n);
    expect(fakeClient.getLogs).not.toHaveBeenCalled();
  });
});
