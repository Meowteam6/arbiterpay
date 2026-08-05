// Shared Arc testnet RPC access for every server-side module (server only).
//
// WHY THIS EXISTS
//
// Every server module used to build its own viem client against a SINGLE
// endpoint (`http()` with no url, or `http(ARC_RPC_URL)`), while the browser
// client in lib/contract.ts correctly ran `fallback([3 RPCs])`. One agent run
// issues six to nine chain reads and the browser polls it roughly every 800ms,
// so a handful of concurrent users pushed tens of requests per second at one
// public endpoint. That endpoint answers "request limit reached", the read
// throws, and the user gets an HTTP 500 before the run has even started.
//
// Three things fix that, and all three live here so no module can forget one:
//
//   1. fallback() over the same three public RPCs the browser already uses, so
//      one rate-limited or degraded endpoint is not an outage.
//   2. batch: true — a run's concurrent reads leave as ONE JSON-RPC array
//      instead of six to nine HTTP requests. All three Arc endpoints were
//      verified to answer batched requests (2026-08-04).
//   3. ONE module-scoped client. Rebuilding a client per call threw away
//      viem's request dedupe and batching window every time.
//
// ARC_RPC_URL, when set, is the ONLY endpoint. An operator who pins an RPC
// means it: a private endpoint is pinned for policy reasons and a test endpoint
// for hermeticity, and in both cases silently degrading to a public RPC defeats
// the pin — a hermetic test run that "resiliently" fell through its mock once
// broadcast settlement calldata at a live testnet. The fallback list above is
// the no-override case.

import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { arcTestnet } from "@/lib/chains";
import { optionalEnv } from "@/lib/server/env";

/**
 * Per-request HTTP timeout, and retries per endpoint before falling through to
 * the next one.
 *
 * These are sized against the 60s function budget on the polling routes, and
 * the worst case is the constraint: a read that hangs on every endpoint costs
 * `endpoints * (1 + retries) * timeout`. At three endpoints that is 48s, which
 * still fits. Retrying each endpoint twice instead of once pushed it to 90s —
 * past the budget on its own, before any withRetry wrapper multiplied it.
 *
 * One retry is enough because fallback() across three INDEPENDENT endpoints is
 * the real redundancy here; a second attempt at an endpoint that just failed
 * mostly buys latency. The failure this module actually exists for is a
 * rate-limited endpoint, which answers 429 immediately and falls through fast.
 */
const RPC_TIMEOUT_MS = 8_000;
const RPC_RETRY_COUNT = 1;
const RPC_RETRY_DELAY_MS = 150;
/**
 * How long the transport holds a request open to collect siblings into one
 * JSON-RPC batch. Long enough to catch a Promise.all fan-out, short enough to
 * be invisible next to Arc's block time.
 */
const RPC_BATCH_WAIT_MS = 16;

/**
 * The RPC list. With no override it is the three public RPCs from
 * lib/chains.ts — the same source lib/contract.ts builds the browser client
 * from, one list, no second copy to drift. When ARC_RPC_URL is set it is the
 * whole list: falling through past a pinned endpoint would send traffic to
 * exactly the endpoints the operator pinned away from.
 */
export function arcRpcUrls(): string[] {
  const override = optionalEnv("ARC_RPC_URL", "");
  if (override === "") return [...arcTestnet.rpcUrls.default.http];
  return [override];
}

let cachedKey = "";
let cachedTransport: Transport | null = null;
let cachedPublicClient: PublicClient | null = null;
const cachedWalletClients = new Map<string, WalletClient>();

/**
 * Shared fallback transport. Cached against the URL list so a changed
 * ARC_RPC_URL (tests, a redeploy with new env) rebuilds it instead of silently
 * serving a stale endpoint.
 */
