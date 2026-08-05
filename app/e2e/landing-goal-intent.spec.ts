// The front door: say the thing you have been putting off, land on the money
// already staked on it.
//
// GoalIntent itself makes no network call — it is a form that routes — so the
// first two tests are pure browser. /goal then reads the chain through the
// app's own /api/goals/match route, which is server-side and therefore reaches
// the mock upstream through ARC_RPC_URL.

import { emptyState, pool } from "./support/protocol";
import { expect, test } from "./support/test";

test.describe("landing page", () => {
  test("offers the goal box and the testnet disclosure", { tag: "@demo" }, async ({
    page,
    demoBeat,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: /Your goal\. Somebody else's money\./i }),
    ).toBeVisible();
    await demoBeat();
    // Nobody should be able to type a goal without first learning the stakes.
    await expect(page.getByText("Arc Testnet", { exact: true })).toBeVisible();
    await expect(
      page.getByText("nothing here can cost you real money"),
    ).toBeVisible();
    await demoBeat();
    await expect(page.getByLabel("Your goal")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "See who's paying" }),
    ).toBeVisible();
    await demoBeat();
  });

  test("routes a typed goal to /goal as a query", { tag: "@demo" }, async ({
    page,
    mock,
    demoBeat,
  }) => {
    // Seeded, not empty: the routing under test ends on /goal, and /goal
    // immediately asks /api/goals/match who is paying. With pools on the mock
    // chain the destination renders its real answer — ranked cards — so the
    // test (and its recording) ends on the product working, not on an empty
    // skeleton over a swallowed error.
    const state = emptyState();
    state.pools = [
      pool({
        id: "1",
        initiative: "Sleep Streak",
        goal: "Sleep 7 nights with a score of 75 or higher",
        balance: "50000000",
      }),
      pool({
        id: "2",
        initiative: "Flu Season",
        goal: "Upload a flu shot record",
        document: true,
        balance: "25000000",
      }),
    ];
    await mock.seed(state);

    await page.goto("/");
    await demoBeat();

    // Typed key by key: the query lands in the URL, and on film the typing is
    // the act that visibly produces it.
    await page
      .getByLabel("Your goal")
      .pressSequentially("sleep streak", { delay: 60 });
    await demoBeat();
    await page.getByRole("button", { name: "See who's paying" }).click();

    await expect(page).toHaveURL(/\/goal\?q=sleep(\+|%20)streak/);
    // The routed query actually matched: the sleep pool leads the list.
    const cards = page
      .locator('a[href^="/pools/"]')
      .filter({ hasText: "staked by a sponsor" });
    await expect(cards.first()).toContainText("Sleep Streak");
    await demoBeat();
  });

  test("routes an empty goal to the unfiltered list", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "See who's paying" }).click();

    await expect(page).toHaveURL(/\/goal$/);
  });
});

test.describe("goal matching", () => {
  test("ranks the pool whose goal text the query overlaps", { tag: "@demo" }, async ({
    page,
    mock,
    demoBeat,
  }) => {
    const state = emptyState();
    state.pools = [
      pool({
        id: "1",
        initiative: "Sleep Streak",
        goal: "Sleep 7 nights with a score of 75 or higher",
        balance: "50000000",
      }),
      pool({
        id: "2",
        initiative: "Flu Season",
        goal: "Upload a flu shot record",
        document: true,
        balance: "25000000",
      }),
    ];
    await mock.seed(state);

    await page.goto("/goal?q=flu%20shot");
    await demoBeat();

    const cards = page
      .locator('a[href^="/pools/"]')
      .filter({ hasText: "staked by a sponsor" });
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toHaveAttribute("href", "/pools/2");
    await expect(cards.first()).toContainText("Flu Season");
    await demoBeat();
    // The lead card is badged only when something actually matched, so this
    // asserts the ranking ran rather than that two cards happen to exist.
    await expect(cards.first()).toContainText("closest match");
    await demoBeat();
  });

  test("says so plainly when nothing is staked on the goal", async ({
    page,
    mock,
  }) => {
    await mock.seed(emptyState());

    await page.goto("/goal?q=learn%20the%20cello");

    await expect(
      page.getByText("Nothing staked on this one yet."),
    ).toBeVisible();
  });

  test("excludes settled and expired pools from matches", async ({
    page,
    mock,
  }) => {
    const state = emptyState();
    state.pools = [
      pool({ id: "1", initiative: "Sleep Streak", settled: true }),
      pool({
        id: "2",
        initiative: "Sleep Streak",
        endsInSeconds: -3600, // period already closed
      }),
    ];
    await mock.seed(state);

    await page.goto("/goal?q=sleep");

    // Both pools are about sleep; neither can be joined, so neither is an
    // answer to "who is paying for this".
    await expect(
      page.getByText("Nothing staked on this one yet."),
    ).toBeVisible();
  });
});
