// The suite's `test`: Playwright's, plus a handle on the mock upstream and a
// browser whose chain reads land on that same mock.

import { test as base, type APIRequestContext, type Page } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Address } from "viem";
import {
  MOCK_CONTROL_URL,
  MOCK_RPC_URL,
  emptyState,
  type MockSnapshot,
  type MockState,
} from "./protocol";

/**
 * The three public Arc RPC endpoints lib/contract.ts builds its BROWSER client
 * from. Server-side reads are redirected by ARC_RPC_URL; the client bundle has
 * no env to read, so the browser is redirected here instead. Same mock, same
 * fixture, one source of truth per test.
 */
const ARC_RPC_HOSTS = [
  "https://rpc.testnet.arc.network/**",
  "https://rpc.blockdaemon.testnet.arc.network/**",
  "https://rpc.drpc.testnet.arc.network/**",
];

/** Control-plane handle: seeds one test's view of the outside world. */
export class MockUpstream {
  constructor(private readonly request: APIRequestContext) {}

  /**
   * Replace the whole fixture. Whole-state, never patch: a test that inherits
   * half of its predecessor's chain is a test that passes for the wrong
   * reason. Seeding also resets the mock's own runtime (mined transactions,
   * recorded verdicts, issued inference ids).
   */
  async seed(state: MockState): Promise<void> {
    const response = await this.request.post(MOCK_CONTROL_URL, { data: state });
    if (!response.ok()) {
      throw new Error(
        `mock upstream refused the fixture: ${response.status()} ${await response.text()}`,
      );
    }
  }

  /** Read the fixture back — the chain's state after the app has written to
   *  it, plus what actually crossed the enclave boundary. */
  async read(): Promise<MockSnapshot> {
    const response = await this.request.get(MOCK_CONTROL_URL);
    return (await response.json()) as MockSnapshot;
  }
}

/**
 * Test options a config can set per profile.
 *
 * `demoHoldMs` keeps the page open on its final state for that long after the
 * test body finishes, so an always-on recording ends on the screen the test
 * proved rather than cutting on the assertion. The main suite leaves it at 0;
 * only playwright.demo.config.ts sets it.
 */
export interface DemoOptions {
  demoHoldMs: number;
}

// The fixture callback's second argument is conventionally named `use`, which
// trips eslint's rules-of-hooks (it reads any `use(...)` call outside a
// component as React's `use` hook). `provide` is the same function under a
// name that is not a React primitive.
export const test = base.extend<DemoOptions & { mock: MockUpstream; arcRpc: void }>({
  demoHoldMs: [0, { option: true }],

  mock: async ({ request }, provide) => {
    const upstream = new MockUpstream(request);
    // A clean slate even for specs that never seed: no test may see the
    // previous one's pools.
    await upstream.seed(emptyState());
    await provide(upstream);
  },

  // Auto-applied: every page in this suite reads the mock chain, and the one
  // third-party asset fetch a page makes is cut off before it leaves.
  arcRpc: [
    async ({ page, request, demoHoldMs }, provide) => {
      await routeArcRpc(page, request);
      await blockDynamicAssets(page);
      await provide();
      // Teardown runs before the context (and its recording) closes, so this
      // lingers on the proven end state. A no-op outside the demo profile.
      if (demoHoldMs > 0) await page.waitForTimeout(demoHoldMs);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";

/**
 * Abort the Dynamic SDK's wallet-book/icon CDN fetches.
 *
 * With NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID empty the SDK renders its
 * not-configured state, but its bundle still fires one static-asset fetch at
 * dynamic-static-assets.com per run — the only browser request in the suite
 * that would leave 127.0.0.1. Nothing asserted here depends on it, so it is
 * aborted rather than mocked.
 */
async function blockDynamicAssets(page: Page): Promise<void> {
  await page.route(
    (url) => url.hostname.endsWith("dynamic-static-assets.com"),
    (route) => route.abort(),
  );
}

/** Point one page's Arc RPC traffic at the mock upstream. */
export async function routeArcRpc(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  for (const pattern of ARC_RPC_HOSTS) {
    await page.route(pattern, async (route) => {
      const proxied = await request.post(MOCK_RPC_URL, {
        data: route.request().postDataJSON() as unknown,
      });
      await route.fulfill({
        status: proxied.status(),
        contentType: "application/json",
        body: await proxied.text(),
      });
    });
  }
}

/**
 * A wallet unique to the calling test.
 *
 * Several caches in the app are keyed by address and live for the life of the
 * process (the Junction user-id map, the agent ledger, the attester job
 * index). Giving every test its own wallet is what keeps a serial suite
 * against one long-lived dev server independent, without restarting anything.
 *
 * The signing material is derived from the label, so it is reproducible, it is
 * never written down, and it exists only to sign the app's own EIP-191
 * ownership message — the same thing a browser wallet does, which is the only
 * way to read a claim's full ledger back.
 */
export function testWallet(label: string): TestWallet {
  const key = keccak256(toHex(`e2e-wallet:${label}`));
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    async authHeaders(): Promise<Record<string, string>> {
      const timestamp = new Date().toISOString();
      const signature = await account.signMessage({
        message: `GoHealthMe: prove control of ${account.address} at ${timestamp}`,
      });
      return {
        "x-gohealthme-address": account.address,
        "x-gohealthme-timestamp": timestamp,
        "x-gohealthme-signature": signature,
      };
    },
  };
}

export interface TestWallet {
  address: Address;
  /** Headers proving control of `address`, as lib/server/wallet-auth.ts
   *  verifies them. Freshly signed per call: the server rejects anything
   *  older than ten minutes. */
  authHeaders(): Promise<Record<string, string>>;
}
