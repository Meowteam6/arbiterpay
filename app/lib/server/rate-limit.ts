// Request rate limiting for every /api/* route, driven from proxy.ts.
//
// WHY THIS EXISTS: before this module nothing in the app bounded request
// volume. Every unauthenticated route could be called without limit, which
// multiplies the blast radius of every other weakness: an enumeration bug
// becomes a full scrape, a payable route becomes a way to drain the agent's
// budget, and a paid upstream (Junction, the attester) becomes someone else's
// bill. Rate limiting is not a substitute for authorization, it is the floor
// under it.
//
// WHY THE LOGIC LIVES HERE AND NOT IN proxy.ts: Next's proxy runs as its own
// bundle and is deliberately thin. Keeping tier classification, identity
// extraction, and the in-process fallback here makes them unit-testable
// (vitest already collects lib/**/*.test.ts) and keeps proxy.ts a few lines of
// adapter.
//
// STORAGE. Serverless instances share nothing, so a counter kept in one
// function's memory is invisible to the next request. The shared counter is
// Upstash Redis over its REST API, read from the SAME env vars as
// lib/server/store.ts (KV_REST_API_* or UPSTASH_REDIS_REST_*). The client is
// constructed here rather than imported from store.ts on purpose: store.ts
// also carries an fs-backed local fallback, and dragging `fs`/`os`/`path`
// into the proxy bundle to reach one env lookup is the wrong trade.
//
// FAILURE POLICY (the decision this module is really about):
//
//   1. Redis NOT configured (local dev, a preview without the KV integration)
//      -> fall back to an in-process limiter. Per-instance and therefore
//      approximate, but a missing env var must never 500 the site and must
//      never silently leave money routes unbounded. This is also what makes
//      the limiter demonstrable locally.
//
//   2. Redis configured but failing or slow -> split by tier:
//        - read/poll/expensive routes FAIL OPEN. A Redis outage taking down
//          the dashboard would be a self-inflicted outage far worse than the
//          traffic the limiter is there to shape.
//        - money routes FAIL CLOSED with 503. An unbounded payout, payment,
//          or agent-spend route is worse than a temporarily unavailable one.
//          Money paths in this app report success only when funds actually
//          moved; the same posture applies to letting them run at all.
//
// IDENTITY. The per-IP bucket keys on the platform-set forwarded headers.
// Behind Vercel those are set by the edge and not client-controllable; run
// anywhere without a trusted proxy in front and they are spoofable. That is
// exactly why money routes carry a second, tighter per-address bucket and why
// this module is a floor rather than an authorization boundary.
//
// The per-address bucket charges only a wallet the caller has PROVEN it
// controls. Naming a bucket is choosing whose quota to spend, so an
// unverified address would hand every attacker a way to spend somebody
// else's: wallet addresses are public, and six requests carrying a victim's
// address would lock that victim out of their own payout. See
// verifiedAddressBucket.

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import {
  authenticateWallet,
  readWalletAuthHeaders,
} from "@/lib/server/wallet-auth";

/**
 * Traffic classes. Each /api/* path falls into exactly one, and the class
 * decides both the limits and what happens when the shared counter is down.
 */
export type RouteTier = "read" | "poll" | "expensive" | "money";

export interface TierPolicy {
  /** Requests allowed per window from one client IP. */
  readonly ipLimit: number;
  /** Requests allowed per window for one wallet address, when we can see one. */
  readonly addressLimit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Allow the request when the shared counter itself errors or times out. */
  readonly failOpen: boolean;
}

const MINUTE_MS = 60_000;

/**
 * Limits are set from what the real client actually does, not from a round
 * number. Getting this wrong in the tight direction breaks the product:
 * EvidenceUpload and WearableCheck poll /api/agent/run every 800 ms, which is
 * roughly 75 requests a minute from one honest user, so that route gets its
 * own tier with headroom for two open tabs rather than the money tier.
 */
