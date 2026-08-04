import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  acquireLock,
  addPendingSettlement,
  listDuePendingSettlements,
  releaseLock,
  removePendingSettlement,
  resetLocalCoordinationState,
  withLock,
} from "@/lib/server/agent/lock";

// A fake stands in for @upstash/redis in the Redis-path suite at the bottom of
// this file. Hoisted because vi.mock is hoisted above the imports.
const redisFake = vi.hoisted(() => ({
  set: vi.fn(),
  eval: vi.fn(),
  zadd: vi.fn(),
  zrem: vi.fn(),
  zrange: vi.fn(),
  incrby: vi.fn(),
  expire: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  // A function expression, not an arrow: the module constructs this with `new`.
  Redis: vi.fn(function Redis() {
    return redisFake;
  }),
}));

// The lock is what makes the run loop's "the ledger carries the state" true on
// serverless. Pinned here: mutual exclusion, compare-and-delete release (a
// holder can never free someone else's lock), TTL expiry so a killed lambda
// cannot wedge a claim, release-on-throw, and the pending-settlement queue's
// score ordering.
//
// These run against the process-local fallback (no Redis env in tests), which
// implements the same contract the Redis path does.

beforeEach(() => {
  resetLocalCoordinationState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acquireLock / releaseLock", () => {
  it("gives the lock to one caller and refuses the next", async () => {
    const first = await acquireLock("claim-a", 60_000);
    const second = await acquireLock("claim-a", 60_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("keeps separate names independent", async () => {
    expect(await acquireLock("claim-a", 60_000)).not.toBeNull();
    expect(await acquireLock("claim-b", 60_000)).not.toBeNull();
  });

  it("releases only for the token that holds it", async () => {
    const token = await acquireLock("claim-a", 60_000);
    expect(token).not.toBeNull();

    expect(await releaseLock("claim-a", "not-the-token")).toBe(false);
    expect(await acquireLock("claim-a", 60_000)).toBeNull();

    expect(await releaseLock("claim-a", token as string)).toBe(true);
    expect(await acquireLock("claim-a", 60_000)).not.toBeNull();
  });

  it("expires the lock so a killed run cannot wedge a claim forever", async () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);

    expect(await acquireLock("claim-a", 1_000)).not.toBeNull();
    clock.mockReturnValue(base + 999);
    expect(await acquireLock("claim-a", 1_000)).toBeNull();
    clock.mockReturnValue(base + 1_001);
    expect(await acquireLock("claim-a", 1_000)).not.toBeNull();
  });

  it("rejects a non-positive ttl rather than taking an immortal lock", async () => {
    await expect(acquireLock("claim-a", 0)).rejects.toThrow(/ttlMs/);
  });
});

describe("withLock", () => {
  it("runs the body under the lock and frees it afterwards", async () => {
    const outcome = await withLock("claim-a", 60_000, async () => "done");

    expect(outcome).toEqual({ acquired: true, value: "done" });
    expect(await acquireLock("claim-a", 60_000)).not.toBeNull();
  });

  it("reports not-acquired without running the body when someone else holds it", async () => {
    await acquireLock("claim-a", 60_000);
    const body = vi.fn();

    const outcome = await withLock("claim-a", 60_000, async () => {
      body();
      return "done";
    });

    expect(outcome).toEqual({ acquired: false });
    expect(body).not.toHaveBeenCalled();
  });

  it("frees the lock when the body throws", async () => {
    await expect(
      withLock("claim-a", 60_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await acquireLock("claim-a", 60_000)).not.toBeNull();
  });

  it("serializes two overlapping callers: the loser does no work", async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const worked: string[] = [];

    const first = withLock("claim-a", 60_000, async () => {
      worked.push("first");
      await gate;
      return 1;
    });
    // The first call is inside the lock by the time this runs.
    await Promise.resolve();
    const second = await withLock("claim-a", 60_000, async () => {
      worked.push("second");
      return 2;
    });

    expect(second).toEqual({ acquired: false });
    releaseFirst();
    expect(await first).toEqual({ acquired: true, value: 1 });
    expect(worked).toEqual(["first"]);
  });
});

describe("pending-settlement queue", () => {
  const A = "0x" + "aa".repeat(32);
  const B = "0x" + "bb".repeat(32);

  it("returns only claims due at or before the cutoff, oldest first", async () => {
    await addPendingSettlement(B, 2_000);
    await addPendingSettlement(A, 1_000);

    expect(await listDuePendingSettlements(999, 10)).toEqual([]);
    expect(await listDuePendingSettlements(1_000, 10)).toEqual([A.toLowerCase()]);
    expect(await listDuePendingSettlements(5_000, 10)).toEqual([
      A.toLowerCase(),
      B.toLowerCase(),
    ]);
  });

  it("caps the batch size", async () => {
    await addPendingSettlement(A, 1_000);
    await addPendingSettlement(B, 1_001);

    expect(await listDuePendingSettlements(5_000, 1)).toEqual([A.toLowerCase()]);
  });

  it("re-queueing the same claim moves its due time instead of duplicating it", async () => {
    await addPendingSettlement(A, 1_000);
    await addPendingSettlement(A, 9_000);

    expect(await listDuePendingSettlements(5_000, 10)).toEqual([]);
    expect(await listDuePendingSettlements(9_000, 10)).toEqual([A.toLowerCase()]);
  });

  it("drops a claim once it is settled", async () => {
    await addPendingSettlement(A, 1_000);
    await removePendingSettlement(A);

    expect(await listDuePendingSettlements(5_000, 10)).toEqual([]);
  });
});

// The suites above run on the process-local fallback, which is all a local dev
// server or a vitest run ever touches. Production is the other path, and it is
// the one that actually has to be atomic - so pin the exact Redis commands.
describe("the Redis path", () => {
  async function loadWithRedis() {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "token-1");
    vi.resetModules();
    return import("@/lib/server/agent/lock");
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const fn of Object.values(redisFake)) fn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("takes the lock with SET NX PX - the atomic form, not read-then-write", async () => {
    redisFake.set.mockResolvedValue("OK");
    const { acquireLock } = await loadWithRedis();

    const token = await acquireLock("agent:run:0xabc", 75_000);

    expect(token).not.toBeNull();
    expect(redisFake.set).toHaveBeenCalledWith(
      "gohealthme:lock:agent:run:0xabc",
      token,
      { nx: true, px: 75_000 },
    );
  });

  it("reports not-acquired when SET NX finds the key held", async () => {
    redisFake.set.mockResolvedValue(null);
    const { acquireLock } = await loadWithRedis();

    expect(await acquireLock("agent:run:0xabc", 75_000)).toBeNull();
  });

  it("fails closed when Redis cannot answer: never hand out a lock on error", async () => {
    redisFake.set.mockRejectedValue(new Error("upstash 503"));
    const { acquireLock } = await loadWithRedis();

    // Stalling a claim until the next poll is recoverable; a double spend is
    // not. The caller treats null as "a sibling owns this".
    expect(await acquireLock("agent:run:0xabc", 75_000)).toBeNull();
  });

  it("releases by compare-and-delete so an expired holder cannot free the new owner", async () => {
    redisFake.eval.mockResolvedValue(1);
    const { releaseLock } = await loadWithRedis();

    expect(await releaseLock("agent:run:0xabc", "token-9")).toBe(true);
    const [script, keys, args] = redisFake.eval.mock.calls[0];
    expect(script).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
    expect(script).toContain('redis.call("del", KEYS[1])');
    expect(keys).toEqual(["gohealthme:lock:agent:run:0xabc"]);
    expect(args).toEqual(["token-9"]);

    redisFake.eval.mockResolvedValue(0);
    expect(await releaseLock("agent:run:0xabc", "stale")).toBe(false);
  });

  it("keeps the pending queue as a sorted set scored by the settleable moment", async () => {
    redisFake.zadd.mockResolvedValue(1);
    redisFake.zrem.mockResolvedValue(1);
    redisFake.zrange.mockResolvedValue(["0xaa"]);
    const { addPendingSettlement, listDuePendingSettlements, removePendingSettlement } =
      await loadWithRedis();

    await addPendingSettlement("0xAA", 1_700_000_000);
    expect(redisFake.zadd).toHaveBeenCalledWith(
      "gohealthme:agent-pending-settlement",
      { score: 1_700_000_000, member: "0xaa" },
    );

    expect(await listDuePendingSettlements(1_700_000_500, 50)).toEqual(["0xaa"]);
    expect(redisFake.zrange).toHaveBeenCalledWith(
      "gohealthme:agent-pending-settlement",
      0,
      1_700_000_500,
      { byScore: true, offset: 0, count: 50 },
    );

    await removePendingSettlement("0xAA");
    expect(redisFake.zrem).toHaveBeenCalledWith(
      "gohealthme:agent-pending-settlement",
      "0xaa",
    );
  });

  it("never lets a queue failure break settlement", async () => {
    redisFake.zadd.mockRejectedValue(new Error("upstash 503"));
    redisFake.zrange.mockRejectedValue(new Error("upstash 503"));
    const { addPendingSettlement, listDuePendingSettlements } =
      await loadWithRedis();

    // The queue is an index that makes the sweep cheap, never the authority on
    // whether a claim is paid. Losing it costs one bounded index scan.
    await expect(addPendingSettlement("0xaa", 1)).resolves.toBeUndefined();
    await expect(listDuePendingSettlements(2, 10)).resolves.toEqual([]);
  });
});
