import fs from "node:fs";
import { Persona } from "../support/persona";
import { expect, test } from "../support/walls";

/**
 * Persona: a lighter browse pass over a DIFFERENT product surface (Merit).
 *
 * This persona shares nothing with the GoHealthMe pools flow — it only walks
 * a marketing/landing surface: read the landing, look for pricing/paywall,
 * follow the obvious CTAs up to (but never through) the sign-up / sign-in
 * gate. The auth gate IS the wall; the persona STOPS there — it never fills
 * or submits credentials. Only runs when EXPLORER_BASE_URL points at Merit.
 */
test("visitor takes a lighter browse pass over the landing", async ({ explorer, page }) => {
  const p = new Persona(
    explorer,
    "meritai-browse",
    "A first-time visitor reads the landing, looks for pricing, and follows the obvious calls-to-action up to the sign-up / sign-in wall — then stops.",
  );

  await p.tryGoto("/", "arrive at the landing page");
  await p.trySee(
    "the landing headline",
    page.getByRole("heading", { level: 1 }),
    { timeoutMs: 15_000 },
  );
  await p.settle(2_000);

  // Look for a dedicated pricing/paywall surface. A missing /pricing route or
  // an absent pricing affordance is itself a finding for a paid product.
  const pricingLink = page.getByRole("link", { name: /pricing|plans|upgrade/i });
  if ((await pricingLink.count()) > 0) {
    await p.tryClick("a Pricing link", pricingLink.first(), { graceMs: 2_000 });
    await p.settle(2_000);
  } else {
    p.note("no Pricing/Plans link in the nav; probing /pricing by URL to see if a pricing page exists");
    await p.tryGoto("/pricing", "look for a standalone pricing page");
    await p.settle(1_500);
    await p.tryGoto("/", "back to the landing");
    await p.settle(1_500);
  }

  // Follow the primary CTA. On a "free to start" product this lands on the
  // sign-up gate — the paywall/auth wall this persona stops at.
  const primaryCta = page
    .getByRole("link", { name: /start your case|start building|create your account|get started|start/i })
    .or(page.getByRole("button", { name: /start your case|start building|create your account|get started|start/i }));
  const startedCase = await p.trySee(
    "a primary call-to-action",
    primaryCta.first(),
    { timeoutMs: 12_000 },
  );
  if (startedCase) {
    await p.tryClick("the primary CTA", primaryCta.first(), { graceMs: 3_000 });
    await p.settle(3_000);
    p.note(`primary CTA landed on ${page.url()}`);
  }

  // Inspect the sign-up gate without ever submitting: presence of an email
  // field is the wall (auth/paywall). Reading the field is allowed; filling
  // or submitting it is not.
  if (!page.url().includes("/signup")) {
    await p.tryGoto("/signup", "reach the sign-up gate directly");
    await p.settle(2_000);
  }
  const emailField = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
  const sawEmail = await p.trySee(
    "an email field on the sign-up gate (inspected, never submitted)",
    emailField.first(),
    { timeoutMs: 10_000 },
  );
  if (sawEmail) {
    p.note("reached the sign-up/paywall wall — email field present; STOPPED per safety rail (no fill, no submit)");
  } else {
    p.note("sign-up gate reached but no email field surfaced within budget — recorded as the wall");
  }

  // Probe the sign-in gate too, as a read-only wall.
  await p.tryGoto("/login", "look at the sign-in gate");
  await p.settle(2_000);
  p.note("reached the sign-in wall — STOPPED per safety rail (no credentials entered)");

  const findings = await explorer.finalize();
  expect(fs.existsSync(findings.path)).toBe(true);
});
