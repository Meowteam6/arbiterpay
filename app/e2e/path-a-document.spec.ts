// Path A, document flow: /api/evidence/submit -> attester poll ->
// /api/agent/run/<goalId> -> recordResult + recordVerdict on chain.
//
// These drive the app's own routes rather than the upload widget, because
// components/EvidenceUpload.tsx is behind the same Dynamic sign-in gate as
// JoinPool (see pools-join.spec.ts). The routes are what actually decide the
// money, and they are unauthenticated by design — the browser adds no
// authority to any of this, only a file picker. What the browser DOES add is a
// signature proving which wallet is asking, and these tests sign, because the
// verdict prose only comes back to a proven owner.
//
// DEMO_MODE is off for the whole suite, so nothing here can reach the
// verified-true mock in lib/server/judge.ts. Every pass below is a verdict
// that came off the (mock) enclave wire.

import {
  REJECTED_OUTPUT,
  VERIFIED_OUTPUT,
  emptyState,
  goalIdFor,
  joinedParticipant,
  participantKey,
  pool,
} from "./support/protocol";
import { ledgerEntry, runClaimToCompletion, submitEvidence } from "./support/claim";
import { expect, test, testWallet } from "./support/test";

test.describe("document evidence to on-chain verdict", () => {
  test("a verified record is recorded on chain and settlement is deferred to the period end", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("doc-happy");
    const state = emptyState();
    state.pools = [
      pool({
        id: "1",
        initiative: "Preventive Care",
        goal: "Upload a cholesterol panel under 200 mg/dL",
        document: true,
        balance: "40000000",
      }),
    ];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    state.attester = {
      submit: "accept",
      poll: "completed",
      output: VERIFIED_OUTPUT,
    };
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    expect(submitted.status).toBe(200);
    expect(submitted.attesterId).toBeTruthy();
    // Not a fail id and not a demo mock id: a real job on the enclave wire.
    expect(submitted.attesterId).not.toMatch(/^(fail|mock)-/);

    const goalId = goalIdFor(1n, claimant.address);
    const run = await runClaimToCompletion(request, {
      goalId,
      poolId: "1",
      wallet: claimant,
      attesterId: submitted.attesterId,
    });

    // "recorded", not "paid": the verdict is on chain but the pool period is
    // still running, so settle() would pay nothing and SPOTTER defers it.
    expect(run.status).toBe("recorded");
    expect(run.access).toBe("owner");
    expect(run.claim.decision).toBe("pay");
    expect(run.claim.recordTxs?.resultTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(run.claim.recordTxs?.registryTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(run.claim.settle?.status).toBe("deferred");
    expect(run.claim.settle?.txHash).toBeNull();

    // The verdict the ledger records is the enclave's, verbatim.
    const verdict = ledgerEntry(run, "verdict");
    expect(verdict.verified).toBe(true);
    expect(verdict.confidence).toBe("high");
    expect(verdict.reason).toContain("cholesterol");

    // And the chain agrees: the participant carries a recorded PASS at the
    // 2x multiplier a high-confidence verdict earns.
    const chain = await mock.read();
    const participant = chain.participants[participantKey("1", claimant.address)];
    expect(participant.resultRecorded).toBe(true);
    expect(participant.verdict).toBe(true);
    expect(participant.multiplierBps).toBe(20_000);
  });

  test("the goal judged is the pool's, not the one the caller sent", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("doc-goal-authority");
    const state = emptyState();
    state.pools = [
      pool({
        id: "1",
        goal: "Upload a cholesterol panel under 200 mg/dL",
        document: true,
      }),
    ];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    await mock.seed(state);

    // submitEvidence deliberately sends a goalSpec of its own invention. If it
    // were honoured, a participant could describe the goal as something their
    // file trivially satisfies and drain the sponsor's pool.
    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    expect(submitted.status).toBe(200);

    // What actually crossed the enclave boundary is the chain's goal, and the
    // caller's own filename never travelled with it either.
    const snapshot = await mock.read();
    expect(snapshot.attesterPrompts).toHaveLength(1);
    expect(snapshot.attesterPrompts[0]).toContain(
      "Upload a cholesterol panel under 200 mg/dL",
    );
    expect(snapshot.attesterPrompts[0]).not.toContain(
      "whatever the caller feels like claiming",
    );
    expect(snapshot.attesterPrompts[0]).not.toContain(
      "ignored-by-the-server.txt",
    );

    const run = await runClaimToCompletion(request, {
      goalId: goalIdFor(1n, claimant.address),
      poolId: "1",
      wallet: claimant,
      attesterId: submitted.attesterId,
    });
    // The claim is bound to the wallet before a cent is spent, which is what
    // makes the ledger readable back to its owner and nobody else.
    expect(ledgerEntry(run, "plan").participant).toBe(claimant.address);
  });

  test("a rejected record pays nothing and writes nothing to the chain", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("doc-rejected");
    const state = emptyState();
    state.pools = [pool({ id: "1", document: true })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    state.attester = {
      submit: "accept",
      poll: "completed",
      output: REJECTED_OUTPUT,
    };
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    const run = await runClaimToCompletion(request, {
      goalId: goalIdFor(1n, claimant.address),
      poolId: "1",
      wallet: claimant,
      attesterId: submitted.attesterId,
    });

    expect(run.status).toBe("no-pay");
    expect(run.claim.decision).toBe("no-pay");
    expect(run.claim.recordTxs).toBeNull();

    const chain = await mock.read();
    expect(
      chain.participants[participantKey("1", claimant.address)].resultRecorded,
    ).toBe(false);
  });

  test("the spend is capped and printed before anything is bought", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("doc-receipt");
    const state = emptyState();
    state.pools = [pool({ id: "1", document: true })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    const run = await runClaimToCompletion(request, {
      goalId: goalIdFor(1n, claimant.address),
      poolId: "1",
      wallet: claimant,
      attesterId: submitted.attesterId,
    });

    // The plan is emitted before any spend and freezes the cap for the claim.
    const plan = ledgerEntry(run, "plan");
    expect(plan.capUsd).toBe("1.00");
    expect(plan.poolId).toBe("1");

    // With no x402 spend key configured the purchase settles prepaid, and the
    // receipt says so rather than inventing a payment reference.
    expect(run.claim.spends.length).toBeGreaterThan(0);
    for (const spend of run.claim.spends) {
      expect(spend.settlement).toBe("prepaid");
      expect(Number(spend.amountUsd)).toBeLessThanOrEqual(1);
    }
  });

  test("a claim is refused a verification job that belongs to someone else", async ({
    request,
    mock,
  }) => {
    const owner = testWallet("doc-job-owner");
    const thief = testWallet("doc-job-thief");
    const state = emptyState();
    state.pools = [pool({ id: "1", document: true })];
    state.participants[participantKey("1", owner.address)] = joinedParticipant();
    state.participants[participantKey("1", thief.address)] = joinedParticipant();
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: owner.address,
    });
    expect(submitted.status).toBe(200);

    // Everyone in a pool shares its goalSpec, so a leaked job id would
    // otherwise let one participant collect on another's evidence.
    const response = await request.post(
      `/api/agent/run/${goalIdFor(1n, thief.address)}?poolId=1`,
      {
        headers: await thief.authHeaders(),
        data: {
          poolId: "1",
          address: thief.address,
          attesterId: submitted.attesterId,
        },
      },
    );
    expect(response.status()).toBe(400);
    expect(await response.text()).toContain(
      "does not belong to this claim",
    );
  });

  test("a document pool cannot be claimed as a wearable one", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("doc-kind-mismatch");
    const state = emptyState();
    state.pools = [pool({ id: "1", document: true })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    await mock.seed(state);

    const response = await request.post(
      `/api/agent/run/${goalIdFor(1n, claimant.address)}?poolId=1`,
      {
        data: {
          poolId: "1",
          address: claimant.address,
          evidenceKind: "wearable",
        },
      },
    );
    expect(response.status()).toBe(400);
    expect(await response.text()).toContain(
      "this pool is verified by document evidence",
    );
  });

  test("an upload against a wearable pool is refused before the enclave is touched", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("doc-wrong-pool");
    const state = emptyState();
    state.pools = [pool({ id: "1" })]; // no [doc] marker: a wearable goal
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    expect(submitted.status).toBe(400);
    expect(submitted.error).toContain("not verified by document upload");
  });

  test("a settled pool accepts no further evidence", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("doc-settled");
    const state = emptyState();
    state.pools = [pool({ id: "1", document: true, settled: true })];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    expect(submitted.status).toBe(409);
    expect(submitted.error).toContain("already settled");
  });
});
