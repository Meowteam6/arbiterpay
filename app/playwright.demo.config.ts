import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";
import type { DemoOptions } from "./e2e/support/test";

/**
 * Demo profile: the happy-path tests, on film.
 *
 * `npm run test:e2e:demo` runs ONLY the tests tagged @demo — the browser-driven
 * happy paths (landing to goal, pool browsing and the join panel, and both
 * claim kinds ending on the SPOTTER console) — with video always on at
 * 1280x720 and every browser action slowed to 700ms so a human eye can follow
 * it. The recordings land in e2e-artifacts/demo/ as .webm, one per test, for
 * Circle/XPRIZE demo footage.
 *
 * Same servers, same mock, same fixtures as the main suite: the footage is a
 * real passing run, deterministic and offline, not a staged screen capture.
 * The mainnet settlement recording the submission also needs stays a separate
 * human step — no mock belongs in that one.
 */
export default defineConfig<DemoOptions>({
  ...baseConfig,
  grep: /@demo/,
  outputDir: "e2e-artifacts/demo",
  reporter: [["list"]],
  use: {
    ...baseConfig.use,
    viewport: { width: 1280, height: 720 },
    video: { mode: "on", size: { width: 1280, height: 720 } },
    // Never keep failure artifacts here: a demo run that fails is footage of
    // a bug, and the main config is where failures get their trace.
    trace: "off",
    screenshot: "off",
    launchOptions: { slowMo: 700 },
    // End every recording on the proven screen, not mid-assertion.
    demoHoldMs: 3_000,
  },
  projects: [
    {
      name: "demo",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
