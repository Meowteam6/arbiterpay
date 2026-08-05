import fs from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Explorer QA profile — persona runs against a REAL environment.
 *
 * This config is deliberately the opposite of ../..//playwright.config.ts:
 * NO mock upstream, NO hermetic preload, NO injected env. The default target
 * is the app's own `next dev` in whatever state this checkout is in — for a
 * fresh clone that means unconfigured (no Dynamic, no Circle, no Junction),
 * and the sign-in gates and config banners the personas hit on that surface
 * are the deliverable, not noise.
 *
 * Two optional escape hatches, both UNSET by default and never populated
 * by this repo:
 *   EXPLORER_BASE_URL  — point the personas at an already-running URL
 *                        instead of spawning `next dev`.
 *   EXPLORER_ENV_FILE  — a dotenv file to source into the spawned `next dev`
 *                        for a future sandbox/test-mode run. Parsed here so
 *                        no dotenv dependency is added; when unset, `next
 *                        dev` inherits only the ambient process environment.
 */

const EXPLORER_PORT = 3210;
const APP_ROOT = path.resolve(__dirname, "..", "..");
export const ARTIFACT_ROOT = path.join(APP_ROOT, "e2e-artifacts", "explorer");

const baseURL =
  process.env.EXPLORER_BASE_URL !== undefined && process.env.EXPLORER_BASE_URL !== ""
    ? process.env.EXPLORER_BASE_URL
    : `http://127.0.0.1:${EXPLORER_PORT}`;

/**
 * Minimal dotenv parser: KEY=VALUE lines, `#` comments, optional single or
 * double quotes around the value. No expansion, no multiline. Enough for a
 * sandbox env file without pulling in a dependency.
 */
function parseDotenv(filePath: string): Record<string, string> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`EXPLORER_ENV_FILE points at a file that does not exist: ${resolved}`);
  }
  const env: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const envFile = process.env.EXPLORER_ENV_FILE;
const sandboxEnv =
  envFile !== undefined && envFile !== "" ? parseDotenv(envFile) : undefined;

const spawnOwnServer =
  process.env.EXPLORER_BASE_URL === undefined || process.env.EXPLORER_BASE_URL === "";

export default defineConfig({
  testDir: path.join(__dirname, "personas"),
  testMatch: /.*\.explore\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A persona is allowed to wander; walls are recorded, not thrown, so the
  // budget is generous but finite.
  timeout: 240_000,
  expect: { timeout: 10_000 },
  outputDir: path.join(ARTIFACT_ROOT, "runs"),
  reporter: [["list"]],
  globalSetup: path.join(__dirname, "support", "reset.ts"),
  globalTeardown: path.join(__dirname, "report.ts"),
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    // Always on film: the video timestamp of each wall is part of the
    // money-shot package.
    video: { mode: "on", size: { width: 1280, height: 720 } },
    trace: "on",
    screenshot: "off",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: "explorer",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
  ],
  // Default mode: the app's own `next dev`, its own default env. No mock, no
  // preload, no injected config. With EXPLORER_BASE_URL set we spawn nothing.
  webServer: spawnOwnServer
    ? {
        command: `npx next dev -p ${EXPLORER_PORT}`,
        cwd: APP_ROOT,
        url: baseURL,
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
        // Only a sandbox run (EXPLORER_ENV_FILE) adds env; the default run
        // passes nothing so `next dev` boots exactly as it would by hand.
        ...(sandboxEnv !== undefined ? { env: sandboxEnv } : {}),
      }
    : undefined,
});
