import { describe, it, expect } from "vitest";
import {
  K_ANONYMITY_FLOOR,
  clearsFloor,
  perUnitUsdc,
  poolOutcomeDisplay,
  portfolioAggregate,
  portfolioDisplay,
  type PoolAggregate,
} from "@/lib/sponsor-metrics";

const USDC = (whole: number) => BigInt(whole) * 1_000_000n;

function agg(overrides: Partial<PoolAggregate> = {}): PoolAggregate {
  return {
    balanceUsdc: USDC(100),
    toppedUpUsdc: USDC(100),
    joined: 0,
    completions: 0,
    paidUsdc: 0n,
    ...overrides,
  };
}

describe("clearsFloor", () => {
  it("is false below the floor and true at or above it", () => {
    expect(K_ANONYMITY_FLOOR).toBe(5);
    expect(clearsFloor(0)).toBe(false);
    expect(clearsFloor(4)).toBe(false);
    expect(clearsFloor(5)).toBe(true);
    expect(clearsFloor(9)).toBe(true);
  });
});

describe("perUnitUsdc", () => {
  it("rounds to the nearest base unit", () => {
    // 100.00 USDC over 3 completions -> 33.333333, rounds to 33.333333
    expect(perUnitUsdc(USDC(100), 3)).toBe(33_333_333n);
    // 10.00 over 4 -> 2.50 exactly
    expect(perUnitUsdc(USDC(10), 4)).toBe(2_500_000n);
  });

  it("rejects a non-positive count rather than dividing by zero", () => {
    expect(() => perUnitUsdc(USDC(10), 0)).toThrow();
    expect(() => perUnitUsdc(USDC(10), -1)).toThrow();
  });
});

describe("poolOutcomeDisplay cohort gate", () => {
  it("withholds every outcome when fewer than five joined", () => {
    const d = poolOutcomeDisplay(agg({ joined: 4, completions: 4, paidUsdc: USDC(40) }));
    expect(d.belowFloor).toBe(true);
    expect(d.joined).toBeNull();
    expect(d.completionRatePct).toBeNull();
    expect(d.completions).toBeNull();
    expect(d.paidUsdc).toBeNull();
    expect(d.costPerCompletionUsdc).toBeNull();
  });

  it("always exposes sponsor capital, even below the floor", () => {
    const d = poolOutcomeDisplay(
      agg({ joined: 1, balanceUsdc: USDC(250), toppedUpUsdc: USDC(200) }),
    );
    expect(d.balanceUsdc).toBe(USDC(250));
    expect(d.toppedUpUsdc).toBe(USDC(200));
  });

  it("unlocks joined and completion rate once the cohort clears the floor", () => {
    const d = poolOutcomeDisplay(agg({ joined: 10, completions: 3 }));
    expect(d.belowFloor).toBe(false);
    expect(d.joined).toBe(10);
    expect(d.completionRatePct).toBe(30);
  });

  it("rounds the completion rate to a whole percent", () => {
    // 2 of 7 = 28.57% -> 29
    const d = poolOutcomeDisplay(agg({ joined: 7, completions: 2 }));
    expect(d.completionRatePct).toBe(29);
  });
});

describe("poolOutcomeDisplay achiever gate", () => {
  it("holds paid and cost-per-completion until five achievers exist", () => {
    // Cohort clears the floor, but the achiever subset does not.
    const d = poolOutcomeDisplay(
      agg({ joined: 20, completions: 4, paidUsdc: USDC(40) }),
    );
    expect(d.joined).toBe(20);
    expect(d.completionRatePct).toBe(20);
    expect(d.completions).toBeNull();
    expect(d.paidUsdc).toBeNull();
    expect(d.costPerCompletionUsdc).toBeNull();
  });

  it("unlocks paid and cost-per-completion once five achievers exist", () => {
    const d = poolOutcomeDisplay(
      agg({ joined: 20, completions: 5, paidUsdc: USDC(100) }),
    );
    expect(d.completions).toBe(5);
    expect(d.paidUsdc).toBe(USDC(100));
    expect(d.costPerCompletionUsdc).toBe(USDC(20));
  });
});

describe("portfolio", () => {
  it("sums pools and applies the floor to the totals", () => {
    const pools: PoolAggregate[] = [
      agg({ joined: 3, completions: 2, paidUsdc: USDC(20), balanceUsdc: USDC(50), toppedUpUsdc: USDC(50) }),
      agg({ joined: 4, completions: 3, paidUsdc: USDC(30), balanceUsdc: USDC(70), toppedUpUsdc: USDC(60) }),
    ];
    const totals = portfolioAggregate(pools);
    expect(totals.poolCount).toBe(2);
    expect(totals.totalJoined).toBe(7);
    expect(totals.totalCompletions).toBe(5);
    expect(totals.totalBalanceUsdc).toBe(USDC(120));
    expect(totals.totalToppedUpUsdc).toBe(USDC(110));

    const d = portfolioDisplay(totals);
    // Aggregation raised joined (7) and completions (5) over the floor even
    // though neither pool cleared it alone.
    expect(d.totalJoined).toBe(7);
    expect(d.totalCompletions).toBe(5);
    expect(d.totalPaidUsdc).toBe(USDC(50));
    // Capital totals always present.
    expect(d.totalBalanceUsdc).toBe(USDC(120));
    expect(d.totalToppedUpUsdc).toBe(USDC(110));
  });

  it("withholds outcome totals when the summed cohort stays below the floor", () => {
    const d = portfolioDisplay(
      portfolioAggregate([agg({ joined: 2, completions: 1, paidUsdc: USDC(10) })]),
    );
    expect(d.totalJoined).toBeNull();
    expect(d.totalCompletions).toBeNull();
    expect(d.totalPaidUsdc).toBeNull();
    expect(d.poolCount).toBe(1);
  });

  it("is empty-safe", () => {
    const d = portfolioDisplay(portfolioAggregate([]));
    expect(d.poolCount).toBe(0);
    expect(d.totalBalanceUsdc).toBe(0n);
    expect(d.totalJoined).toBeNull();
  });
});
