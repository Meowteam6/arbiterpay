import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The per-claim cap is scoped to one goalId, so a fresh goalId is a fresh
// budget: these two daily caps are the only thing bounding total spend. Pinned
// here: both ceilings refuse BEFORE money moves, a refusal explains itself in
// words the receipt can render, a refused reservation leaves no residue on
// either counter, address casing cannot mint a second per-wallet budget, and
// the day's total is corrected to what was actually charged.

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

async function load() {
  vi.resetModules();
  const budget = await import("@/lib/server/agent/budget");
  const lock = await import("@/lib/server/agent/lock");
  lock.resetLocalCoordinationState();
  budget.resetLocalBudgetState();
  return budget;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("caps", () => {
  it("defaults to 5.00 USDC a day overall and 1.00 USDC a day per wallet", async () => {
    const { dailyCapUsd, walletDailyCapUsd } = await load();
    expect(dailyCapUsd()).toBe("5.00");
    expect(walletDailyCapUsd()).toBe("1.00");
  });

  it("reads both ceilings from env", async () => {
    vi.stubEnv("AGENT_DAILY_CAP_USD", "0.50");
    vi.stubEnv("AGENT_WALLET_DAILY_CAP_USD", "0.10");
    const { dailyCapUsd, walletDailyCapUsd } = await load();
    expect(dailyCapUsd()).toBe("0.50");
    expect(walletDailyCapUsd()).toBe("0.10");
  });
});

describe("reserveDailySpend", () => {
  it("commits the amount against both counters before the purchase runs", async () => {
    const { reserveDailySpend, dailySpentUsd } = await load();

    const outcome = await reserveDailySpend({
      amountUsd: "0.02",
      walletKey: WALLET,
      service: "attester-read",
    });

    expect(outcome.ok).toBe(true);
    expect(await dailySpentUsd()).toBe("0.02");
    expect(await dailySpentUsd(WALLET)).toBe("0.02");
  });

  it("refuses at the global cap and says so in renderable prose", async () => {
    vi.stubEnv("AGENT_DAILY_CAP_USD", "0.03");
    const { reserveDailySpend, dailySpentUsd } = await load();

    const first = await reserveDailySpend({
      amountUsd: "0.02",
      walletKey: WALLET,
      service: "attester-read",
    });
    expect(first.ok).toBe(true);

    const second = await reserveDailySpend({
      amountUsd: "0.02",
      walletKey: OTHER,
      service: "vision-judge",
    });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.message).toContain("daily spend cap of 0.03 USDC");
    expect(second.message).toContain("vision-judge");
    expect(second.message).toContain("nobody is paid");
    // A refused reservation leaves nothing behind on either counter.
    expect(await dailySpentUsd()).toBe("0.02");
    expect(await dailySpentUsd(OTHER)).toBe("0.00");
  });

  it("refuses at the per-wallet cap while other wallets keep their budget", async () => {
    vi.stubEnv("AGENT_WALLET_DAILY_CAP_USD", "0.02");
    const { reserveDailySpend, dailySpentUsd } = await load();

    expect(
      (
        await reserveDailySpend({
          amountUsd: "0.02",
          walletKey: WALLET,
          service: "attester-read",
        })
      ).ok,
    ).toBe(true);

    const blocked = await reserveDailySpend({
      amountUsd: "0.02",
      walletKey: WALLET,
      service: "vision-judge",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unreachable");
    expect(blocked.message).toContain("per-wallet daily spend cap of 0.02 USDC");
    // The global counter must not keep the refused amount.
    expect(await dailySpentUsd()).toBe("0.02");

    const otherWallet = await reserveDailySpend({
      amountUsd: "0.02",
      walletKey: OTHER,
      service: "attester-read",
    });
    expect(otherWallet.ok).toBe(true);
  });

  it("treats address casing as one wallet", async () => {
    vi.stubEnv("AGENT_WALLET_DAILY_CAP_USD", "0.02");
    const { reserveDailySpend } = await load();

    await reserveDailySpend({
      amountUsd: "0.02",
      walletKey: WALLET.toLowerCase(),
      service: "attester-read",
    });
    const upper = await reserveDailySpend({
      amountUsd: "0.02",
      walletKey: WALLET.toUpperCase(),
      service: "attester-read",
    });

    expect(upper.ok).toBe(false);
  });

  it("rejects a malformed amount rather than counting it as zero", async () => {
    const { reserveDailySpend } = await load();

    await expect(
      reserveDailySpend({
        amountUsd: "0.5",
        walletKey: WALLET,
        service: "attester-read",
      }),
    ).rejects.toThrow(/two decimals/);
  });
});

describe("partial Redis failure", () => {
  /** Load budget.ts with a Redis whose wallet-key writes fail. */
  async function loadWithFlakyRedis() {
    const counters = new Map<string, number>();
    const incrby = vi.fn(async (key: string, delta: number) => {
      if (key.includes("0x")) throw new Error("upstash 503");
      const next = (counters.get(key) ?? 0) + delta;
      counters.set(key, next);
      return next;
    });
    vi.resetModules();
    vi.doMock("@/lib/server/agent/lock", () => ({
      agentRedis: () => ({
        incrby,
        expire: vi.fn().mockResolvedValue(1),
        get: vi.fn(async (key: string) => counters.get(key) ?? null),
      }),
    }));
    const budget = await import("@/lib/server/agent/budget");
    return { budget, counters, incrby };
  }

  afterEach(() => {
    vi.doUnmock("@/lib/server/agent/lock");
    vi.resetModules();
  });

  it("rolls the global counter back when the per-wallet write fails", async () => {
    // Otherwise the day's total permanently counts a purchase that never
    // happened, and SPOTTER eventually reports itself out of budget for money
    // it never spent.
    const { budget, counters } = await loadWithFlakyRedis();

    await expect(
      budget.reserveDailySpend({
        amountUsd: "0.02",
        walletKey: WALLET,
        service: "attester-read",
      }),
    ).rejects.toThrow(/upstash 503/);

    const globalKey = [...counters.keys()].find((k) => !k.includes("0x"));
    expect(counters.get(globalKey as string)).toBe(0);
  });
});

describe("release and reconcile", () => {
  it("gives the headroom back when the purchase never happened", async () => {
    const { reserveDailySpend, releaseDailySpend, dailySpentUsd } = await load();
    const outcome = await reserveDailySpend({
      amountUsd: "0.35",
      walletKey: WALLET,
      service: "vision-judge",
    });
    if (!outcome.ok) throw new Error("unreachable");

    await releaseDailySpend(outcome.reservation);

    expect(await dailySpentUsd()).toBe("0.00");
    expect(await dailySpentUsd(WALLET)).toBe("0.00");
  });

  it("corrects the day's total to what was actually charged", async () => {
    const { reserveDailySpend, reconcileDailySpend, dailySpentUsd } =
      await load();
    const outcome = await reserveDailySpend({
      amountUsd: "0.35",
      walletKey: WALLET,
      service: "vision-judge",
    });
    if (!outcome.ok) throw new Error("unreachable");

    // The service came in over its estimate; the total must not understate it.
    await reconcileDailySpend(outcome.reservation, "0.40");

    expect(await dailySpentUsd()).toBe("0.40");
    expect(await dailySpentUsd(WALLET)).toBe("0.40");
  });

  it("corrects downwards too when the service charged less than quoted", async () => {
    const { reserveDailySpend, reconcileDailySpend, dailySpentUsd } =
      await load();
    const outcome = await reserveDailySpend({
      amountUsd: "0.35",
      walletKey: WALLET,
      service: "vision-judge",
    });
    if (!outcome.ok) throw new Error("unreachable");

    await reconcileDailySpend(outcome.reservation, "0.01");

    expect(await dailySpentUsd()).toBe("0.01");
  });
});
