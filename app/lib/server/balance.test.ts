import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";
import type { Address } from "viem";

// The balance ledger holds real money: a lost credit eats a top-up and a
// double debit sends treasury USDC twice. The concurrency cases below are the
// point of this file - the single-blob store this replaced passed every
// sequential test and still lost writes in production.

const ALICE = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaAAaAaAaAaAAaA" as Address;
const BOB = "0xBbBBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as Address;

async function loadBalance() {
  vi.stubEnv("DATA_DIR", mkdtempSync(path.join(os.tmpdir(), "balance-")));
  vi.resetModules();
  return {
    balance: await import("@/lib/server/balance"),
    store: await import("@/lib/server/store"),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("balance ledger", () => {
  it("starts at zero and credits an address", async () => {
    const { balance } = await loadBalance();
    expect(await balance.getBalance(ALICE)).toBe(0n);

    const credited = await balance.credit(ALICE, 2_000_000n, "tx-1");
    expect(credited).toEqual({ balanceUusdc: 2_000_000n, applied: true });
    expect(await balance.getBalance(ALICE)).toBe(2_000_000n);
  });

  it("applies a credit ref at most once", async () => {
    const { balance } = await loadBalance();
    await balance.credit(ALICE, 1_000_000n, "tx-1");
    const repeat = await balance.credit(ALICE, 1_000_000n, "tx-1");
    expect(repeat).toEqual({ balanceUusdc: 1_000_000n, applied: false });
    expect(await balance.getBalance(ALICE)).toBe(1_000_000n);
  });

  it("scopes refs to one address", async () => {
    const { balance } = await loadBalance();
    await balance.credit(ALICE, 1_000_000n, "tx-1");
    const bob = await balance.credit(BOB, 3_000_000n, "tx-1");
    expect(bob.applied).toBe(true);
    expect(await balance.getBalance(BOB)).toBe(3_000_000n);
  });

  it("debits, refuses an overdraft, and stays idempotent by ref", async () => {
    const { balance } = await loadBalance();
    await balance.credit(ALICE, 1_000_000n, "tx-1");

    const debited = await balance.debit(ALICE, 400_000n, "spend-1");
    expect(debited).toEqual({ balanceUusdc: 600_000n, applied: true });

    const repeat = await balance.debit(ALICE, 400_000n, "spend-1");
    expect(repeat).toEqual({ balanceUusdc: 600_000n, applied: false });

    await expect(balance.debit(ALICE, 900_000n, "spend-2")).rejects.toThrow(
      /Insufficient balance/,
    );
    expect(await balance.getBalance(ALICE)).toBe(600_000n);

    // The rejected ref is released, so the same move works after a top-up.
    await balance.credit(ALICE, 900_000n, "tx-2");
    const retried = await balance.debit(ALICE, 900_000n, "spend-2");
    expect(retried.applied).toBe(true);
    expect(await balance.getBalance(ALICE)).toBe(600_000n);
  });

  it("rejects non-positive amounts and empty refs", async () => {
    const { balance } = await loadBalance();
    await expect(balance.credit(ALICE, 0n, "tx-1")).rejects.toThrow(/positive/);
    await expect(balance.credit(ALICE, -1n, "tx-1")).rejects.toThrow(/positive/);
    await expect(balance.credit(ALICE, 1n, "  ")).rejects.toThrow(/non-empty/);
    await expect(balance.debit(ALICE, 0n, "tx-1")).rejects.toThrow(/positive/);
  });

  it("loses no concurrent credits for the same address", async () => {
    const { balance } = await loadBalance();
    const total = 20;

    const results = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        balance.credit(ALICE, 100_000n, `tx-${i}`),
      ),
    );

    expect(results.every((r) => r.applied)).toBe(true);
    expect(await balance.getBalance(ALICE)).toBe(BigInt(total) * 100_000n);
  });

  it("loses no credits when unrelated addresses top up at the same time", async () => {
    const { balance } = await loadBalance();
    const addresses = Array.from(
      { length: 20 },
      (_, i) => (`0x${String(i).padStart(2, "0").repeat(20)}`) as Address,
    );

    await Promise.all(
      addresses.map((address) => balance.credit(address, 500_000n, "tx-1")),
    );

    for (const address of addresses) {
      expect(await balance.getBalance(address)).toBe(500_000n);
    }
  });

  it("applies a repeated ref exactly once under concurrency", async () => {
    const { balance } = await loadBalance();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => balance.credit(ALICE, 250_000n, "tx-1")),
    );

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await balance.getBalance(ALICE)).toBe(250_000n);
  });

  it("never overdraws when withdrawals race each other", async () => {
    const { balance } = await loadBalance();
    await balance.credit(ALICE, 1_000_000n, "tx-1");

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        balance.debit(ALICE, 100_000n, `spend-${i}`),
      ),
    );

    const paid = settled.filter((r) => r.status === "fulfilled");
    expect(paid).toHaveLength(10);
    expect(await balance.getBalance(ALICE)).toBe(0n);
  });

  it("migrates a balance written to the pre-migration blob exactly once", async () => {
    const { balance, store } = await loadBalance();
    await store.writeJson("balances.json", {
      [ALICE.toLowerCase()]: { balanceUusdc: "4000000", applied: ["tx-old"] },
    });

    // Concurrent first touches must not credit the legacy balance twice.
    const reads = await Promise.all(
      Array.from({ length: 10 }, () => balance.getBalance(ALICE)),
    );
    expect(reads.every((value) => value === 4_000_000n)).toBe(true);

    // Refs applied before the migration stay applied.
    const replay = await balance.credit(ALICE, 4_000_000n, "tx-old");
    expect(replay.applied).toBe(false);
    expect(await balance.getBalance(ALICE)).toBe(4_000_000n);
  });

  it("rejects amounts beyond the counter range instead of rounding money", async () => {
    const { balance } = await loadBalance();
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(balance.credit(ALICE, huge, "tx-1")).rejects.toThrow(
      /exceeds the balance counter range/,
    );
  });
});
