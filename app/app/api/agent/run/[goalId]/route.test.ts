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
//   - both verbs are redacted for anyone who cannot PROVE they own the claim.
//     Model prose about a medical document leaves the server only for a caller
//     who signs as the claim's participant; a goalId is published by
//     /api/agent/feed and an address is public on chain, so neither is a
//     credential. The owner still gets the full ledger, because a returning
//     user staring at a blank upload box over a claim they already paid for is
//     the regression that redaction caused.
//   - a thrown failure reaches the caller as a reference, not as its text.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { walletAuthMessage } from "@/lib/server/wallet-auth";

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
// A real key, because the ownership proof is a real signature: the test has to
// sign exactly the way a wallet does or it proves nothing.
const USER_ACCOUNT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const USER = USER_ACCOUNT.address;
const STRANGER_ACCOUNT = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

/** The three headers a signed browser request carries. */
async function signedHeaders(
  account: typeof USER_ACCOUNT,
  address: string = account.address,
  signedAtMs: number = Date.now(),
): Promise<Record<string, string>> {
  const timestamp = new Date(signedAtMs).toISOString();
  return {
    "x-gohealthme-address": address,
    "x-gohealthme-timestamp": timestamp,
    "x-gohealthme-signature": await account.signMessage({
      message: walletAuthMessage(address, timestamp),
    }),
  };
}

/** The store file behind one claim's ledger, so a plan entry (one per goal,
 *  ever) can be re-seeded on every run. */
async function resetLedger(goalId: string): Promise<void> {
  const dir = process.env.DATA_DIR;
  if (dir === undefined) throw new Error("DATA_DIR must be set for this test");
  await fs.rm(path.join(dir, `agent-ledger-${goalId.toLowerCase()}.jsonl`), {
    force: true,
  });
  await fs.rm(path.join(dir, `agent-ledger-${goalId.toLowerCase()}.json`), {
    force: true,
  });
}

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

