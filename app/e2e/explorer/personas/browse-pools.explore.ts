import fs from "node:fs";
import { Persona } from "../support/persona";
import { expect, test } from "../support/walls";

/**
 * Persona: a first-time visitor window-shopping the pools.
 *
 * Goal: reach the pool list, understand what is on offer, and open one pool
 * to read its terms. On an unconfigured surface the chain read behind the
 * list may fail — that failure, on film, is the finding.
 */
test("visitor browses the pools", async ({ explorer, page }) => {
  const p = new Persona(
    explorer,
    "browse-pools",
    "A first-time visitor wants to see which pools exist, what they pay, and open one to read its terms.",
  );

  await p.tryGoto("/", "arrive at the front door");
  await p.trySee(
    "the landing headline",
    page.getByRole("heading", { level: 1 }),
    { timeoutMs: 15_000 },
  );
  await p.settle();

  const navigated = await p.tryClick(
    "the Pools link in the header",
    page.getByRole("link", { name: "Pools" }),
  );
  if (!navigated || !page.url().includes("/pools")) {
    await p.tryGoto("/pools", "fall back to typing the URL");
  }
  await p.settle(3_000);

  const poolLinks = page.locator("a[href^='/pools/']:not([href='/pools/create'])");
  const sawSomething = await p.trySee(
    "at least one pool card (or an honest empty/error state)",
    poolLinks.or(page.getByRole("alert")).first(),
    { timeoutMs: 15_000 },
  );

  if (sawSomething && (await poolLinks.count()) > 0) {
    await p.tryClick("the first pool card", poolLinks.first());
    await p.settle(2_000);
    await p.trySee(
      "the pool's detail (a heading on the pool page)",
      page.getByRole("heading").first(),
    );
  } else {
    p.note("no pool cards rendered; trying a pool detail URL directly as a fallback");
    await p.tryGoto("/pools/1", "open pool 1 by URL");
    await p.settle(2_000);
  }

  // The one hard assertion: the run completed and findings were written.
  const findings = await explorer.finalize();
  expect(fs.existsSync(findings.path)).toBe(true);
});