export const TIER_POLICIES: Record<RouteTier, TierPolicy> = {
  // Cheap server-side reads (agent feed, agent wallet).
  read: {
    ipLimit: 120,
    addressLimit: 60,
    windowMs: MINUTE_MS,
    failOpen: true,
  },
  // The claim run loop. Idempotent, resumable, already spend-capped per claim
  // inside the agent, and polled hard by the browser while a claim is live.
  poll: {
    ipLimit: 180,
    addressLimit: 120,
    windowMs: MINUTE_MS,
    failOpen: true,
  },
  // Costs someone money or latency per call: paid wearable upstream, chain
  // RPC reads. Not a payout, so a Redis outage should not block it.
  expensive: {
    ipLimit: 30,
    addressLimit: 20,
    windowMs: MINUTE_MS,
    failOpen: true,
  },
  // Moves funds, authorizes moving funds, or spends the agent's budget.
  //
  // The per-address bucket is the real control here and it is deliberately
  // severe: six money operations a minute is far more than any honest single
  // user needs. The per-IP bucket is coarser on purpose, because a shared
  // office or mobile NAT puts many unrelated users behind one address and one
  // private payout costs several requests (register, authorization token,
  // payout). Setting the IP bucket to the per-user number would lock out real
  // people long before it inconvenienced an attacker, who can change IP more
  // easily than they can produce a second wallet signature.
  money: {
    ipLimit: 24,
    addressLimit: 6,
    windowMs: MINUTE_MS,
    failOpen: false,
  },
};

/**
 * Exact paths and prefixes per tier. Order matters: the first match wins, so
 * the more specific entries are listed first (`/api/balance/withdraw` is money
 * while the bare `/api/balance` read is only expensive).
 */
const TIER_RULES: ReadonlyArray<{ prefix: string; tier: RouteTier }> = [
  // Money: payouts, withdrawals, on-ramp signing, verdict writes, and the
  // routes that mint an Unlink capability token for a shielded address.
  { prefix: "/api/unlink/", tier: "money" },
  { prefix: "/api/balance/", tier: "money" },
  { prefix: "/api/blink/", tier: "money" },
  { prefix: "/api/evidence/submit", tier: "money" },
  { prefix: "/api/oracle/record", tier: "money" },
  { prefix: "/api/agent/sweep", tier: "money" },
  // Poll: the browser-driven claim run loop.
  { prefix: "/api/agent/run", tier: "poll" },
  // Expensive: paid upstreams and chain reads.
  { prefix: "/api/junction/", tier: "expensive" },
  { prefix: "/api/goals/match", tier: "expensive" },
  { prefix: "/api/balance", tier: "expensive" },
];

/**
 * Map a request path to its traffic class. Anything unrecognised under /api
 * lands in `read`, which is the safe default for a new cheap endpoint; a new
 * money route must be added to TIER_RULES, and the test for this function is
 * the place that failure shows up.
 */
export function classifyPath(pathname: string): RouteTier {
  for (const rule of TIER_RULES) {
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix)) {
      return rule.tier;
    }
  }
  return "read";
}

/**
 * Best-effort client IP.
 *
 * `x-vercel-forwarded-for` and `x-real-ip` are written by the platform edge
 * and cannot be set by the caller, so they are preferred. `x-forwarded-for` is
 * the last resort and its first entry is the client only when a trusted proxy
 * rewrote the header; treat the result as a traffic-shaping key, never as an
 * identity.
 */
export function clientIp(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel !== undefined && vercel !== "") return vercel.split(",")[0].trim();

  const real = headers.get("x-real-ip")?.trim();
  if (real !== undefined && real !== "") return real;

  const forwarded = headers.get("x-forwarded-for")?.trim();
  if (forwarded !== undefined && forwarded !== "") {
    const first = forwarded.split(",")[0].trim();
    if (first !== "") return first;
  }
  return "unknown";
}

/**
 * The wallet the per-address bucket is charged to, or null to bound this
 * request by IP alone.
 *
 * This deliberately requires a VERIFIED signature rather than reading the
 * address out of the query string or a bare header. A rate-limit bucket is a
 * deny mechanism, so whatever names it is an identity an attacker would love
 * to choose. Wallet addresses are public — on chain and in this app's own
 * participant lists — so keying on an unverified one would let anybody spend a
 * stranger's quota: six requests carrying `x-gohealthme-address: <victim>`
 * would exhaust the money tier's per-address bucket and the victim's own
 * correctly signed payout would then be refused by this proxy before it ever
 * reached the route. Charging only a proven address means the only quota a
 * caller can burn is their own.
 *
 * Unsigned requests fall back to the IP bucket, which is what already bounds
 * POST money routes: request bodies are not read here, because consuming the
 * stream in a proxy risks breaking the downstream handler.
 */