function post(
  goalId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return POST(
    new Request(`http://localhost/api/agent/run/${goalId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ctx(goalId),
  );
}

function get(
  goalId: string,
  options: { headers?: Record<string, string>; query?: string } = {},
) {
  const url = `http://localhost/api/agent/run/${goalId}${options.query ?? ""}`;
  return GET(new Request(url, { headers: options.headers ?? {} }), ctx(goalId));
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

  it("runs the agent and returns its status, with the ledger for its owner", async () => {
    runAgentForGoal.mockResolvedValue({
      status: "paid",
      ledger: [{ kind: "plan", participant: USER }],
    });

    const res = await post(GOAL, GOOD_BODY, await signedHeaders(USER_ACCOUNT));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      ledger: unknown[] | null;
    };
    expect(body.status).toBe("paid");
    expect(body.ledger).toEqual([{ kind: "plan", participant: USER }]);
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

  it("withholds the ledger from an unsigned caller but still runs", async () => {
    // The run stays permissionless on purpose - it is idempotent, capped and
    // verdict-gated - so an unsigned poll costs visibility, never money.
    runAgentForGoal.mockResolvedValue({
      status: "no-pay",
      ledger: [
        { kind: "plan", participant: USER },
        {
          kind: "reason",
          decision: "no-pay",
          note: "the scan shows no immunisation on the stated date",
        },
      ],
    });

    const res = await post(GOAL, GOOD_BODY);

    expect(res.status).toBe(200);
    expect(runAgentForGoal).toHaveBeenCalled();
    const text = await res.text();
    expect(text).not.toMatch(/immunisation/i);
    const body = JSON.parse(text) as {
      status: string;
      ledger: unknown;
      hasLedger: boolean;
      claim: { decision: string | null };
    };
    expect(body.status).toBe("no-pay");
    expect(body.ledger).toBeNull();
    expect(body.hasLedger).toBe(true);
    expect(body.claim.decision).toBe("no-pay");
  });

  it("withholds the ledger from a caller who signed as somebody else", async () => {
    runAgentForGoal.mockResolvedValue({
      status: "paid",
      ledger: [{ kind: "plan", participant: USER }],
    });

    // A valid signature over the stranger's own address: proof of control of
    // a wallet, which is not the same thing as proof of THIS claim.
    const res = await post(
      GOAL,
      GOOD_BODY,
      await signedHeaders(STRANGER_ACCOUNT),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ledger: unknown; access: string };
    expect(body.ledger).toBeNull();
    expect(body.access).toBe("not-owner");
  });

  it("withholds the ledger when the signature is stale", async () => {
    runAgentForGoal.mockResolvedValue({
      status: "paid",
      ledger: [{ kind: "plan", participant: USER }],
    });
    // Signed correctly, an hour ago: a leaked header set has a ten minute
    // life, not an unlimited one.
    const stale = await signedHeaders(
      USER_ACCOUNT,
      USER,
      Date.now() - 60 * 60 * 1000,
    );

    const res = await post(GOAL, GOOD_BODY, stale);

    const body = (await res.json()) as { ledger: unknown; access: string };
    expect(body.ledger).toBeNull();
    // Expiry is recoverable and must not read as the wrong wallet.
    expect(body.access).toBe("unproven");
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
  const OWNED = `0x${"7e".repeat(32)}`;
  const PROSE_REASON =
    "the record shows a quadrivalent influenza vaccine on 2026-03-02";
  const PROSE_NOTE =
    "the enclave read the immunisation record and it matches the goal";

  /** A claim owned by USER, seeded the way the run loop writes it. */
  async function seedOwnedClaim(participant?: string): Promise<void> {
    await resetLedger(OWNED);
    await appendLedger(OWNED, {
      kind: "plan",
      steps: [{ service: "attester-read", label: "TEE read", estUsd: "0.10" }],
      capUsd: "1.00",
      poolId: "7",
      ...(participant !== undefined ? { participant } : {}),
    });
    await appendLedger(OWNED, {
      kind: "verdict",
      verified: true,
      confidence: "high",
      reason: PROSE_REASON,
      ref: "att-1",
    });
    await appendLedger(OWNED, {
      kind: "reason",
      decision: "pay",
      note: PROSE_NOTE,
      ref: "att-1",
    });
  }

  it("rejects a malformed goalId", async () => {
    const res = await get("xyz");
    expect(res.status).toBe(400);
  });

  it("returns an empty public claim for a goal with no ledger", async () => {
    const empty = `0x${"11".repeat(32)}`;
    const res = await get(empty);
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
      access: "unproven",
      hasLedger: false,
      ledger: null,
    });
  });

  it("never leaks verdict prose, decision notes or the goal text", async () => {
    await seedOwnedClaim(USER);

    const res = await get(OWNED);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/influenza|immunisation|quadrivalent/i);
    const body = JSON.parse(text) as {
      claim: { decision: string | null };
      hasLedger: boolean;
      ledger: unknown;
    };
    // The machine state still crosses; only the prose behind it does not.
    expect(body.claim.decision).toBe("pay");
    expect(body.ledger).toBeNull();
    // A withheld claim must still say it exists, or the browser shows an
    // upload box over work the user already paid for.
    expect(body.hasLedger).toBe(true);
  });

  it("hands the full ledger to the participant who signs for it", async () => {
    await seedOwnedClaim(USER);

    const res = await get(OWNED, { headers: await signedHeaders(USER_ACCOUNT) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ledger: { kind: string }[] | null };
    expect(body.ledger).not.toBeNull();
    expect(body.ledger?.map((e) => e.kind)).toEqual([
      "plan",
      "verdict",
      "reason",
    ]);
    expect(JSON.stringify(body.ledger)).toContain(PROSE_REASON);
  });

  it("refuses a stranger who proves control of their own wallet", async () => {
    await seedOwnedClaim(USER);

    const res = await get(OWNED, {
      headers: await signedHeaders(STRANGER_ACCOUNT),
    });

    const text = await res.text();
    expect(text).not.toMatch(/influenza|immunisation/i);
    const body = JSON.parse(text) as { ledger: unknown; access: string };
    expect(body.ledger).toBeNull();
    // Definitively somebody else, and said so: this is the ONE case where the
    // browser may tell a person the claim belongs to another wallet.
    expect(body.access).toBe("not-owner");
  });

  it("calls an expired signature unproven, not somebody else's claim", async () => {
    // The difference the copy hangs on. An owner whose signature aged out (or
    // whose clock drifted) must be told to sign again, never that their own
    // claim belongs to a stranger.
    await seedOwnedClaim(USER);

    const res = await get(OWNED, {
      headers: await signedHeaders(
        USER_ACCOUNT,
        USER,
        Date.now() - 60 * 60 * 1000,
      ),
    });

    expect(((await res.json()) as { access: string }).access).toBe("unproven");
  });

  it("calls an unsigned read unproven", async () => {
    await seedOwnedClaim(USER);
    const res = await get(OWNED);
    expect(((await res.json()) as { access: string }).access).toBe("unproven");
  });

  it("reports the owner as the owner", async () => {
    await seedOwnedClaim(USER);
    const res = await get(OWNED, { headers: await signedHeaders(USER_ACCOUNT) });
    expect(((await res.json()) as { access: string }).access).toBe("owner");
  });

  it("refuses a caller who names the owner's address without signing as it", async () => {
    // The whole point: an address is public. Claiming it in a header proves
    // nothing without the matching signature.
    await seedOwnedClaim(USER);

    const res = await get(OWNED, {
      headers: await signedHeaders(STRANGER_ACCOUNT, USER),
    });

    expect((await res.json() as { ledger: unknown }).ledger).toBeNull();
  });

  it("refuses a signature that has aged out", async () => {
    await seedOwnedClaim(USER);

    const res = await get(OWNED, {
      headers: await signedHeaders(
        USER_ACCOUNT,
        USER,
        Date.now() - 60 * 60 * 1000,
      ),
    });

    expect((await res.json() as { ledger: unknown }).ledger).toBeNull();
  });

  it("falls back to the chain for a ledger written before the plan named its participant", async () => {
    // Older claims carry no participant, and their owners must not be locked
    // out of their own receipts. computeGoalId(poolId, signer) === goalId is
    // the chain's own statement that this wallet is the claim's participant.
    await seedOwnedClaim(undefined);
    computeGoalId.mockResolvedValue(OWNED);

    const res = await get(OWNED, {
      headers: await signedHeaders(USER_ACCOUNT),
      query: "?poolId=7",
    });

    const body = (await res.json()) as { ledger: unknown[] | null };
    expect(body.ledger).not.toBeNull();
    expect(computeGoalId).toHaveBeenCalledWith(7n, USER);
  });

  it("does not let the chain fallback pass for a different goal", async () => {
    await seedOwnedClaim(undefined);
    computeGoalId.mockResolvedValue(`0x${"cd".repeat(32)}`);

    const res = await get(OWNED, {
      headers: await signedHeaders(USER_ACCOUNT),
      query: "?poolId=7",
    });

    const body = (await res.json()) as { ledger: unknown; access: string };
    expect(body.ledger).toBeNull();
    // The chain answered and the answer was no, so this one IS somebody else.
    expect(body.access).toBe("not-owner");
  });

  it("fails closed when the chain read for the fallback throws", async () => {
    await seedOwnedClaim(undefined);
    computeGoalId.mockRejectedValue(new Error("rpc down"));

    const res = await get(OWNED, {
      headers: await signedHeaders(USER_ACCOUNT),
      query: "?poolId=7",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ledger: unknown; access: string };
    expect(body.ledger).toBeNull();
    // Withheld, but NOT evidence that the caller is somebody else: a dead RPC
    // must not turn into "this claim belongs to a different wallet".
    expect(body.access).toBe("unproven");
  });

  it("never asks the chain when the ledger already names its participant", async () => {
    await seedOwnedClaim(USER);

    await get(OWNED, {
      headers: await signedHeaders(USER_ACCOUNT),
      query: "?poolId=7",
    });

    expect(computeGoalId).not.toHaveBeenCalled();
  });
});
