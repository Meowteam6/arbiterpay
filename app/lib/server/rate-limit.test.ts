// Covers the parts of the limiter that decide who gets throttled and how hard.
// The Redis-backed path is not exercised here (it needs a live Upstash
// instance); what is tested is everything that would silently mis-tier a
// money route, mis-read a client IP, or let the in-process fallback count
// wrong — the failures that would make the limiter look present and be absent.
import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  MemoryRateLimiter,
  TIER_POLICIES,
  classifyPath,
  clientIp,
  rateLimitResponse,
  retryAfterSeconds,
  verifiedAddressBucket,
} from "@/lib/server/rate-limit";

describe("classifyPath", () => {
  it("puts payout, capability, withdrawal, and on-ramp routes on the money tier", () => {
    expect(classifyPath("/api/unlink/payout")).toBe("money");
    expect(classifyPath("/api/unlink/authorization-token")).toBe("money");
    expect(classifyPath("/api/unlink/register")).toBe("money");
    expect(classifyPath("/api/balance/withdraw")).toBe("money");
    expect(classifyPath("/api/balance/confirm")).toBe("money");
    expect(classifyPath("/api/blink/topup")).toBe("money");
    expect(classifyPath("/api/blink/sign")).toBe("money");
    expect(classifyPath("/api/evidence/submit")).toBe("money");
    expect(classifyPath("/api/oracle/record")).toBe("money");
    expect(classifyPath("/api/agent/sweep")).toBe("money");
  });

  it("keeps the bare balance read off the money tier", () => {
    // GET /api/balance is a chain read; only its sub-routes move funds.
    expect(classifyPath("/api/balance")).toBe("expensive");
  });

  it("gives the browser-polled claim loop its own tier", () => {
    // EvidenceUpload and WearableCheck poll this every 800 ms. On the money
    // tier one honest user would throttle themselves within seconds.
    expect(classifyPath("/api/agent/run/0xabc")).toBe("poll");
  });

  it("treats paid upstreams and chain reads as expensive", () => {
    expect(classifyPath("/api/junction/data")).toBe("expensive");
    expect(classifyPath("/api/junction/progress")).toBe("expensive");
    expect(classifyPath("/api/junction/link")).toBe("expensive");
    expect(classifyPath("/api/goals/match")).toBe("expensive");
  });

  it("defaults unknown routes to the read tier", () => {
    expect(classifyPath("/api/agent/feed")).toBe("read");
    expect(classifyPath("/api/agent/wallet")).toBe("read");
    expect(classifyPath("/api/something-new")).toBe("read");
  });
});

describe("TIER_POLICIES", () => {
  it("fails closed only on the money tier", () => {
    expect(TIER_POLICIES.money.failOpen).toBe(false);
    expect(TIER_POLICIES.read.failOpen).toBe(true);
    expect(TIER_POLICIES.poll.failOpen).toBe(true);
    expect(TIER_POLICIES.expensive.failOpen).toBe(true);
  });

  it("limits money harder than reads", () => {
    expect(TIER_POLICIES.money.ipLimit).toBeLessThan(TIER_POLICIES.read.ipLimit);
    expect(TIER_POLICIES.money.ipLimit).toBeLessThan(
      TIER_POLICIES.expensive.ipLimit,
    );
  });

  it("keeps the tightest per-user bucket on the money tier", () => {
    // The per-address bucket, not the per-IP one, is what bounds a single
    // wallet. It must be the strictest number in the table.
    for (const [tier, policy] of Object.entries(TIER_POLICIES)) {
      if (tier === "money") continue;
      expect(TIER_POLICIES.money.addressLimit).toBeLessThan(
        policy.addressLimit,
      );
    }
  });

  it("keeps every per-address bucket at or below its per-IP bucket", () => {
    for (const policy of Object.values(TIER_POLICIES)) {
      expect(policy.addressLimit).toBeLessThanOrEqual(policy.ipLimit);
    }
  });

  it("leaves the claim poll loop room for two open tabs", () => {
    // 800 ms between polls is 75 requests a minute per tab.
    const perTabPerMinute = 75;
    expect(TIER_POLICIES.poll.ipLimit).toBeGreaterThanOrEqual(
      perTabPerMinute * 2,
    );
  });
});

describe("clientIp", () => {
  it("prefers the platform-set header over the client-settable one", () => {
    const headers = new Headers({
      "x-vercel-forwarded-for": "3.3.3.3",
      "x-real-ip": "2.2.2.2",
      "x-forwarded-for": "1.1.1.1",
    });
    expect(clientIp(headers)).toBe("3.3.3.3");
  });

  it("falls back to x-real-ip, then to x-forwarded-for", () => {
    expect(
      clientIp(new Headers({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "1.1.1.1" })),
    ).toBe("2.2.2.2");
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1" }))).toBe("1.1.1.1");
  });

  it("takes the first entry of a forwarded chain", () => {
    expect(
      clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 10.0.0.1, 10.0.0.2" })),
    ).toBe("1.1.1.1");
  });

  it("returns a stable key rather than throwing when nothing identifies the caller", () => {
    // All such callers share one bucket, which is the conservative choice.
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": "  " }))).toBe("unknown");
  });
});

