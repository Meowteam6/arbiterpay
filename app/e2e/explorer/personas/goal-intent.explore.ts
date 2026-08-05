import fs from "node:fs";
import { Persona } from "../support/persona";
import { expect, test } from "../support/walls";

/**
 * Persona: a visitor types their goal into the landing box.
 *
 * The front door of the product: say the thing you have been putting off,
 * land on the money staked on it. /goal reads the chain through
 * /api/goals/match, so on an unconfigured surface the match step may fail —
 * exactly the first impression a real visitor would get.
 */
test("visitor uses the goal-intent box", async ({ explorer, page }) => {
  const p = new Persona(
    explorer,
    "goal-intent",
    "A visitor types the goal they have been putting off into the landing box and expects to see who is paying for it.",
  );

  await p.tryGoto("/", "arrive at the landing page");
  await p.settle(2_000);

  const goalBox = page.getByLabel("Your goal").or(
    page.getByPlaceholder(/putting off/i),
  );
  const filled = await p.tryFill(
    "the goal box",
    goalBox.first(),
    "run a 5k three times a week",
  );

  if (filled) {
    const seeButton = page.getByRole("button", { name: /see who.?s paying/i });
    const clicked = await p.tryClick("the \"See who's paying\" button", seeButton, {
      graceMs: 3_000,
    });
    if (!clicked) {
      await p.attempt("submit the goal with Enter instead", async () => {
        await goalBox.first().press("Enter");
      });
    }
  } else {
    p.note("goal box not usable; going to /goal directly with the query");
    await p.tryGoto(
      `/goal?intent=${encodeURIComponent("run a 5k three times a week")}`,
      "reach the goal-match page by URL",
    );
  }

  await p.settle(3_000);
  if (!page.url().includes("/goal")) {
    p.note(`expected to land on /goal, still on ${page.url()}`);
  }
  await p.trySee(
    "an answer to 'who is paying' (match results, an empty state, or an honest error)",
    page
      .getByRole("heading")
      .or(page.getByRole("alert"))
      .or(page.locator("a[href^='/pools/']"))
      .first(),
    { timeoutMs: 20_000 },
  );

  const findings = await explorer.finalize();
  expect(fs.existsSync(findings.path)).toBe(true);
});
