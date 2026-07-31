// The private payout route is a money path. Pinned here:
//   - it pays only a participant who joined on-chain AND whose chain-derived
//     goalId has a PASSING verdict (canSettle) in the HealthVerdict registry
//     — membership alone or a rejected verdict must never mint a payout;
//   - the goalId used for both the gate and the idempotency key comes from
//     the chain, not the request body (a caller-controlled key let a fresh
//     nonce per request bypass the claimed-check and drain the treasury);
//   - the client-supplied rewardUsdc is capped server-side.

import { describe, it, expect, vi, beforeEach } from "vitest";

const participantJoined = vi.fn();
const verdictCanSettle = vi.fn();
const computeGoalId = vi.fn();
const runPrivatePayout = vi.fn();
const linkUnlinkAddress = vi.fn();
const ensureRegistered = vi.fn();

vi.mock("@/lib/server/pools", () => ({
  participantJoined: (...args: unknown[]) => participantJoined(...args),
  verdictCanSettle: (...args: unknown[]) => verdictCanSettle(...args),
}));
vi.mock("@/lib/server/verdict", () => ({
  computeGoalId: (...args: unknown[]) => computeGoalId(...args),
}));
vi.mock("@/lib/server/unlink", () => ({
  treasuryUnlinkClient: () => ({ ensureRegistered }),
  ARC_USDC_ADDRESS: "0x3600000000000000000000000000000000000000",
}));
vi.mock("@/lib/server/unlink-payout", () => ({
  runPrivatePayout: (...args: unknown[]) => runPrivatePayout(...args),
}));
vi.mock("@/lib/server/claims", () => ({
  linkUnlinkAddress: (...args: unknown[]) => linkUnlinkAddress(...args),
}));

const { POST } = await import("@/app/api/unlink/payout/route");

const USER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const GOAL = "0x" + "ab".repeat(32);

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/unlink/payout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const GOOD_BODY = {
  address: USER,
  poolId: "6",
  unlinkAddress: "unlink:abc",
};

beforeEach(() => {
  vi.clearAllMocks();
  participantJoined.mockResolvedValue(true);
  computeGoalId.mockResolvedValue(GOAL);
  verdictCanSettle.mockResolvedValue(true);
  ensureRegistered.mockResolvedValue(undefined);
  linkUnlinkAddress.mockResolvedValue(undefined);
  runPrivatePayout.mockResolvedValue({ status: "paid", goalId: GOAL });
});

describe("POST /api/unlink/payout — verdict gate", () => {
  it("rejects an invalid address before touching the chain", async () => {
    const res = await post({ ...GOOD_BODY, address: "not-an-address" });
    expect(res.status).toBe(400);
    expect(participantJoined).not.toHaveBeenCalled();
    expect(runPrivatePayout).not.toHaveBeenCalled();
  });

  it("403s a wallet that has not joined the pool", async () => {
    participantJoined.mockResolvedValue(false);
    const res = await post(GOOD_BODY);
    expect(res.status).toBe(403);
    expect(verdictCanSettle).not.toHaveBeenCalled();
    expect(runPrivatePayout).not.toHaveBeenCalled();
  });

  it("403s a joined wallet with no passing verdict (unverified OR rejected)", async () => {
    verdictCanSettle.mockResolvedValue(false);
    const res = await post(GOOD_BODY);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no passing verdict/);
    expect(runPrivatePayout).not.toHaveBeenCalled();
  });

  it("gates on the chain-derived goalId, not anything client-supplied", async () => {
    const derived = "0x" + "cd".repeat(32);
    computeGoalId.mockResolvedValue(derived);
    verdictCanSettle.mockResolvedValue(false);
    const res = await post({ ...GOOD_BODY, goalId: GOAL }); // body id differs
    expect(res.status).toBe(403);
    expect(computeGoalId).toHaveBeenCalledWith(6n, USER);
    expect(verdictCanSettle).toHaveBeenCalledWith(derived);
  });

  it("pays a joined wallet whose verdict passes canSettle", async () => {
    const res = await post(GOOD_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "paid", goalId: GOAL });
    expect(verdictCanSettle).toHaveBeenCalledWith(GOAL);
    expect(runPrivatePayout).toHaveBeenCalledTimes(1);
  });

  it("keys the payout idempotency on the chain-derived goalId, ignoring the body's", async () => {
    await post({ ...GOOD_BODY, goalId: "attacker-nonce-1" });
    const input = runPrivatePayout.mock.calls[0][0] as { goalId: string };
    expect(input.goalId).toBe(GOAL);
  });

  it("500s (not pays) when the verdict read itself fails", async () => {
    verdictCanSettle.mockRejectedValue(
      new Error("Missing required env var: HEALTH_VERDICT_ADDRESS"),
    );
    const res = await post(GOOD_BODY);
    expect(res.status).toBe(500);
    expect(runPrivatePayout).not.toHaveBeenCalled();
  });
});

describe("POST /api/unlink/payout — reward cap", () => {
  it("rejects a rewardUsdc above the server cap", async () => {
    const res = await post({ ...GOOD_BODY, rewardUsdc: "100" });
    expect(res.status).toBe(400);
    expect(runPrivatePayout).not.toHaveBeenCalled();
  });

  it("rejects a zero or malformed rewardUsdc", async () => {
    expect((await post({ ...GOOD_BODY, rewardUsdc: "0" })).status).toBe(400);
    expect((await post({ ...GOOD_BODY, rewardUsdc: "-1" })).status).toBe(400);
    expect((await post({ ...GOOD_BODY, rewardUsdc: "abc" })).status).toBe(400);
    expect(runPrivatePayout).not.toHaveBeenCalled();
  });

  it("accepts a rewardUsdc at or below the cap", async () => {
    const res = await post({ ...GOOD_BODY, rewardUsdc: "0.10" });
    expect(res.status).toBe(200);
    const input = runPrivatePayout.mock.calls[0][0] as {
      amountBaseUnits: string;
    };
    expect(input.amountBaseUnits).toBe("100000");
  });
});