export async function verifiedAddressBucket(
  request: Request,
  nowMs: number,
): Promise<string | null> {
  // Fast path: no signature headers at all, so there is nothing to verify and
  // no signature work on the hot path for ordinary reads.
  if (readWalletAuthHeaders(request) === null) return null;

  const auth = await authenticateWallet(request, nowMs);
  return auth.ok ? auth.address.toLowerCase() : null;
}

/** Seconds a client should wait, floored at 1 so `Retry-After: 0` never ships. */
export function retryAfterSeconds(resetMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((resetMs - nowMs) / 1000));
}

export interface LimitOutcome {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Epoch ms at which this bucket refills. */
  readonly resetMs: number;
}

/**
 * Fixed-window counter held in process memory.
 *
 * Used when Redis is not configured. Approximate by construction (each
 * serverless instance counts on its own, and a window boundary lets a burst
 * through), which is fine for its job: keep local development and any
 * single-instance deployment from being completely unbounded without turning
 * a missing env var into a 500.
 */
export class MemoryRateLimiter {
  private readonly counters = new Map<
    string,
    { count: number; resetMs: number }
  >();

  constructor(private readonly maxKeys: number = 10_000) {}

  check(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number,
  ): LimitOutcome {
    this.prune(nowMs);

    const entry = this.counters.get(key);
    if (entry === undefined || entry.resetMs <= nowMs) {
      const resetMs = nowMs + windowMs;
      this.counters.set(key, { count: 1, resetMs });
      return { allowed: true, limit, remaining: limit - 1, resetMs };
    }

    entry.count += 1;
    return {
      allowed: entry.count <= limit,
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetMs: entry.resetMs,
    };
  }

  /** Visible for tests. */
  size(): number {
    return this.counters.size;
  }

  /**
   * Drop expired windows once the map grows past its cap. Bounded memory
   * matters more than perfect accounting here: if dropping expired entries is
   * not enough, the whole map is cleared, which can only ever forgive requests
   * (it never denies one that should have passed).
   */
  private prune(nowMs: number): void {
    if (this.counters.size <= this.maxKeys) return;
    for (const [key, entry] of this.counters) {
      if (entry.resetMs <= nowMs) this.counters.delete(key);
    }
    if (this.counters.size > this.maxKeys) this.counters.clear();
  }
}

// ------------------------------------------------------------ shared counter

/**
 * Never throws. This runs at module load inside the proxy, which sits in front
 * of every /api request, so anything that throws here takes the whole site
 * down. Absent config is the normal local case; malformed config is an
 * operator error that must degrade to the in-process limiter and shout in the
 * logs rather than turn every route into a 500.
 */
function redisClient(): Redis | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || token === undefined || url === "" || token === "") {
    return null;
  }
  try {
    return new Redis({ url, token });
  } catch (err) {
    console.error(
      "[rate-limit] Redis config is present but unusable, falling back to the " +
        "in-process limiter",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// Constructed once at module load. The REST client is connectionless, so this
// is config, not a connection. null when unconfigured -> in-process fallback.
const redis = redisClient();

// One Ratelimit per (tier, bucket) because the limits differ. Built lazily and
// memoised: instances must outlive the request to make the ephemeral cache
// useful across invocations on a warm instance.
const limiters = new Map<string, Ratelimit>();
const ephemeralCache = new Map<string, number>();

function limiterFor(
  tier: RouteTier,
  bucket: "ip" | "addr",
  limit: number,
  windowMs: number,
): Ratelimit {
  const cacheKey = `${tier}:${bucket}`;
  const existing = limiters.get(cacheKey);
  if (existing !== undefined) return existing;

  if (redis === null) {
    throw new Error("limiterFor called without Redis configured");
  }
  const created = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, `${windowMs / 1000} s`),
    prefix: `gohealthme:rl:${cacheKey}`,
    // Analytics costs an extra Redis write per request and nothing in the
    // product reads it.
    analytics: false,
    ephemeralCache,
  });
  limiters.set(cacheKey, created);
  return created;
}