function arcTransport(): Transport {
  const urls = arcRpcUrls();
  const key = urls.join("|");
  if (cachedTransport === null || cachedKey !== key) {
    cachedKey = key;
    cachedPublicClient = null;
    cachedWalletClients.clear();
    cachedTransport = fallback(
      urls.map((url) =>
        http(url, {
          batch: { wait: RPC_BATCH_WAIT_MS },
          timeout: RPC_TIMEOUT_MS,
          retryCount: RPC_RETRY_COUNT,
          retryDelay: RPC_RETRY_DELAY_MS,
        }),
      ),
      // Each endpoint already retries itself; retrying the whole chain on top
      // multiplies the request count at exactly the moment we are being rate
      // limited. Rank off: ranking pings every endpoint on an interval, which
      // is more background traffic at the endpoint we are trying to spare.
      { retryCount: 0, rank: false },
    );
  }
  return cachedTransport;
}

/**
 * The one Arc testnet read client. Every server module must use this rather
 * than constructing its own — a per-call client cannot batch and cannot fall
 * back.
 */
export function arcPublicClient(): PublicClient {
  const transport = arcTransport();
  if (cachedPublicClient === null) {
    cachedPublicClient = createPublicClient({
      chain: arcTestnet,
      transport,
    });
  }
  return cachedPublicClient;
}

/**
 * Wallet client for a signing account, over the same fallback transport.
 *
 * Broadcasting the same signed transaction to a second endpoint is safe: the
 * payload is nonce-bound and hashes identically, so a duplicate broadcast is
 * the same transaction, not a second one. What is NOT safe is a write that
 * cannot reach any endpoint at all, which is what the single-endpoint clients
 * risked on every money path.
 */
export function arcWalletClient(account: Account): WalletClient {
  const transport = arcTransport();
  const key = account.address.toLowerCase();
  const existing = cachedWalletClients.get(key);
  if (existing !== undefined) return existing;
  const client = createWalletClient({ account, chain: arcTestnet, transport });
  cachedWalletClients.set(key, client);
  return client;
}

/** Test seam: drop every cached client so the next call rebuilds from env. */
export function resetArcClients(): void {
  cachedKey = "";
  cachedTransport = null;
  cachedPublicClient = null;
  cachedWalletClients.clear();
}

// --------------------------------------------------------------- ttl cache

/**
 * Tiny in-process TTL cache for reads that are effectively immutable but sit on
 * a hot path.
 *
 * It lives in this module because the reads it exists for are chain reads: the
 * oracle/attester role addresses (they change roughly never, yet every agent
 * run re-reads both) and computeGoalId (fixed at pool creation, yet read on
 * every 800ms poll). Sharing one implementation keeps the eviction and
 * failure-handling rules in one place, so callers cannot each invent a subtly
 * different one.
 *
 * Two rules that matter:
 *   - a rejected load is NEVER cached. A transient RPC failure must not pin a
 *     broken answer for the whole TTL.
 *   - concurrent callers share one in-flight promise, so a burst of polls costs
 *     one RPC read, not one per poll.
 *
 * In-process only: each Vercel lambda instance keeps its own copy, which is the
 * point — no shared store to fail, and the TTL bounds the staleness.
 */
export interface TtlCacheOptions {
  ttlMs: number;
  /** Hard bound so a long-lived instance cannot grow the map without limit. */
  maxEntries?: number;
}

export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  invalidate(key?: string): void;
}

export function ttlCache<T>(options: TtlCacheOptions): TtlCache<T> {
  const ttlMs = options.ttlMs;
  const maxEntries = options.maxEntries ?? 256;
  const entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  return {
    get(key, load) {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit !== undefined && hit.expiresAt > now) return hit.value;

      const value = load();
      const entry = { expiresAt: now + ttlMs, value };
      entries.delete(key); // re-insert at the tail so eviction is oldest-first
      entries.set(key, entry);
      value.catch(() => {
        // Never cache a failure.
        if (entries.get(key) === entry) entries.delete(key);
      });

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return value;
    },
    invalidate(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}
