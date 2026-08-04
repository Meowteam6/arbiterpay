import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";

// In-memory stand-in for @upstash/redis so we can exercise the Redis branch of
// store.ts without a live instance. It mirrors the semantics store.ts relies
// on, including the client's own serialization rules (strings, numbers and
// booleans go over the wire as-is; everything else is JSON).
//
// Each command yields once before its body and then runs to completion without
// awaiting. That is a faithful model of Redis: concurrent callers interleave
// between commands, never inside one. It is also what gives the concurrency
// tests teeth - a read-modify-write implementation loses writes against this
// fake exactly as it does against the real thing.

type Entry =
  | { type: "string"; value: unknown; expiresAt: number | null }
  | { type: "list"; value: unknown[] }
  | { type: "hash"; value: Map<string, number> }
  | { type: "set"; value: Set<string> }
  | { type: "zset"; value: Map<string, number> };

const backing = new Map<string, Entry>();

// Models the round trip. Every command yields once before its body runs, so
// concurrent callers of store.ts genuinely interleave between commands - which
// is what makes the concurrency tests below fail against a read-modify-write
// implementation instead of passing trivially. Each body itself runs without
// awaiting, mirroring Redis executing one command at a time.
function yieldToPeers(): Promise<void> {
  return Promise.resolve();
}

function serialize(value: unknown): unknown {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    default:
      return JSON.stringify(value);
  }
}

function deserialize(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "number" && String(parsed) !== value) return value;
    return parsed;
  } catch {
    return value;
  }
}

function live(key: string): Entry | undefined {
  const entry = backing.get(key);
  if (entry === undefined) return undefined;
  if (
    entry.type === "string" &&
    entry.expiresAt !== null &&
    entry.expiresAt <= Date.now()
  ) {
    backing.delete(key);
    return undefined;
  }
  return entry;
}

