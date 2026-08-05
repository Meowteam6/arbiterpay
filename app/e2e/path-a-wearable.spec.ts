// Path A, wearable flow: Junction data -> streak-vs-threshold verdict ->
// pool membership check -> recordResult + recordVerdict.
//
// Two callers drive this, and they are not the same code path:
//   - POST /api/oracle/record, the operator/cron push. It reads Junction
//     itself, derives the verdict and the comeback multiplier, and writes both
//     on-chain records.
//   - POST /api/agent/run/<goalId> with a wearable pool, which is SPOTTER
//     deriving the same verdict through lib/server/agent/wearable.ts and
//     recording it under a ledger.
// Both are covered here; their differing behaviour on a provider outage is
// covered in fail-closed.spec.ts.

import {
  ORACLE_HEADER_VALUE,
  emptyState,
  goalIdFor,
  joinedParticipant,
  participantKey,
  pool,
  sleepDays,
} from "./support/protocol";
import { ledgerEntry, runClaimToCompletion } from "./support/claim";
import { expect, test, testWallet } from "./support/test";

const DAY = 24 * 3600;

/** Nights `from`..`to` days back, all at one score. */
function nights(from: number, to: number, score: number) {
  const days: Array<{ date: string; score: number }> = [];
  for (let back = from; back <= to; back += 1) {
    days.push({
      date: new Date(Date.now() - back * DAY * 1000).toISOString().slice(0, 10),
      score,
    });
  }
  return days;
}

