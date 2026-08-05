// Fail-closed: the two ways Path A is allowed to end badly, and the one way it
// is never allowed to end.
//
//   1. The verification service is unreachable -> the claim stays UNVERIFIED.
//      No verdict is minted, nothing is written on chain, and the failure is
//      reported as the service's, not the person's.
//   2. The address never joined the pool -> nothing is recorded and nothing is
//      spent, at every entry point, before any upstream is touched.
//
// The suite runs with DEMO_MODE off precisely so these hold: with it on,
// lib/server/judge.ts answers a missing/failing attester with a verified-true
// mock, and case 1 would silently pass a claim.

import {
  emptyState,
  goalIdFor,
  joinedParticipant,
  participantKey,
  pool,
  sleepDays,
} from "./support/protocol";
import { runClaimToCompletion, submitEvidence } from "./support/claim";
import { expect, test, testWallet } from "./support/test";
import { ORACLE_HEADER_VALUE } from "./support/protocol";

test.describe("attester unavailable", () => {
  test("an unreachable enclave leaves the claim unverified and the chain untouched", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("fc-attester-down");
    const state = emptyState();
    state.pools = [pool({ id: "1", document: true })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    // The enclave refuses the submit outright.
    state.attester = { submit: "unreachable", poll: "completed", output: "" };
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    // The route still answers 200 with a job id: the upload succeeded, the
    // verification did not. The id carries the failure instead.
    expect(submitted.status).toBe(200);
    expect(submitted.attesterId).toMatch(/^fail-/);
    // And emphatically NOT the demo mock id, which would resolve verified.
    expect(submitted.attesterId).not.toMatch(/^mock-/);

    const run = await runClaimToCompletion(request, {
      goalId: goalIdFor(1n, claimant.address),
      poolId: "1",
      wallet: claimant,
      attesterId: submitted.attesterId,
    });

    expect(run.status).toBe("no-pay");
    expect(run.claim.decision).toBe("no-pay");
    expect(run.claim.recordTxs).toBeNull();

    const verdict = (run.ledger ?? []).find((e) => e.kind === "verdict");
    expect(verdict?.verified).toBe(false);
    // The copy has to blame the service, because the person's document was
    // never the problem.
    expect(String(verdict?.reason)).toContain("unreachable or unconfigured");

    const chain = await mock.read();
    expect(
      chain.participants[participantKey("1", claimant.address)].resultRecorded,
    ).toBe(false);
  });

  test("an enclave that goes dark mid-inference is retried, not recorded", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("fc-attester-mid");
    const state = emptyState();
    state.pools = [pool({ id: "1", document: true })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    // The submit lands; the poll cannot be reached.
    state.attester = { submit: "accept", poll: "unreachable", output: "" };
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    expect(submitted.attesterId).not.toMatch(/^fail-/);

    // "unavailable" is NOT an answer. The run must stay in "verifying" rather
    // than write an unverified result a retry seconds later would have paid.
    const response = await request.post(
      `/api/agent/run/${goalIdFor(1n, claimant.address)}?poolId=1`,
      {
        headers: await claimant.authHeaders(),
        data: {
          poolId: "1",
          address: claimant.address,
          attesterId: submitted.attesterId,
        },
      },
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("verifying");

    const chain = await mock.read();
    expect(
      chain.participants[participantKey("1", claimant.address)].resultRecorded,
    ).toBe(false);
  });
});

test.describe("wearable provider unavailable", () => {
  test("SPOTTER's run loop fails closed when the provider cannot be reached", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("fc-wearable-down");
    const state = emptyState();
    state.pools = [
      pool({ id: "1", goal: "Sleep 7 nights with a score of 75 or higher" }),
    ];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    state.junction = { mode: "down", connected: true, days: [] };
    await mock.seed(state);

    const run = await runClaimToCompletion(request, {
      goalId: goalIdFor(1n, claimant.address),
      poolId: "1",
      wallet: claimant,
      evidenceKind: "wearable",
    });

    expect(run.status).toBe("no-pay");
    const verdict = (run.ledger ?? []).find((e) => e.kind === "verdict");
    expect(verdict?.verified).toBe(false);
    expect(String(verdict?.reason)).toContain("could not be reached");

    const chain = await mock.read();
    expect(
      chain.participants[participantKey("1", claimant.address)].resultRecorded,
    ).toBe(false);
  });

  test("the oracle push route surfaces a provider outage as an error, not a verdict", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("fc-oracle-provider-down");
    const state = emptyState();
    state.pools = [pool({ id: "1" })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    state.junction = { mode: "down", connected: true, days: [] };
    await mock.seed(state);

    const response = await request.post("/api/oracle/record", {
      headers: { "x-oracle-secret": ORACLE_HEADER_VALUE },
      data: { poolId: "1", address: claimant.address },
    });

    // This asymmetry with the run loop above is real, not a test artifact:
    // /api/oracle/record has no provider-outage branch, so an outage is a 5xx
    // the caller retries. What matters for Path A is that it is never a
    // recorded result either way.
    expect(response.status()).toBeGreaterThanOrEqual(500);

    const chain = await mock.read();
    expect(
      chain.participants[participantKey("1", claimant.address)].resultRecorded,
    ).toBe(false);
  });
});

