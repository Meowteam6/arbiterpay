import fs from "node:fs";
import { Persona } from "../support/persona";
import { expect, test } from "../support/walls";

/**
 * Persona: a visitor tries to join a pool with no wallet and no sign-in.
 *
 * This is a money route. On an unconfigured surface the expected wall is a
 * sign-in gate or a "joining is unavailable in this build" banner — hitting
 * that wall IS the successful outcome of this run; what matters is how the
 * product says no.
 */
test("visitor attempts to join a pool without a wallet", async ({ explorer, page }) => {
  const p = new Persona(
    explorer,
    "join-without-wallet",
    "A visitor with no wallet and no account picks a pool and tries to join it, expecting the product to either walk them into sign-up or refuse honestly.",
  );

  await p.tryGoto("/pools", "head straight for the pool list");
  await p.settle(3_000);

  const poolLinks = page.locator("a[href^='/pools/']:not([href='/pools/create'])");
  if ((await poolLinks.count()) > 0) {
    await p.tryClick("the first pool card", poolLinks.first());
  } else {
    p.note("no pool cards rendered on /pools; opening pool 1 by URL");
    await p.tryGoto("/pools/1", "open a pool detail directly");
  }
  await p.settle(2_000);

  const joinButton = page.getByRole("button", { name: /join/i });
  const joinHeading = page.getByRole("heading", { name: /join this pool/i });
  const foundJoin = await p.trySee(
    "a join affordance (button or panel)",
    joinButton.or(joinHeading).first(),
    { timeoutMs: 15_000 },
  );

  if (foundJoin && (await joinButton.count()) > 0) {
    // "Sign in to join" is the expected label without a wallet; clicking it
    // is the point — what happens next (Dynamic modal, config banner,
    // nothing at all) is the finding.
    await p.tryClick("the join button", joinButton.first(), { graceMs: 3_000 });
    await p.settle(3_000);
    p.note("observed the product's response to a wallet-less join attempt");
  } else {
    p.note(
      "no join affordance reachable — recorded as a wall; a visitor cannot even begin joining from here",
    );
  }

  const findings = await explorer.finalize();
  expect(fs.existsSync(findings.path)).toBe(true);
});