test.describe("oracle push", () => {
  test("a met streak is recorded on chain and opens the settlement gate", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("wearable-oracle-pass");
    const state = emptyState();
    state.pools = [pool({ id: "1", goal: "Sleep 7 nights at score 75+" })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    state.junction = { mode: "up", connected: true, days: sleepDays(10, 90) };
    await mock.seed(state);

    const response = await request.post("/api/oracle/record", {
      headers: { "x-oracle-secret": ORACLE_HEADER_VALUE },
      data: { poolId: "1", address: claimant.address },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      txHash: string;
      verdict: boolean;
      multiplierBps: number;
      streakDays: number;
    };
    expect(body.verdict).toBe(true);
    expect(body.streakDays).toBe(7);
    // Base 1x. The comeback bonus is a separate test below.
    expect(body.multiplierBps).toBe(10_000);
    expect(body.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const chain = await mock.read();
    const participant = chain.participants[participantKey("1", claimant.address)];
    expect(participant.resultRecorded).toBe(true);
    expect(participant.verdict).toBe(true);
    expect(participant.multiplierBps).toBe(10_000);
  });

  test("a missed streak records a failing result and no passing verdict", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("wearable-oracle-fail");
    const state = emptyState();
    state.pools = [pool({ id: "1", goal: "Sleep 7 nights at score 75+" })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    // Two good nights out of the seven the goal asks for.
    state.junction = {
      mode: "up",
      connected: true,
      days: [...nights(1, 2, 90), ...nights(3, 10, 40)],
    };
    await mock.seed(state);

    const response = await request.post("/api/oracle/record", {
      headers: { "x-oracle-secret": ORACLE_HEADER_VALUE },
      data: { poolId: "1", address: claimant.address },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      verdict: boolean;
      streakDays: number;
    };
    expect(body.verdict).toBe(false);
    expect(body.streakDays).toBe(2);

    const chain = await mock.read();
    const participant = chain.participants[participantKey("1", claimant.address)];
    // The pool result is recorded either way; the registry write — the thing
    // settle() actually pays on — happens only for a pass, because
    // recordVerdict is one-shot and a recorded rejection would permanently
    // block a later passing verdict for the same goal.
    expect(participant.resultRecorded).toBe(true);
    expect(participant.verdict).toBe(false);
  });

  test("a comeback week earns the higher multiplier", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("wearable-oracle-comeback");
    const state = emptyState();
    state.pools = [pool({ id: "1", goal: "Sleep 7 nights at score 75+" })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    // Seven good nights on the back of a bad week: days 8..14 average under 60.
    state.junction = {
      mode: "up",
      connected: true,
      days: [...nights(1, 7, 90), ...nights(8, 14, 40)],
    };
    await mock.seed(state);

    const response = await request.post("/api/oracle/record", {
      headers: { "x-oracle-secret": ORACLE_HEADER_VALUE },
      data: { poolId: "1", address: claimant.address },
    });

    const body = (await response.json()) as {
      verdict: boolean;
      multiplierBps: number;
    };
    expect(body.verdict).toBe(true);
    expect(body.multiplierBps).toBe(12_500);
    expect(
      (await mock.read()).participants[participantKey("1", claimant.address)]
        .multiplierBps,
    ).toBe(12_500);
  });

  test("a wallet with no provider linked is told to connect one", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("wearable-oracle-unlinked");
    const state = emptyState();
    state.pools = [pool({ id: "1" })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    state.junction = { mode: "up", connected: false, days: [] };
    await mock.seed(state);

    const response = await request.post("/api/oracle/record", {
      headers: { "x-oracle-secret": ORACLE_HEADER_VALUE },
      data: { poolId: "1", address: claimant.address },
    });

    expect(response.status()).toBe(404);
    expect(await response.text()).toContain("No health-data provider connected");
    expect(
      (await mock.read()).participants[participantKey("1", claimant.address)]
        .resultRecorded,
    ).toBe(false);
  });
});

test.describe("SPOTTER's own wearable check", () => {
  test("a streak inside the pool period is verified and recorded", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("wearable-run-pass");
    const state = emptyState();
    state.pools = [
      pool({
        id: "1",
        goal: "Sleep 7 nights with a score of 75 or higher",
        startsInSeconds: -10 * DAY,
        endsInSeconds: 2 * DAY,
      }),
    ];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    state.junction = { mode: "up", connected: true, days: sleepDays(9, 88) };
    await mock.seed(state);

    const run = await runClaimToCompletion(request, {
      goalId: goalIdFor(1n, claimant.address),
      poolId: "1",
      wallet: claimant,
      evidenceKind: "wearable",
    });

    expect(run.status).toBe("recorded");
    expect(run.claim.decision).toBe("pay");
    expect(run.claim.recordTxs?.resultTx).toMatch(/^0x[0-9a-f]{64}$/);

    // A streak threshold check against provider data is deterministic, so the
    // confidence is always "high" and the escalation path never fires.
    const verdict = ledgerEntry(run, "verdict");
    expect(verdict.verified).toBe(true);
    expect(verdict.confidence).toBe("high");
    expect(String(verdict.reason)).toContain("qualifying days");

    // The claim's ref is synthesised from the chain's period start, never from
    // the caller, so one pool period is one claim.
    expect(String(verdict.ref)).toMatch(/^wearable-\d+$/);

    expect(
      (await mock.read()).participants[participantKey("1", claimant.address)]
        .verdict,
    ).toBe(true);
  });

  test("a short streak inside the period is a plain no-pay", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("wearable-run-short");
    const state = emptyState();
    state.pools = [
      pool({
        id: "1",
        goal: "Sleep 7 nights with a score of 75 or higher",
        startsInSeconds: -10 * DAY,
        endsInSeconds: 2 * DAY,
      }),
    ];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    state.junction = {
      mode: "up",
      connected: true,
      days: [...nights(1, 3, 88), ...nights(4, 9, 50)],
    };
    await mock.seed(state);

    const run = await runClaimToCompletion(request, {
      goalId: goalIdFor(1n, claimant.address),
      poolId: "1",
      wallet: claimant,
      evidenceKind: "wearable",
    });

    expect(run.status).toBe("no-pay");
    const verdict = ledgerEntry(run, "verdict");
    expect(verdict.verified).toBe(false);
    // Readable data that misses the goal is high confidence too: this is a
    // "you did not do it", not a "we could not tell".
    expect(verdict.confidence).toBe("high");
    expect(String(verdict.reason)).toContain("3 of 7");
    expect(run.claim.recordTxs).toBeNull();
  });

  test("a wearable claim may not carry an attester job", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("wearable-run-attester");
    const state = emptyState();
    state.pools = [pool({ id: "1" })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    await mock.seed(state);

    // A caller-supplied ref would split one claim across two ledger keys.
    const response = await request.post(
      `/api/agent/run/${goalIdFor(1n, claimant.address)}?poolId=1`,
      {
        data: {
          poolId: "1",
          address: claimant.address,
          attesterId: "borrowed-from-somewhere",
        },
      },
    );

    expect(response.status()).toBe(400);
    expect(await response.text()).toContain("wearable claims take no attesterId");
  });
});
