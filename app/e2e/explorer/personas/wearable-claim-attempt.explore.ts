import fs from "node:fs";
import { Persona } from "../support/persona";
import { expect, test } from "../support/walls";

/**
 * Persona: a user tries to run a wearable check to claim.
 *
 * Money route. The wearable path stacks three gates — sign in, join, connect
 * a provider — and on an unconfigured surface at least the first refuses.
 * The persona pushes each gate in turn and films what the refusal looks like.
 */
test("user attempts a wearable claim", async ({ explorer, page }) => {
  const p = new Persona(
    explorer,
    "wearable-claim-attempt",
    "A user with a fitness wearable wants the app to read their device, verify the goal, and pay out; they follow whatever the wearable claim path offers.",
  );

  await p.tryGoto("/pools", "look for a wearable-verified pool");
  await p.settle(3_000);

  const poolLinks = page.locator("a[href^='/pools/']:not([href='/pools/create'])");
  const count = await poolLinks.count();
  if (count > 0) {
    // Wearable pools are not labeled distinguishably from out here without
    // reading each one; walk up to two cards looking for the wearable claim
    // surface, then settle for whatever the last one shows.
    let opened = false;
    for (let i = 0; i < Math.min(count, 2) && !opened; i += 1) {
      await p.tryClick(`pool card #${i + 1}`, poolLinks.nth(i));
      await p.settle(2_000);
      const wearableSurface = page.getByText(
        /wearable|connect a wearable|run the check|check again/i,
      );
      if ((await wearableSurface.count()) > 0) {
        p.note(`pool card #${i + 1} shows a wearable surface`);
        opened = true;
      } else if (i < Math.min(count, 2) - 1) {
        await p.tryGoto("/pools", "back to the list for the next card");
        await p.settle(2_000);
      }
    }
  } else {
    p.note("no pool cards rendered; opening pool 1 by URL");
    await p.tryGoto("/pools/1", "open a pool detail directly");
    await p.settle(2_000);
  }

  const checkAffordance = page.getByRole("button", {
    name: /run the check|check again|connect a wearable|sign in to run the check/i,
  });
  const foundCheck = await p.trySee(
    "a wearable-check affordance",
    checkAffordance.or(page.getByText(/connect a wearable/i)).first(),
    { timeoutMs: 12_000 },
  );

  if (foundCheck && (await checkAffordance.count()) > 0) {
    await p.tryClick("the wearable-check button", checkAffordance.first(), {
      graceMs: 4_000,
    });
    await p.settle(4_000);
    p.note("observed the product's response to the wearable check attempt");
  } else {
    p.note(
      "wearable claim surface not reachable without joining/signing in — the gate is the finding",
    );
    const signIn = page.getByRole("button", { name: /sign in/i });
    if ((await signIn.count()) > 0) {
      await p.tryClick("a sign-in button, to see what the gate does", signIn.first(), {
        graceMs: 3_000,
      });
      await p.settle(2_000);
    }
  }

  const findings = await explorer.finalize();
  expect(fs.existsSync(findings.path)).toBe(true);
});
