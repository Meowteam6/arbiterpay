// Browsing pools and the join surface.
//
// WHAT IS AND IS NOT REACHABLE HERE
//
// Joining is an on-chain write signed by a Dynamic embedded wallet, and
// components/JoinPool.tsx short-circuits on the build-time DYNAMIC_CONFIGURED
// flag before it reaches any wallet code. Producing a real signed joinPool
// from a browser would need a live Dynamic environment id (a real account,
// with live calls to Dynamic's cloud), which the zero-credential constraint
// rules out. So this spec covers what the browser genuinely decides — which
// pools are offered, which are withheld, what the join panel says, and that
// the unconfigured build refuses to pretend it can sign — and the MEANING of
// membership (one wallet, one entry, and what it gates) is covered against the
// real server in path-a-document.spec.ts and fail-closed.spec.ts, where the
// chain is the mock and a member is a fact rather than a signature.

import { emptyState, joinedParticipant, participantKey, pool } from "./support/protocol";
import { expect, test, testWallet } from "./support/test";

test.describe("pool list", () => {
  test("groups pools by what a visitor can act on", { tag: "@demo" }, async ({ page, mock }) => {
    const state = emptyState();
    state.pools = [
      pool({ id: "1", initiative: "Sleep Streak", balance: "50000000" }),
      pool({
        id: "2",
        initiative: "Flu Season",
        document: true,
        goal: "Upload a flu shot record",
        balance: "25000000",
      }),
      pool({ id: "3", initiative: "Old Pool", settled: true }),
    ];
    await mock.seed(state);

    await page.goto("/pools");

    await expect(page.getByText("Live, open to join")).toBeVisible();

    const live = page.locator("section", { hasText: "Live, open to join" });
    await expect(live.locator('a[href="/pools/1"]')).toBeVisible();
    await expect(live.locator('a[href="/pools/2"]')).toBeVisible();
    // A settled pool is history, never an invitation.
    await expect(live.locator('a[href="/pools/3"]')).toHaveCount(0);
    const settled = page.locator("section").filter({ hasText: "Old Pool" });
    await expect(settled.locator('a[href="/pools/3"]')).toBeVisible();
  });

  test("badges each pool with how its goal is verified", { tag: "@demo" }, async ({
    page,
    mock,
  }) => {
    const state = emptyState();
    state.pools = [
      pool({ id: "1", initiative: "Sleep Streak" }),
      pool({ id: "2", initiative: "Flu Season", document: true }),
    ];
    await mock.seed(state);

    await page.goto("/pools");

    // The badge is derived from the on-chain "[doc]" marker, so this asserts
    // the chain read reached the browser intact.
    await expect(page.locator('a[href="/pools/1"]')).toContainText("Wearable");
    await expect(page.locator('a[href="/pools/2"]')).toContainText("Document");
    await expect(page.locator('a[href="/pools/1"]')).toContainText("50.00");
  });

  test("separates an ended pool nobody joined from one awaiting settlement", async ({
    page,
    mock,
  }) => {
    const claimant = testWallet("pools-expired");
    const state = emptyState();
    state.pools = [
      pool({ id: "1", initiative: "Had Takers", endsInSeconds: -3600 }),
      pool({ id: "2", initiative: "No Takers", endsInSeconds: -3600 }),
    ];
    state.participants[participantKey("1", claimant.address)] =
      joinedParticipant();
    await mock.seed(state);

    await page.goto("/pools");

    // settle() has nobody to pay in pool 2, so promising a payout there would
    // be a lie the list used to tell.
    const awaiting = page.locator("section", {
      hasText: "Ended, awaiting settlement",
    });
    await expect(awaiting.locator('a[href="/pools/1"]')).toBeVisible();
    const closed = page.locator("section", { hasText: "Closed, nobody joined" });
    await expect(closed.locator('a[href="/pools/2"]')).toBeVisible();
  });

  test("says there is nothing here rather than showing an error", async ({
    page,
    mock,
  }) => {
    await mock.seed(emptyState());

    await page.goto("/pools");

    await expect(page.getByText("No pools yet")).toBeVisible();
  });
});

test.describe("pool detail", () => {
  test("offers the join panel on a live pool and refuses to fake a wallet", { tag: "@demo" }, async ({
    page,
    mock,
  }) => {
    const state = emptyState();
    state.pools = [
      pool({
        id: "1",
        initiative: "Sleep Streak",
        goal: "Sleep 7 nights with a score of 75 or higher",
        entryFee: "1000000",
        balance: "50000000",
      }),
    ];
    await mock.seed(state);

    await page.goto("/pools/1");

    await expect(
      page.getByRole("heading", {
        name: "Sleep 7 nights with a score of 75 or higher",
      }),
    ).toBeVisible();
    await expect(page.getByText("50.00 USDC")).toBeVisible();
    const joinPanel = page.locator("section", { hasText: "Join this pool" });
    await expect(
      joinPanel.getByRole("heading", { name: "Join this pool" }),
    ).toBeVisible();
    await expect(joinPanel.getByText("No one has joined yet")).toBeVisible();
    await expect(joinPanel).toContainText("1.00 USDC entry fee");

    // The honest failure: a build with no wallet integration says so inside
    // the join panel instead of rendering a button that cannot sign.
    await expect(
      joinPanel.getByText("Sign-in is not configured"),
    ).toBeVisible();
  });

  test("closes joining once the period has ended", async ({ page, mock }) => {
    const state = emptyState();
    state.pools = [pool({ id: "1", endsInSeconds: -3600 })];
    await mock.seed(state);

    await page.goto("/pools/1");

    await expect(
      page.getByRole("heading", { name: "This pool has ended" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Join this pool" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Nobody joined this one, so there is nothing here to settle."),
    ).toBeVisible();
  });

  test("a settled pool offers nothing but the way out", async ({
    page,
    mock,
  }) => {
    const state = emptyState();
    state.pools = [pool({ id: "1", settled: true, endsInSeconds: -3600 })];
    await mock.seed(state);

    await page.goto("/pools/1");

    await expect(
      page.getByRole("heading", { name: "This pool has settled" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Join this pool" }),
    ).toHaveCount(0);
  });

  test("reports a pool that does not exist instead of hanging", async ({
    page,
    mock,
  }) => {
    await mock.seed(emptyState());

    await page.goto("/pools/404");

    await expect(page.getByText("Could not load this pool")).toBeVisible();
  });
});