class FakeRedis {
  async get<T>(key: string): Promise<T | null> {
    await yieldToPeers();
    const entry = live(key);
    if (entry === undefined || entry.type !== "string") return null;
    return (deserialize(entry.value) as T) ?? null;
  }
  async set<T>(
    key: string,
    value: T,
    opts?: { nx?: true; px?: number },
  ): Promise<"OK" | null> {
    await yieldToPeers();
    if (opts?.nx === true && live(key) !== undefined) return null;
    backing.set(key, {
      type: "string",
      value: serialize(value),
      expiresAt: opts?.px === undefined ? null : Date.now() + opts.px,
    });
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    await yieldToPeers();
    let removed = 0;
    for (const key of keys) if (backing.delete(key)) removed += 1;
    return removed;
  }
  async exists(...keys: string[]): Promise<number> {
    await yieldToPeers();
    return keys.filter((key) => live(key) !== undefined).length;
  }
  async rpush<T>(key: string, ...elements: T[]): Promise<number> {
    await yieldToPeers();
    const entry = live(key);
    const list = entry?.type === "list" ? entry.value : [];
    list.push(...elements.map(serialize));
    backing.set(key, { type: "list", value: list });
    return list.length;
  }
  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    await yieldToPeers();
    const entry = live(key);
    if (entry === undefined || entry.type !== "list") return [];
    const end = stop === -1 ? entry.value.length : stop + 1;
    return entry.value.slice(start, end).map(deserialize) as T[];
  }
  async hincrby(key: string, field: string, delta: number): Promise<number> {
    await yieldToPeers();
    const entry = live(key);
    const hash = entry?.type === "hash" ? entry.value : new Map<string, number>();
    const next = (hash.get(field) ?? 0) + delta;
    hash.set(field, next);
    backing.set(key, { type: "hash", value: hash });
    return next;
  }
  async hget<T>(key: string, field: string): Promise<T | null> {
    await yieldToPeers();
    const entry = live(key);
    if (entry === undefined || entry.type !== "hash") return null;
    const value = entry.value.get(field);
    return value === undefined ? null : (value as T);
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    await yieldToPeers();
    const entry = live(key);
    const set = entry?.type === "set" ? entry.value : new Set<string>();
    let added = 0;
    for (const member of members) {
      if (set.has(member)) continue;
      set.add(member);
      added += 1;
    }
    backing.set(key, { type: "set", value: set });
    return added;
  }
  async srem(key: string, ...members: string[]): Promise<number> {
    await yieldToPeers();
    const entry = live(key);
    if (entry === undefined || entry.type !== "set") return 0;
    let removed = 0;
    for (const member of members) if (entry.value.delete(member)) removed += 1;
    return removed;
  }
  async zadd(
    key: string,
    arg1: { nx?: true } | { score: number; member: string },
    ...rest: { score: number; member: string }[]
  ): Promise<number | null> {
    await yieldToPeers();
    const nx = "nx" in arg1 && arg1.nx === true;
    const pairs = "score" in arg1 ? [arg1, ...rest] : rest;
    const entry = live(key);
    const zset = entry?.type === "zset" ? entry.value : new Map<string, number>();
    let added = 0;
    for (const { score, member } of pairs) {
      if (nx && zset.has(member)) continue;
      if (!zset.has(member)) added += 1;
      zset.set(member, score);
    }
    backing.set(key, { type: "zset", value: zset });
    return added;
  }
  async zrem(key: string, ...members: string[]): Promise<number> {
    await yieldToPeers();
    const entry = live(key);
    if (entry === undefined || entry.type !== "zset") return 0;
    let removed = 0;
    for (const member of members) if (entry.value.delete(member)) removed += 1;
    return removed;
  }
  async zrange<T>(
    key: string,
    start: number,
    stop: number,
    opts?: { rev?: boolean; withScores?: boolean },
  ): Promise<T> {
    await yieldToPeers();
    const entry = live(key);
    if (entry === undefined || entry.type !== "zset") return [] as unknown as T;
    const sorted = [...entry.value.entries()].sort((a, b) =>
      opts?.rev === true
        ? b[1] - a[1] || (a[0] < b[0] ? 1 : -1)
        : a[1] - b[1] || (a[0] < b[0] ? -1 : 1),
    );
    const end = stop === -1 ? sorted.length : stop + 1;
    const window = sorted.slice(start, end);
    const flat = opts?.withScores === true
      ? window.flatMap(([member, score]) => [member, score])
      : window.map(([member]) => member);
    return flat as unknown as T;
  }

  // Only the two scripts store.ts ships are understood; anything else is a
  // test-authoring mistake and should be loud. The bodies run to completion
  // with no await, mirroring the fact that Redis runs a script atomically.
  async eval<TArgs extends unknown[], TData>(
    script: string,
    keys: string[],
    args: TArgs,
  ): Promise<TData> {
    await yieldToPeers();

    if (script.includes("HINCRBY")) {
      const [field, ref, deltaRaw, requireAvailable] = args as unknown as [
        string,
        string,
        string,
        string,
      ];
      const delta = Number(deltaRaw);
      const counter = live(keys[0]);
      const hash =
        counter?.type === "hash" ? counter.value : new Map<string, number>();
      const current = hash.get(field) ?? 0;

      const refsEntry = live(keys[1]);
      const refs = refsEntry?.type === "set" ? refsEntry.value : new Set<string>();
      backing.set(keys[1], { type: "set", value: refs });
      if (refs.has(ref)) return [0, current] as TData;
      refs.add(ref);

      if (requireAvailable === "1" && current + delta < 0) {
        refs.delete(ref);
        return [-1, current] as TData;
      }

      const next = current + delta;
      hash.set(field, next);
      backing.set(keys[0], { type: "hash", value: hash });
      return [1, next] as TData;
    }

    if (script.includes("DEL")) {
      const entry = live(keys[0]);
      if (entry?.type === "string" && entry.value === args[0]) {
        backing.delete(keys[0]);
        return 1 as TData;
      }
      return 0 as TData;
    }

    throw new Error(`FakeRedis: unsupported script ${script}`);
  }
}
vi.mock("@upstash/redis", () => ({ Redis: FakeRedis }));

// store.ts picks its backend at module load from env, so set Redis env BEFORE
// importing it and import fresh inside the test.
async function loadStoreWithRedis() {
  vi.stubEnv("KV_REST_API_URL", "https://fake.upstash.io");
  vi.stubEnv("KV_REST_API_TOKEN", "fake-token");
  vi.resetModules();
  return import("@/lib/server/store");
}

