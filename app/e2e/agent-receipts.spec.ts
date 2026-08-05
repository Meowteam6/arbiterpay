// The SPOTTER console at /agent: every claim the agent has touched, redacted
// to money facts.
//
// This is the one screen where the ledger becomes public, so the test that
// matters most is the negative one: the model-authored prose about somebody's
// medical document must not be on it. The claims are produced by driving the
// real routes first, so what renders is a real run's ledger and not a fixture.

import {
  REJECTED_OUTPUT,
  VERIFIED_OUTPUT,
  emptyState,
  goalIdFor,
  joinedParticipant,
  participantKey,
  pool,
  sleepDays,
} from "./support/protocol";
import { runClaimToCompletion, submitEvidence } from "./support/claim";
import { expect, test, testWallet } from "./support/test";

const DAY = 24 * 3600;

/** How AgentConsole abbreviates a goal id on a claim card. */
function shortGoal(goalId: string): string {
  return `${goalId.slice(0, 10)}…${goalId.slice(-6)}`;
}

test.describe("SPOTTER console", () => {
  test("prints the receipt for a claim it has just paid out on", { tag: "@demo" }, async ({
    page,
    request,
    mock,
    demoBeat,
  }) => {
    const claimant = testWallet("receipt-paid");
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
    state.attester = {
      submit: "accept",
      poll: "completed",
      output: VERIFIED_OUTPUT,
    };
    await mock.seed(state);

    // On the console FIRST, before the claim exists: the recording opens on
    // painted UI (identity card, empty feed) instead of holding a blank frame
    // while the claim below is driven over HTTP, and the reload afterwards
    // shows the receipt appearing on a screen the viewer has already seen.
    await page.goto("/agent");
    await expect(
      page.getByRole("heading", { name: "Recent claims" }),
    ).toBeVisible();
    await demoBeat();

    const submitted = await submitEvidence(request, {
      poolId: "1",
      address: claimant.address,
    });
    const goalId = goalIdFor(1n, claimant.address);
    const run = await runClaimToCompletion(request, {
      goalId,
      poolId: "1",
      wallet: claimant,
      attesterId: submitted.attesterId,
    });
    expect(run.status).toBe("recorded");

    await page.reload();

    await expect(
      page.getByRole("heading", { name: "Recent claims" }),
    ).toBeVisible();
    const card = page.locator("li").filter({ hasText: shortGoal(goalId) });
    await expect(card).toBeVisible();
    await demoBeat();

    // What SPOTTER bought, what it cost, and how it settled — the whole point
    // of the screen.
    await expect(card).toContainText("document read (TEE attester)");
    await expect(card).toContainText("0.02");
    // "metered", not "paid via x402": with no spend key configured the
    // purchase is prepaid, and the receipt must not invent a payment.
    await expect(card).toContainText("metered");
    await expect(card).toContainText("decision");
    await expect(card).toContainText("pay");
    // The pool period is still running, so the card promises the settlement
    // moment rather than a payout that has not happened.
    await expect(card).toContainText(/settle|Settle/);
    await demoBeat();

    // The redaction boundary: the enclave's prose about a medical document is
    // in the owner's ledger and must never reach this unauthenticated page.
    const consoleText = await page.locator("body").innerText();
    expect(consoleText).not.toContain("cholesterol");
    expect(consoleText).not.toContain("Upload a cholesterol panel");
  });

  test("prints the receipt for a wearable claim beside the document one", { tag: "@demo" }, async ({
    page,
    request,
    mock,
    demoBeat,
  }) => {
    const claimant = testWallet("receipt-wearable");
    const state = emptyState();
    state.pools = [
      pool({
        id: "4",
        initiative: "Sleep Streak",
        goal: "Sleep 7 nights with a score of 75 or higher",
        startsInSeconds: -10 * DAY,
        endsInSeconds: 2 * DAY,
      }),
    ];
    state.participants[participantKey("4", claimant.address)] =
      joinedParticipant();
    state.junction = { mode: "up", connected: true, days: sleepDays(9, 88) };
    await mock.seed(state);

    // Console on camera before the claim runs, same as the document test:
    // the recording opens on painted UI, then the reload reveals the receipt.
    await page.goto("/agent");
    await expect(
      page.getByRole("heading", { name: "Recent claims" }),
    ).toBeVisible();
    await demoBeat();

    const goalId = goalIdFor(4n, claimant.address);
    const run = await runClaimToCompletion(request, {
      goalId,
      poolId: "4",
      wallet: claimant,
      evidenceKind: "wearable",
    });
    expect(run.status).toBe("recorded");

    await page.reload();

    const card = page.locator("li").filter({ hasText: shortGoal(goalId) });
    await expect(card).toBeVisible();
    await demoBeat();

    // The provider read SPOTTER bought, and the verdict it derived from it.
    // Same receipt shape as a document claim: what was bought, what it cost,
    // what was decided — and nothing about the nights behind the verdict.
    await expect(card).toContainText("wearable summary (Junction)");
    await expect(card).toContainText("metered");
    await expect(card).toContainText("decision");
    await expect(card).toContainText("pay");
    await demoBeat();
  });

  test("shows a refused claim as no-pay with no payout line", async ({
    page,
    request,
    mock,
  }) => {
    const claimant = testWallet("receipt-refused");
    const state = emptyState();
    state.pools = [pool({ id: "2", document: true })];
    state.participants[participantKey("2", claimant.address)] =
      joinedParticipant();
    state.attester = {
      submit: "accept",
      poll: "completed",
      output: REJECTED_OUTPUT,
    };
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "2",
      address: claimant.address,
    });
    const goalId = goalIdFor(2n, claimant.address);
    await runClaimToCompletion(request, {
      goalId,
      poolId: "2",
      wallet: claimant,
      attesterId: submitted.attesterId,
    });

    await page.goto("/agent");

    const card = page.locator("li").filter({ hasText: shortGoal(goalId) });
    await expect(card).toContainText("no-pay");
    await expect(card).not.toContainText("paid");
    // The spend still prints: SPOTTER bought the read whether or not the
    // answer was yes, and the receipt is the record of that.
    await expect(card).toContainText("document read (TEE attester)");
  });

  test("a stranger sees the claim's money facts but never its ledger", async ({
    request,
    mock,
  }) => {
    const claimant = testWallet("receipt-privacy");
    const stranger = testWallet("receipt-privacy-stranger");
    const state = emptyState();
    state.pools = [pool({ id: "3", document: true })];
    state.participants[participantKey("3", claimant.address)] =
      joinedParticipant();
    await mock.seed(state);

    const submitted = await submitEvidence(request, {
      poolId: "3",
      address: claimant.address,
    });
    const goalId = goalIdFor(3n, claimant.address);
    await runClaimToCompletion(request, {
      goalId,
      poolId: "3",
      wallet: claimant,
      attesterId: submitted.attesterId,
    });

    // The feed publishes goal ids, so possession of one proves nothing.
    const unsigned = await request.get(`/api/agent/run/${goalId}?poolId=3`);
    const unsignedBody = (await unsigned.json()) as {
      access: string;
      hasLedger: boolean;
      ledger: unknown;
      claim: { decision: string };
    };
    expect(unsignedBody.access).toBe("unproven");
    expect(unsignedBody.hasLedger).toBe(true);
    expect(unsignedBody.ledger).toBeNull();
    expect(unsignedBody.claim.decision).toBe("pay");

    // A valid signature for the WRONG wallet is reported as such, so the UI
    // can say "wrong wallet" instead of guessing from a missing ledger.
    const wrongWallet = await request.get(`/api/agent/run/${goalId}?poolId=3`, {
      headers: await stranger.authHeaders(),
    });
    const wrongBody = (await wrongWallet.json()) as {
      access: string;
      ledger: unknown;
    };
    expect(wrongBody.access).toBe("not-owner");
    expect(wrongBody.ledger).toBeNull();

    // The participant gets it all back.
    const owner = await request.get(`/api/agent/run/${goalId}?poolId=3`, {
      headers: await claimant.authHeaders(),
    });
    const ownerBody = (await owner.json()) as {
      access: string;
      ledger: unknown[];
    };
    expect(ownerBody.access).toBe("owner");
    expect(ownerBody.ledger.length).toBeGreaterThan(0);
  });
});
