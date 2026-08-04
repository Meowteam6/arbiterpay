import { describe, it, expect, vi, beforeEach } from "vitest";
import { unmarkClaimed } from "@/lib/server/claims";
import { runPrivatePayout } from "@/lib/server/unlink-payout";

function fakeTreasury() {
  return {
    deposit: vi.fn(async () => ({ txId: "dep-1" })),
    transfer: vi.fn(async () => ({ txId: "xfer-1" })),
  };
}
describe("runPrivatePayout", () => {
  // Reset through the claims API rather than deleting a file: the claim flag
  // is a store key now, not an entry in one shared blob.
  beforeEach(async () => {
    await unmarkClaimed("goal-1");
  });
  it("deposits then transfers to the recipient and marks claimed", async () => {
    const treasury = fakeTreasury();
    const res = await runPrivatePayout({
      goalId: "goal-1",
      recipientUnlinkAddress: "unlink1recipient",
      amountBaseUnits: "250000",
      token: "0xUSDC",
      treasury,
    });
    expect(res.status).toBe("paid");
    expect(treasury.deposit).toHaveBeenCalledWith({ token: "0xUSDC", amount: "250000" });
    expect(treasury.transfer).toHaveBeenCalledWith({
      token: "0xUSDC",
      amount: "250000",
      recipientAddress: "unlink1recipient",
    });
    expect(treasury.deposit.mock.invocationCallOrder[0]).toBeLessThan(
      treasury.transfer.mock.invocationCallOrder[0],
    );
  });
  it("releases the claim lock when the payout fails so retry is possible", async () => {
    const failing = {
      deposit: vi.fn(async () => {
        throw new Error("token provider failed");
      }),
      transfer: vi.fn(async () => ({ txId: "xfer-1" })),
    };
    await expect(
      runPrivatePayout({
        goalId: "goal-1",
        recipientUnlinkAddress: "unlink1recipient",
        amountBaseUnits: "250000",
        token: "0xUSDC",
        treasury: failing,
      }),
    ).rejects.toThrow("token provider failed");

    // Lock was rolled back: a follow-up attempt actually runs the payout.
    const ok = fakeTreasury();
    const res = await runPrivatePayout({
      goalId: "goal-1",
      recipientUnlinkAddress: "unlink1recipient",
      amountBaseUnits: "250000",
      token: "0xUSDC",
      treasury: ok,
    });
    expect(res.status).toBe("paid");
    expect(ok.deposit).toHaveBeenCalledOnce();
  });

  it("is idempotent for the same goalId", async () => {
    const t1 = fakeTreasury();
    const args = {
      goalId: "goal-1",
      recipientUnlinkAddress: "unlink1recipient",
      amountBaseUnits: "250000",
      token: "0xUSDC",
    };
    await runPrivatePayout({ ...args, treasury: t1 });
    const second = await runPrivatePayout({ ...args, treasury: fakeTreasury() });
    expect(second.status).toBe("already-claimed");
  });
});