// The file fallback, pinned to a fresh temp dir so nothing leaks between tests.
async function loadStoreWithFiles() {
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("KV_REST_API_TOKEN", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("DATA_DIR", mkdtempSync(path.join(os.tmpdir(), "store-test-")));
  vi.resetModules();
  return import("@/lib/server/store");
}

type Store = Awaited<ReturnType<typeof loadStoreWithRedis>>;

const backends: [string, () => Promise<Store>][] = [
  ["redis", loadStoreWithRedis],
  ["files", loadStoreWithFiles],
];

beforeEach(() => {
  backing.clear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("store (Redis branch)", () => {
  it("returns the fallback when the key is absent", async () => {
    const { readJson } = await loadStoreWithRedis();
    expect(await readJson("missing.json", { a: 1 })).toEqual({ a: 1 });
  });

  it("round-trips a value through Redis under a namespaced key", async () => {
    const { readJson, writeJson } = await loadStoreWithRedis();
    await writeJson("verifications.json", { "0xabc": { "1": "ok" } });
    expect(await readJson("verifications.json", {})).toEqual({
      "0xabc": { "1": "ok" },
    });
    // Key is namespaced so it can't collide with other projects' data.
    expect(backing.has("gohealthme:verifications.json")).toBe(true);
  });
});

describe("store production guard", () => {
  it("refuses to boot in production without Redis instead of using tmpdir", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    await expect(import("@/lib/server/store")).rejects.toThrow(
      /Persistent store is not configured/,
    );
  });

  it("refuses to boot on Vercel without Redis", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("VERCEL", "1");
    vi.resetModules();
    await expect(import("@/lib/server/store")).rejects.toThrow(
      /Persistent store is not configured/,
    );
  });

  it("still builds without Redis, where no user data is touched", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATA_DIR", mkdtempSync(path.join(os.tmpdir(), "store-build-")));
    vi.resetModules();
    const store = await import("@/lib/server/store");
    expect(store.isRedisBacked()).toBe(false);
  });

  it("boots in production when Redis is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = await loadStoreWithRedis();
    expect(store.isRedisBacked()).toBe(true);
  });
});