test.describe("non-member: no record, anywhere", () => {
  test("evidence submission is refused before the enclave is touched", async ({
    request,
    mock,
  }) => {
    const stranger = testWallet("fc-nonmember-evidence");
    const state = emptyState();
    state.pools = [pool({ id: "1", document: true })];
    // No participant entry at all: this wallet never joined.
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: stranger.address,
    });

    expect(submitted.status).toBe(403);
    expect(submitted.error).toContain("Join this pool before submitting");
    // TEE inference costs real money, so the membership gate has to come
    // first: nothing was sent.
    const chain = await mock.read();
    expect(chain.attesterPrompts).toHaveLength(0);
  });

  test("the run loop is refused before it spends anything", async ({
    request,
    mock,
  }) => {
    const stranger = testWallet("fc-nonmember-run");
    const state = emptyState();
    state.pools = [pool({ id: "1" })];
    await mock.seed(state);

    const response = await request.post(
      `/api/agent/run/${goalIdFor(1n, stranger.address)}?poolId=1`,
      {
        data: {
          poolId: "1",
          address: stranger.address,
          evidenceKind: "wearable",
        },
      },
    );

    expect(response.status()).toBe(403);
    expect(await response.text()).toContain("has not joined this pool");

    // No ledger means no plan entry, which means no spend could have happened.
    const ledger = await request.get(
      `/api/agent/run/${goalIdFor(1n, stranger.address)}?poolId=1`,
    );
    expect(((await ledger.json()) as { hasLedger: boolean }).hasLedger).toBe(
      false,
    );
  });

  test("the oracle push refuses a wallet that never joined", async ({
    request,
    mock,
  }) => {
    const stranger = testWallet("fc-nonmember-oracle");
    const state = emptyState();
    state.pools = [pool({ id: "1" })];
    // A perfectly good wearable streak is not membership.
    state.junction = { mode: "up", connected: true, days: sleepDays(10, 90) };
    await mock.seed(state);

    const response = await request.post("/api/oracle/record", {
      headers: { "x-oracle-secret": ORACLE_HEADER_VALUE },
      data: { poolId: "1", address: stranger.address },
    });

    expect(response.status()).toBe(403);
    expect(await response.text()).toContain("has not joined pool 1 on-chain");

    const chain = await mock.read();
    expect(
      chain.participants[participantKey("1", stranger.address)],
    ).toBeUndefined();
  });

  test("a claim cannot be run under another wallet's goal id", async ({
    request,
    mock,
  }) => {
    const member = testWallet("fc-goalid-member");
    const stranger = testWallet("fc-goalid-stranger");
    const state = emptyState();
    state.pools = [pool({ id: "1" })];
    state.participants[participantKey("1", member.address)] =
      joinedParticipant();
    await mock.seed(state);

    // The member's goal id with the stranger's address: if this were accepted,
    // one claim's evidence would run under another claim's ledger.
    const response = await request.post(
      `/api/agent/run/${goalIdFor(1n, member.address)}?poolId=1`,
      {
        data: {
          poolId: "1",
          address: stranger.address,
          evidenceKind: "wearable",
        },
      },
    );

    expect(response.status()).toBe(400);
    const text = await response.text();
    expect(text).toContain("does not match pool 1");
    // The correct id is deliberately never echoed back to a prober.
    expect(text).not.toContain(goalIdFor(1n, stranger.address));
  });
});

test.describe("oracle push authorisation", () => {
  test("refuses a missing secret", async ({ request, mock }) => {
    await mock.seed(emptyState());
    const response = await request.post("/api/oracle/record", {
      data: { poolId: "1", address: testWallet("fc-oracle-nosecret").address },
    });
    expect(response.status()).toBe(401);
  });

  test("refuses a wrong secret without leaking whether the pool exists", async ({
    request,
    mock,
  }) => {
    const state = emptyState();
    state.pools = [pool({ id: "1" })];
    await mock.seed(state);

    const response = await request.post("/api/oracle/record", {
      headers: { "x-oracle-secret": `${ORACLE_HEADER_VALUE}-wrong` },
      data: { poolId: "1", address: testWallet("fc-oracle-badsecret").address },
    });

    expect(response.status()).toBe(401);
    expect(await response.text()).toContain("x-oracle-secret");
  });
});
