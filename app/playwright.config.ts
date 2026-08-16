import path from "path";
import { defineConfig, devices } from "@playwright/test";
import {
  APP_BASE_URL,
  APP_PORT,
  E2E_ORACLE_SIGNER,
  HEALTH_POOLS_ADDRESS,
  HEALTH_VERDICT_ADDRESS,
  MOCK_ATTESTER_URL,
  MOCK_BASE_URL,
  MOCK_JUNCTION_URL,
  MOCK_RPC_URL,
  ORACLE_HEADER_VALUE,
  PLACEHOLDER_ENTITY_HEX,
  PLACEHOLDER_TOKEN,
} from "./e2e/support/protocol";

/**
 * Path A end-to-end suite.
 *
 * TWO SERVERS, ZERO CREDENTIALS
 *
 * `e2e/support/mock-upstream.ts` stands in for Arc testnet, Junction and the
 * Chainlink Confidential AI attester. The app is pointed at it through the env
 * vars the product already honours, so no request in this suite leaves
 * 127.0.0.1 and nothing here is a real key. See e2e/support/protocol.ts for
 * why each value below is inert.
 *
 * `next dev`, NOT `next build && next start`: lib/server/store.ts refuses to
 * boot when NODE_ENV is production without Redis configured (a serverless
 * deploy that silently writes to a per-invocation tmpdir loses user money).
 * Development mode engages the JSON file-store fallback instead, which is
 * exactly what a single long-lived test process wants.
 *
 * Serial, one worker: those file-store writes are shared process state, the
 * same reason vitest.config.ts sets `fileParallelism: false`.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  // One retry under CI only: the run-loop specs sit close enough to the timeout
  // that a slow runner flakes them, and a red main is worse than a slow one.
  // Local runs stay strict so a real hang is not papered over.
  retries: process.env.CI !== undefined ? 1 : 0,
  forbidOnly: process.env.CI !== undefined,
  // A document claim's run loop does two on-chain writes and waits for both
  // receipts. 45s used to be comfortable; after the RPC fallback reorder in
  // 77a5331 the receipt specs land at 46-50s on CI runners, so the old ceiling
  // failed them on latency alone. 90s still catches a genuine hang.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter:
    process.env.CI !== undefined
      ? [["github"], ["html", { open: "never" }], ["list"]]
      : [["list"]],
  use: {
    baseURL: APP_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // A failure's last seconds on film answer "what did the page actually
    // do" without a local repro; passing runs record nothing. The always-on
    // demo profile lives in playwright.demo.config.ts.
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx tsx e2e/support/mock-upstream.ts",
      url: `${MOCK_BASE_URL}/health`,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npx next dev -p ${APP_PORT}`,
      url: APP_BASE_URL,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        // --- where the outside world lives for this run. Every override is
        // EXCLUSIVE in the app (no public fallback once set), which is what
        // makes pointing them at the mock airtight rather than best-effort.
        ARC_RPC_URL: MOCK_RPC_URL,
        JUNCTION_BASE_URL: MOCK_JUNCTION_URL,
        CONFIDENTIAL_AI_BASE_URL: MOCK_ATTESTER_URL,
        // The Circle SDK behind /api/agent/wallet answers to this too; the
        // mock's /circle stub serves SPOTTER's provisioned wallet for the two
        // reads that route makes and refuses everything else, so the /agent
        // console renders the real agent state, deterministically and offline.
        CIRCLE_API_BASE_URL: `${MOCK_BASE_URL}/circle`,
        // No build metrics phoned home from a hermetic run.
        NEXT_TELEMETRY_DISABLED: "1",
        // Two dev-process fetches have no env switch at all (Next's npm
        // version check, the Dynamic SDK's SSR asset fetch); this preload
        // answers them locally. See e2e/support/hermetic.cjs, including for
        // why it must be the ONE --require here.
        NODE_OPTIONS: `--require ${path.join(__dirname, "e2e", "support", "hermetic.cjs")}`,

        // --- contract wiring. Deployment addresses are not secrets; these two
        // are made up and only ever passed to the mock RPC as call arguments.
        HEALTH_POOLS_ADDRESS,
        NEXT_PUBLIC_HEALTH_POOLS_ADDRESS: HEALTH_POOLS_ADDRESS,
        HEALTH_VERDICT_ADDRESS,

        // --- local-only values. See e2e/support/protocol.ts.
        ORACLE_API_SECRET: ORACLE_HEADER_VALUE,
        ORACLE_SIGNER_PRIVATE_KEY: E2E_ORACLE_SIGNER,
        JUNCTION_API_KEY: PLACEHOLDER_TOKEN,
        CONFIDENTIAL_AI_API_KEY: PLACEHOLDER_TOKEN,
        CIRCLE_API_KEY: PLACEHOLDER_TOKEN,
        CIRCLE_ENTITY_SECRET: PLACEHOLDER_ENTITY_HEX,
        CIRCLE_WALLET_ID: PLACEHOLDER_TOKEN,

        // --- deliberately absent, each one selecting a documented fallback:
        //   DEMO_MODE            off  -> the attester must fail CLOSED; the
        //                                verified-true mock is unreachable, so
        //                                every pass in this suite is a real
        //                                verdict off the (mock) enclave wire.
        //   SPOTTER_WALLET_ADDRESS    -> SPOTTER never holds the oracle or
        //                                attester role, so the run loop takes
        //                                the legacy oracle-key write path and
        //                                the Circle client is never invoked.
        //   X402_PRIVATE_KEY          -> every purchase settles "prepaid" with
        //                                no gateway call.
        //   GOOGLE_CLOUD_PROJECT      -> the reason step is the deterministic
        //                                rule, not a Gemini round trip.
        //   KV_/UPSTASH_ REST vars    -> the JSON file store under DATA_DIR.
        //   NEXT_PUBLIC_DYNAMIC_...   -> wallet-gated components render their
        //                                "sign-in is not configured" state.
        DEMO_MODE: "",
        SPOTTER_WALLET_ADDRESS: "",
        X402_PRIVATE_KEY: "",
        GOOGLE_CLOUD_PROJECT: "",
        KV_REST_API_URL: "",
        KV_REST_API_TOKEN: "",
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
        NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID: "",
        UNLINK_API_KEY: "",

        // Reserved in .gitignore for exactly this, and distinct from vitest's
        // .data so a unit run and an e2e run cannot corrupt each other.
        DATA_DIR: path.join(__dirname, ".data-e2e"),
        // Keep the wearable/attester timeouts short: a "down" fixture should
        // fail a test in seconds, not stall it for the full 15s default.
        JUNCTION_TIMEOUT_MS: "2000",
        ATTESTER_TIMEOUT_MS: "2000",
      },
    },
  ],
  globalSetup: "./e2e/support/global-setup.ts",
});