describe.each(backends)("store primitives (%s backend)", (_name, load) => {
  it("appends a list without losing concurrent writers", async () => {
    const { appendJson, readJsonList } = await load();
    const total = 20;

    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        appendJson("ledger.jsonl", { seq: i }),
      ),
    );

    const entries = await readJsonList<{ seq: number }>("ledger.jsonl");
    expect(entries).toHaveLength(total);
    expect(new Set(entries.map((e) => e.seq)).size).toBe(total);
  });

  it("returns an empty list for an absent key", async () => {
    const { readJsonList } = await load();
    expect(await readJsonList("nothing.jsonl")).toEqual([]);
  });

  it("indexes sorted-set members once and reads them newest first", async () => {
    const { zaddNx, zrevrange, zrem } = await load();

    expect(await zaddNx("index", "goal-a", 100)).toBe(true);
    expect(await zaddNx("index", "goal-b", 200)).toBe(true);
    // Idempotent by member: a repeat keeps the original score.
    expect(await zaddNx("index", "goal-a", 999)).toBe(false);

    expect(await zrevrange("index", 10)).toEqual([
      { member: "goal-b", score: 200 },
      { member: "goal-a", score: 100 },
    ]);
    expect(await zrevrange("index", 1)).toEqual([
      { member: "goal-b", score: 200 },
    ]);

    await zrem("index", "goal-b");
    expect(await zrevrange("index", 10)).toEqual([
      { member: "goal-a", score: 100 },
    ]);
  });

  it("keeps every concurrent sorted-set member", async () => {
    const { zaddNx, zrevrange } = await load();
    const total = 20;

    await Promise.all(
      Array.from({ length: total }, (_, i) => zaddNx("index", `goal-${i}`, i)),
    );

    expect(await zrevrange("index", total)).toHaveLength(total);
  });

  it("hands a setNx key to exactly one of many concurrent callers", async () => {
    const { setNx, existsKey, deleteKey } = await load();

    expect(await existsKey("claim:x")).toBe(false);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => setNx("claim:x", "taken")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await existsKey("claim:x")).toBe(true);

    await deleteKey("claim:x");
    expect(await existsKey("claim:x")).toBe(false);
    expect(await setNx("claim:x", "taken")).toBe(true);
  });

  it("expires a setNx key with a ttl", async () => {
    vi.useFakeTimers();
    try {
      const { setNx, existsKey } = await load();
      expect(await setNx("lease", "held", 1_000)).toBe(true);
      expect(await setNx("lease", "held", 1_000)).toBe(false);
      vi.advanceTimersByTime(1_500);
      expect(await existsKey("lease")).toBe(false);
      expect(await setNx("lease", "held", 1_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loses no concurrent counter increments", async () => {
    const { hincrby, hgetInt } = await load();
    const total = 20;

    await Promise.all(
      Array.from({ length: total }, () => hincrby("balance:0xa", "uusdc", 5)),
    );

    expect(await hgetInt("balance:0xa", "uusdc")).toBe(total * 5);
    expect(await hgetInt("balance:0xb", "uusdc")).toBe(0);
  });

  it("applies a counter delta exactly once per ref", async () => {
    const { applyCounterDelta, hgetInt } = await load();
    const base = {
      counterKey: "balance:0xa",
      field: "uusdc",
      refsKey: "applied:0xa",
      delta: 100,
      requireAvailable: false,
    };

    expect(await applyCounterDelta({ ...base, ref: "tx-1" })).toEqual({
      status: "applied",
      value: 100,
    });
    // Replaying the ref must not move the counter again.
    expect(await applyCounterDelta({ ...base, ref: "tx-1" })).toEqual({
      status: "duplicate",
      value: 100,
    });
    expect(await hgetInt("balance:0xa", "uusdc")).toBe(100);
  });

  it("never lets concurrent debits overdraw a counter", async () => {
    const { applyCounterDelta, hgetInt } = await load();
    await applyCounterDelta({
      counterKey: "balance:0xa",
      field: "uusdc",
      refsKey: "applied:0xa",
      ref: "topup",
      delta: 100,
      requireAvailable: false,
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        applyCounterDelta({
          counterKey: "balance:0xa",
          field: "uusdc",
          refsKey: "applied:0xa",
          ref: `spend-${i}`,
          delta: -10,
          requireAvailable: true,
        }),
      ),
    );

    expect(results.filter((r) => r.status === "applied")).toHaveLength(10);
    expect(results.filter((r) => r.status === "insufficient")).toHaveLength(10);
    expect(await hgetInt("balance:0xa", "uusdc")).toBe(0);
  });

  it("releases the ref when a debit is refused so a retry can succeed", async () => {
    const { applyCounterDelta, hgetInt } = await load();
    const debit = {
      counterKey: "balance:0xa",
      field: "uusdc",
      refsKey: "applied:0xa",
      ref: "spend-1",
      delta: -50,
      requireAvailable: true,
    };

    expect((await applyCounterDelta(debit)).status).toBe("insufficient");
    await applyCounterDelta({
      counterKey: "balance:0xa",
      field: "uusdc",
      refsKey: "applied:0xa",
      ref: "topup",
      delta: 50,
      requireAvailable: false,
    });
    expect((await applyCounterDelta(debit)).status).toBe("applied");
    expect(await hgetInt("balance:0xa", "uusdc")).toBe(0);
  });

  it("adds a set member exactly once across concurrent callers", async () => {
    const { sadd, srem } = await load();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => sadd("applied:0xa", "tx-1")),
    );
    expect(results.filter((added) => added === 1)).toHaveLength(1);

    await srem("applied:0xa", "tx-1");
    expect(await sadd("applied:0xa", "tx-1")).toBe(1);
    expect(await sadd("applied:0xa", "tx-2", "tx-3")).toBe(2);
  });

  it("gives a lock to one holder and releases only for that token", async () => {
    const { acquireLock, releaseLock } = await load();

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => acquireLock("pool-7", 5_000)),
    );
    const held = tokens.filter((token) => token !== null);
    expect(held).toHaveLength(1);

    // A stale holder must not release somebody else's lock.
    await releaseLock("pool-7", "not-my-token");
    expect(await acquireLock("pool-7", 5_000)).toBeNull();

    await releaseLock("pool-7", held[0] as string);
    expect(await acquireLock("pool-7", 5_000)).not.toBeNull();
  });

  it("serialises withLock callers and releases on throw", async () => {
    const { withLock, LockUnavailableError } = await load();

    let running = 0;
    let maxConcurrent = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withLock("claim-1", 2_000, async () => {
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          order.push(i);
          running -= 1;
        }),
      ),
    );

    expect(maxConcurrent).toBe(1);
    expect(order).toHaveLength(8);

    await expect(
      withLock("claim-1", 2_000, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    // The lock was released despite the throw.
    await expect(
      withLock("claim-1", 2_000, () => Promise.resolve("ok")),
    ).resolves.toBe("ok");

    expect(LockUnavailableError).toBeDefined();
  });

  it("fails loudly when a lock cannot be acquired in time", async () => {
    const { acquireLock, withLock, LockUnavailableError } = await load();

    expect(await acquireLock("busy", 5_000)).not.toBeNull();
    await expect(
      withLock("busy", 5_000, () => Promise.resolve("never"), 60),
    ).rejects.toBeInstanceOf(LockUnavailableError);
  });
});