describe("verifiedAddressBucket", () => {
  const NOW = Date.parse("2026-08-04T12:00:00.000Z");
  const VICTIM = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );

  async function signedHeaders(
    timestamp: string,
  ): Promise<Record<string, string>> {
    const signature = await VICTIM.signMessage({
      message: `GoHealthMe: prove control of ${VICTIM.address} at ${timestamp}`,
    });
    return {
      "x-gohealthme-address": VICTIM.address,
      "x-gohealthme-timestamp": timestamp,
      "x-gohealthme-signature": signature,
    };
  }

  it("charges a wallet that proved control of itself", async () => {
    const timestamp = new Date(NOW).toISOString();
    const request = new Request("https://x/api/unlink/payout", {
      headers: await signedHeaders(timestamp),
    });

    expect(await verifiedAddressBucket(request, NOW)).toBe(
      VICTIM.address.toLowerCase(),
    );
  });

  it("refuses to charge an address named without a signature", async () => {
    // The denial attack: knowing a public wallet address must not let anyone
    // spend that wallet's quota and lock its owner out of their own payout.
    const request = new Request("https://x/api/unlink/register", {
      headers: { "x-gohealthme-address": VICTIM.address },
    });

    expect(await verifiedAddressBucket(request, NOW)).toBeNull();
  });

  it("refuses an address named with a forged signature", async () => {
    const request = new Request("https://x/api/unlink/register", {
      headers: {
        "x-gohealthme-address": VICTIM.address,
        "x-gohealthme-timestamp": new Date(NOW).toISOString(),
        "x-gohealthme-signature": `0x${"11".repeat(65)}`,
      },
    });

    expect(await verifiedAddressBucket(request, NOW)).toBeNull();
  });

  it("refuses an expired signature, so a captured header set cannot be reused forever", async () => {
    const stale = new Date(NOW - 11 * 60 * 1000).toISOString();
    const request = new Request("https://x/api/unlink/payout", {
      headers: await signedHeaders(stale),
    });

    expect(await verifiedAddressBucket(request, NOW)).toBeNull();
  });

  it("ignores the query string entirely", async () => {
    // ?address= is caller-supplied and unproven; it must never name a bucket.
    const request = new Request(
      `https://x/api/junction/data?address=${VICTIM.address}`,
    );

    expect(await verifiedAddressBucket(request, NOW)).toBeNull();
  });

  it("returns null for an ordinary unsigned read", async () => {
    expect(
      await verifiedAddressBucket(new Request("https://x/api/agent/feed"), NOW),
    ).toBeNull();
  });
});

describe("retryAfterSeconds", () => {
  it("rounds up so a client never retries before the window resets", () => {
    expect(retryAfterSeconds(10_400, 10_000)).toBe(1);
    expect(retryAfterSeconds(13_100, 10_000)).toBe(4);
  });

  it("never advertises zero", () => {
    expect(retryAfterSeconds(10_000, 10_000)).toBe(1);
    expect(retryAfterSeconds(9_000, 10_000)).toBe(1);
  });
});

describe("MemoryRateLimiter", () => {
  it("allows exactly the limit and denies the next request", () => {
    const limiter = new MemoryRateLimiter();
    const now = 1_000;
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check("k", 3, 60_000, now).allowed).toBe(true);
    }
    expect(limiter.check("k", 3, 60_000, now).allowed).toBe(false);
  });

  it("counts down remaining and stops at zero", () => {
    const limiter = new MemoryRateLimiter();
    expect(limiter.check("k", 2, 60_000, 0).remaining).toBe(1);
    expect(limiter.check("k", 2, 60_000, 0).remaining).toBe(0);
    expect(limiter.check("k", 2, 60_000, 0).remaining).toBe(0);
  });

  it("reports a reset the caller can wait on", () => {
    const limiter = new MemoryRateLimiter();
    const outcome = limiter.check("k", 1, 60_000, 1_000);
    expect(outcome.resetMs).toBe(61_000);
    expect(retryAfterSeconds(outcome.resetMs, 1_000)).toBe(60);
  });

  it("starts a fresh window once the old one expires", () => {
    const limiter = new MemoryRateLimiter();
    expect(limiter.check("k", 1, 60_000, 0).allowed).toBe(true);
    expect(limiter.check("k", 1, 60_000, 30_000).allowed).toBe(false);
    expect(limiter.check("k", 1, 60_000, 60_001).allowed).toBe(true);
  });

  it("keeps buckets independent", () => {
    const limiter = new MemoryRateLimiter();
    expect(limiter.check("a", 1, 60_000, 0).allowed).toBe(true);
    expect(limiter.check("a", 1, 60_000, 0).allowed).toBe(false);
    expect(limiter.check("b", 1, 60_000, 0).allowed).toBe(true);
  });

  it("bounds its own memory instead of growing without limit", () => {
    const limiter = new MemoryRateLimiter(10);
    for (let i = 0; i < 200; i += 1) {
      limiter.check(`k${i}`, 5, 60_000, 0);
    }
    expect(limiter.size()).toBeLessThanOrEqual(20);
  });
});

describe("rateLimitResponse", () => {
  it("answers 429 with Retry-After and nothing about which bucket tripped", async () => {
    const response = rateLimitResponse({
      allowed: false,
      status: 429,
      retryAfter: 42,
      tier: "money",
      limit: 12,
      remaining: 0,
      resetMs: 61_000,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("x-ratelimit-limit")).toBe("12");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "Too many requests" });
    // The tier is an internal classification and must not leak.
    expect(JSON.stringify(body)).not.toContain("money");
  });

  it("answers 503 with Retry-After when a money route fails closed", async () => {
    const response = rateLimitResponse({
      allowed: false,
      status: 503,
      retryAfter: 30,
      tier: "money",
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({
      error: "Service temporarily unavailable",
    });
  });
});