/** Fallback counter, shared across tiers; the key already carries the tier. */
const memoryLimiter = new MemoryRateLimiter();

/** Reject rather than hang when Redis is unreachable, so the tier's failure policy applies. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("rate limit check timed out")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const REDIS_DEADLINE_MS = 1_500;

export type RateLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** 429 when a limit was hit, 503 when a money route failed closed. */
      readonly status: 429 | 503;
      readonly retryAfter: number;
      readonly tier: RouteTier;
      readonly limit?: number;
      readonly remaining?: number;
      readonly resetMs?: number;
    };

interface Bucket {
  readonly kind: "ip" | "addr";
  readonly key: string;
  readonly limit: number;
}

/**
 * Decide whether a request may proceed.
 *
 * Both buckets are checked in parallel and both consume a token even when one
 * of them denies: the attempt happened either way, and letting the cheaper
 * bucket go uncounted would leave a way to burn one bucket for free.
 */
export async function checkRateLimit(
  request: Request,
  nowMs: number = Date.now(),
): Promise<RateLimitDecision> {
  const url = new URL(request.url);
  const tier = classifyPath(url.pathname);
  const policy = TIER_POLICIES[tier];

  const ip = clientIp(request.headers);
  const address = await verifiedAddressBucket(request, nowMs);

  const buckets: Bucket[] = [
    { kind: "ip", key: `${tier}:ip:${ip}`, limit: policy.ipLimit },
  ];
  if (address !== null) {
    buckets.push({
      kind: "addr",
      key: `${tier}:addr:${address}`,
      limit: policy.addressLimit,
    });
  }

  if (redis === null) {
    const outcomes = buckets.map((bucket) =>
      memoryLimiter.check(bucket.key, bucket.limit, policy.windowMs, nowMs),
    );
    return decide(outcomes, tier, nowMs);
  }

  try {
    const outcomes = await Promise.all(
      buckets.map(async (bucket) => {
        const limiter = limiterFor(
          tier,
          bucket.kind,
          bucket.limit,
          policy.windowMs,
        );
        const result = await withDeadline(
          limiter.limit(bucket.key),
          REDIS_DEADLINE_MS,
        );
        return {
          allowed: result.success,
          limit: result.limit,
          remaining: result.remaining,
          resetMs: result.reset,
        };
      }),
    );
    return decide(outcomes, tier, nowMs);
  } catch (err) {
    // Never surface the store's error to the caller; log it and apply the
    // tier's failure policy.
    console.error("[rate-limit] shared counter unavailable", {
      tier,
      path: url.pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    if (policy.failOpen) return { allowed: true };
    return {
      allowed: false,
      status: 503,
      retryAfter: 30,
      tier,
    };
  }
}

function decide(
  outcomes: readonly LimitOutcome[],
  tier: RouteTier,
  nowMs: number,
): RateLimitDecision {
  const denied = outcomes.find((outcome) => !outcome.allowed);
  if (denied === undefined) return { allowed: true };
  return {
    allowed: false,
    status: 429,
    retryAfter: retryAfterSeconds(denied.resetMs, nowMs),
    tier,
    limit: denied.limit,
    remaining: denied.remaining,
    resetMs: denied.resetMs,
  };
}

/**
 * The response for a denied request. The body says nothing about which bucket
 * tripped, which limit applies, or whether the caller was recognised: a
 * generic message plus Retry-After is everything a well-behaved client needs
 * and everything a probing one should get.
 */
export function rateLimitResponse(
  decision: Extract<RateLimitDecision, { allowed: false }>,
): Response {
  const headers = new Headers({
    "retry-after": String(decision.retryAfter),
    "cache-control": "no-store",
  });
  if (decision.limit !== undefined) {
    headers.set("x-ratelimit-limit", String(decision.limit));
    headers.set("x-ratelimit-remaining", String(decision.remaining ?? 0));
  }
  if (decision.resetMs !== undefined) {
    headers.set("x-ratelimit-reset", String(Math.ceil(decision.resetMs / 1000)));
  }

  const message =
    decision.status === 429
      ? "Too many requests"
      : "Service temporarily unavailable";

  return Response.json({ error: message }, { status: decision.status, headers });
}
