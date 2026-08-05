import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";
import type { DemoOptions } from "./e2e/support/test";

/**
 * Demo profile: the happy-path tests, on film.
 *
 * `npm run test:e2e:demo` runs ONLY the tests tagged @demo — the browser-driven
 * happy paths (landing to goal, pool browsing and the join panel, and both
 * claim kinds ending on the SPOTTER console) — with video always on at
 * 1280x720, every browser action slowed to 700ms, and a beat held after each
 * meaningful step (see demoBeat in e2e/support/test.ts) so a human eye can
 * follow the flow. The recordings land in e2e-artifacts/demo/ as .webm, one
 * per test, for Circle/XPRIZE demo footage.
 *
 * Same servers, same mock, same fixtures as the main suite: the footage is a
 * real passing run, deterministic and offline, not a staged screen capture.
 * The one difference is NEXT_PUBLIC_DEMO_CHROME, a cosmetic-only flag (see
 * lib/config.ts) that keeps the operator-facing configuration banner and the
 * Next dev-tools badge out of frame — no behavioral fallback changes with it,
 * which is why the same specs pass identically under both profiles.
 * The mainnet settlement recording the submission also needs stays a separate
 * human step — no mock belongs in that one.
 */

const servers = Array.isArray(baseConfig.webServer) ? baseConfig.webServer : [];
const [mockServer, appServer] = servers;
if (mockServer === undefined || appServer === undefined) {
  throw new Error(
    "playwright.config.ts no longer defines the mock+app server pair the demo profile builds on",
  );
}

export default defineConfig<DemoOptions>({
  ...baseConfig,
  grep: /@demo/,
  outputDir: "e2e-artifacts/demo",
  reporter: [["list"]],
  webServer: [
    mockServer,
    {
      ...appServer,
      // Never reuse a dev server that was started without the demo chrome
      // env: NEXT_PUBLIC_ values are baked in per process, so a stale main
      // profile (or manual `npm run dev`) server would put the banner back on
      // camera. Failing on an occupied port is better than silently filming
      // the wrong chrome.
      reuseExistingServer: false,
      env: {
        ...appServer.env,
        NEXT_PUBLIC_DEMO_CHROME: "1",
      },
    },
  ],
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
    demoHoldMs: 4_000,
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
