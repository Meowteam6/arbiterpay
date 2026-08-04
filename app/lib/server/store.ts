// Shared persistence for the claims store, the balance ledger and SPOTTER's
// agent ledger.
//
// PRODUCTION (serverless): Upstash Redis over its REST API - a shared,
// persistent store reachable from every function instance. This is required
// because serverless invocations do not share a filesystem: a record written
// on one instance is invisible to a route handled by another, so any
// cross-request state kept in files always breaks in prod.
//
// LOCAL / TESTS (no Redis env): falls back to JSON files under os.tmpdir()
// (or DATA_DIR). A single long-lived process shares one dir, so the file
// store behaves correctly there. Tests pin DATA_DIR to <cwd>/.data.
//
// WHY THE PRIMITIVES BELOW EXIST
// readJson + writeJson is read-modify-write over a whole JSON blob. Vercel
// runs many lambda instances at once, so two writers that read the same blob
// and write it back silently drop each other's work. Every money bug this
// module has produced traces to that shape: a lost agent-ledger entry strands
// a claim, a lost index entry hides it from the settlement sweep, a lost
// balance credit eats a real top-up, and a read-then-check on a claim flag
// lets two requests pay the same reward. The append / set / hash / sorted-set
// / lock helpers push each mutation into a single Redis command, which the
// server applies atomically, so concurrent callers interleave instead of
// overwriting. readJson and writeJson stay for callers that genuinely own a
// whole document.
//
// The file fallback implements the same semantics for one process: mutations
// run through a per-file promise queue and locks live in a process-local Map.
// That is enough for local dev and the test suite. It is not enough for
// serverless, which is why a production boot without Redis now throws instead
// of silently writing to a per-invocation tmpdir nobody ever reads back.
//
// Configure Redis via the Vercel Upstash/KV Marketplace integration, which
// provides KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/
// UPSTASH_REDIS_REST_TOKEN). Either naming works.

import { promises as fs } from "fs";
import { createHash, randomUUID } from "crypto";
import os from "os";
import path from "path";
import { Redis } from "@upstash/redis";

const DATA_DIR =
  process.env.DATA_DIR ?? path.join(os.tmpdir(), "gohealthme-data");

// Namespacing the keys keeps this app's data distinct if the Redis instance
// is ever shared with another project.
const KEY_PREFIX = "gohealthme:";

function redisClient(): Redis | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || token === undefined || url === "" || token === "") {
    return null;
  }
  return new Redis({ url, token });
}

// Created once at module load; the REST client is connectionless, so this is
// just config. null when no Redis env is present (local/tests) -> file store.
const redis = redisClient();

// A serverless deployment without Redis writes to a per-invocation tmpdir:
// every write is invisible to the next request, and nothing raises. Refuse to
// boot rather than lose user money quietly.
//
// The production build is exempt: a build machine legitimately has no runtime
// secrets, and no build step reads or writes user data. On Vercel the runtime
// env is present at build time anyway, so the exemption never hides a
// misconfigured deployment - the first lambda import still throws.
const IS_PRODUCTION_BUILD =
  process.env.NEXT_PHASE === "phase-production-build";
const IS_SERVERLESS =
  process.env.NODE_ENV === "production" || process.env.VERCEL === "1";

if (redis === null && IS_SERVERLESS && !IS_PRODUCTION_BUILD) {
  throw new Error(
    "Persistent store is not configured. Set KV_REST_API_URL and " +
      "KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL and " +
      "UPSTASH_REDIS_REST_TOKEN). Refusing to fall back to the local file " +
      "store in production, where every write is silently lost.",
  );
}

/** True when this process is backed by Redis rather than the file fallback. */
export function isRedisBacked(): boolean {
  return redis !== null;
}

// ---------------------------------------------------------------------------
// File fallback plumbing
// ---------------------------------------------------------------------------

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/** Redis key names double as file names locally; keep them path-safe. */
function filePath(file: string): string {
  const safe = file.replace(/[^A-Za-z0-9._-]/g, "_");
  // Distinct keys must not collapse onto one file: "claim:a" and "claim_a"
  // both sanitise to "claim_a", which would make one claim shadow another.
  // Only rewritten names get the digest, so existing plain "*.json" files
  // keep their current path.
  if (safe === file) return path.join(DATA_DIR, safe);
  const digest = createHash("sha1").update(file).digest("hex").slice(0, 8);
  return path.join(DATA_DIR, `${safe}-${digest}`);
}

// Serialises read-modify-write on one file within this process, so the file
// fallback matches Redis's one-command-at-a-time semantics. Keyed on the
// resolved path, not the raw key, so anything sharing a file shares a queue.
// Callbacks must never call another queued helper on the same file, or they
// deadlock; the helpers below use the unqueued readFileJson/writeFileJson.
const fileQueues = new Map<string, Promise<unknown>>();

function queued<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = filePath(file);
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Park a settled-either-way promise so one rejection does not poison the
  // queue for later writers.
  fileQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function readFileJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath(file), "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    throw new Error(`Failed to read ${file} from ${DATA_DIR}: ${String(err)}`);
  }
}

async function writeFileJson<T>(file: string, value: T): Promise<void> {
  await ensureDataDir();
  const target = filePath(file);
  // Unique temp name: two writers sharing "<target>.tmp" would clobber each
  // other's partial file and rename a torn document into place.
  const tmp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Whole-document read/write (existing callers)
// ---------------------------------------------------------------------------

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (redis !== null) {
    // @upstash/redis auto-deserializes JSON values; missing key -> null.
    const value = await redis.get<T>(KEY_PREFIX + file);
    return value ?? fallback;
  }

  return readFileJson(file, fallback);
}

export async function writeJson<T>(file: string, value: T): Promise<void> {
  if (redis !== null) {
    await redis.set(KEY_PREFIX + file, value);
    return;
  }

  await queued(file, () => writeFileJson(file, value));
}

/** Remove a key entirely. Missing keys are not an error. */
export async function deleteKey(key: string): Promise<void> {
  if (redis !== null) {
    await redis.del(KEY_PREFIX + key);
    return;
  }

  await queued(key, async () => {
    await fs.rm(filePath(key), { force: true });
  });
}

// ---------------------------------------------------------------------------
// Append-only lists
// ---------------------------------------------------------------------------

/**
 * Append one entry to a list. Atomic server-side (RPUSH), so concurrent
 * appends interleave instead of overwriting each other - which is the whole
 * point compared with read-append-writeJson.
 */
export async function appendJson<T>(file: string, entry: T): Promise<void> {
  await appendJsonAll(file, [entry]);
}

/** Append several entries in order, in one round trip. */
export async function appendJsonAll<T>(
  file: string,
  entries: readonly T[],
): Promise<void> {
  if (entries.length === 0) return;

  if (redis !== null) {
    await redis.rpush<T>(KEY_PREFIX + file, ...entries);
    return;
  }

  const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  await queued(file, async () => {
    await ensureDataDir();
    await fs.appendFile(filePath(file), lines, "utf8");
  });
}

/** Read a list written by appendJson, oldest first. Empty when absent. */
export async function readJsonList<T>(file: string): Promise<T[]> {
  if (redis !== null) {
    return await redis.lrange<T>(KEY_PREFIX + file, 0, -1);
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath(file), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw new Error(`Failed to read ${file} from ${DATA_DIR}: ${String(err)}`);
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

// ---------------------------------------------------------------------------
// Sorted sets (the agent-ledger index)
// ---------------------------------------------------------------------------

export interface ScoredMember {
  member: string;
  score: number;
}

/**
 * Add a member scored by timestamp, keeping the existing score when the member
 * is already present (ZADD NX). Idempotent by member, so callers no longer
 * need a read-then-dedupe pass over a whole index blob. Returns true when the
 * member was new.
 */
export async function zaddNx(
  key: string,
  member: string,
  score: number,
): Promise<boolean> {
  if (redis !== null) {
    const added = await redis.zadd(
      KEY_PREFIX + key,
      { nx: true },
      { score, member },
    );
    return added === 1;
  }

  return queued(key, async () => {
    const map = await readFileJson<Record<string, number>>(key, {});
    if (map[member] !== undefined) return false;
    map[member] = score;
    await writeFileJson(key, map);
    return true;
  });
}

/** Highest-scored members first, capped at limit. */
export async function zrevrange(
  key: string,
  limit: number,
): Promise<ScoredMember[]> {
  if (limit <= 0) return [];

  if (redis !== null) {
    const flat = await redis.zrange<(string | number)[]>(
      KEY_PREFIX + key,
      0,
      limit - 1,
      { rev: true, withScores: true },
    );
    const out: ScoredMember[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      out.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
    }
    return out;
  }

  const map = await readFileJson<Record<string, number>>(key, {});
  return Object.entries(map)
    .map(([member, score]) => ({ member, score }))
    // Mirror Redis: score descending, then member descending on ties.
    .sort((a, b) => b.score - a.score || (a.member < b.member ? 1 : -1))
    .slice(0, limit);
}

export async function zrem(key: string, member: string): Promise<void> {
  if (redis !== null) {
    await redis.zrem(KEY_PREFIX + key, member);
    return;
  }

  await queued(key, async () => {
    const map = await readFileJson<Record<string, number>>(key, {});
    if (map[member] === undefined) return;
    delete map[member];
    await writeFileJson(key, map);
  });
}

// ---------------------------------------------------------------------------
// Single-key claim gates
// ---------------------------------------------------------------------------

interface NxRecord {
  value: string;
  expiresAt: number | null;
}

function liveNxRecord(record: NxRecord | null): NxRecord | null {
  if (record === null) return null;
  if (record.expiresAt !== null && record.expiresAt <= Date.now()) return null;
  return record;
}

/**
 * Create a key only if it does not exist yet (SET NX). Returns true for the
 * one caller that created it, false for everybody else - the atomic
 * claim-or-lose that replaces read-then-check on a shared flag.
 */
export async function setNx(
  key: string,
  value: string,
  ttlMs?: number,
): Promise<boolean> {
  if (redis !== null) {
    const result =
      ttlMs === undefined
        ? await redis.set(KEY_PREFIX + key, value, { nx: true })
        : await redis.set(KEY_PREFIX + key, value, { nx: true, px: ttlMs });
    return result === "OK";
  }

  return queued(key, async () => {
    const current = liveNxRecord(await readFileJson<NxRecord | null>(key, null));
    if (current !== null) return false;
    await writeFileJson<NxRecord>(key, {
      value,
      expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs,
    });
    return true;
  });
}

/** Presence check for a key written by setNx. */
export async function existsKey(key: string): Promise<boolean> {
  if (redis !== null) {
    return (await redis.exists(KEY_PREFIX + key)) > 0;
  }

  const current = liveNxRecord(await readFileJson<NxRecord | null>(key, null));
  return current !== null;
}

// ---------------------------------------------------------------------------
// Counters (per-address balances)
// ---------------------------------------------------------------------------

function assertSafeDelta(delta: number, context: string): void {
  if (!Number.isSafeInteger(delta)) {
    throw new Error(`${context}: delta must be a safe integer, got ${delta}`);
  }
}

/** Atomic counter increment. Returns the value after the change. */
export async function hincrby(
  key: string,
  field: string,
  delta: number,
): Promise<number> {
  assertSafeDelta(delta, "hincrby");

  if (redis !== null) {
    return await redis.hincrby(KEY_PREFIX + key, field, delta);
  }

  return queued(key, async () => {
    const map = await readFileJson<Record<string, number>>(key, {});
    const next = (map[field] ?? 0) + delta;
    map[field] = next;
    await writeFileJson(key, map);
    return next;
  });
}

/** Current counter value; 0 when the key or field is absent. */
export async function hgetInt(key: string, field: string): Promise<number> {
  if (redis !== null) {
    const raw = await redis.hget<number | string>(KEY_PREFIX + key, field);
    if (raw === null || raw === undefined) return 0;
    return Number(raw);
  }

  const map = await readFileJson<Record<string, number>>(key, {});
  return map[field] ?? 0;
}

// How long one credit/debit may hold the file-fallback counter lock.
const COUNTER_LOCK_TTL_MS = 5_000;

// Claim the ref and move the counter in ONE server-side operation.
//
// Doing it as two calls leaves a window that costs real money: if the second
// call fails after the ref is committed, no money moved but every retry with
// that ref reports "already applied", so a lost top-up or a withdrawal that
// never happened is reported as done. Redis runs a script atomically, so
// either both happen or neither does.
//
// Returns [status, value] where status is 1 applied, 0 already applied,
// -1 refused for insufficient funds.
const APPLY_COUNTER_DELTA = `
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if redis.call('SADD', KEYS[2], ARGV[2]) == 0 then
  return {0, current}
end
local delta = tonumber(ARGV[3])
if ARGV[4] == '1' and current + delta < 0 then
  redis.call('SREM', KEYS[2], ARGV[2])
  return {-1, current}
end
return {1, redis.call('HINCRBY', KEYS[1], ARGV[1], delta)}
`;

export interface CounterMutation {
  status: "applied" | "duplicate" | "insufficient";
  /** Counter value after the change, or the unchanged value otherwise. */
  value: number;
}

/**
 * Apply a signed delta to a counter exactly once per ref.
 *
 * requireAvailable refuses the change when it would take the counter below
 * zero, and the check is part of the same operation: two callers that read a
 * balance and then check it both pass, and both withdraw.
 */
export async function applyCounterDelta(args: {
  counterKey: string;
  field: string;
  refsKey: string;
  ref: string;
  delta: number;
  requireAvailable: boolean;
}): Promise<CounterMutation> {
  const { counterKey, field, refsKey, ref, delta, requireAvailable } = args;
  assertSafeDelta(delta, "applyCounterDelta");

  if (redis !== null) {
    const [status, value] = await redis.eval<
      [string, string, string, string],
      [number, number]
    >(
      APPLY_COUNTER_DELTA,
      [KEY_PREFIX + counterKey, KEY_PREFIX + refsKey],
      [field, ref, String(delta), requireAvailable ? "1" : "0"],
    );
    if (status === 0) return { status: "duplicate", value: Number(value) };
    if (status === -1) return { status: "insufficient", value: Number(value) };
    return { status: "applied", value: Number(value) };
  }

  // One process, one lock: the pair of files has to move together here too.
  return withLock(
    `counter:${counterKey}`,
    COUNTER_LOCK_TTL_MS,
    async (): Promise<CounterMutation> => {
      const current = await hgetInt(counterKey, field);
      if ((await sadd(refsKey, ref)) !== 1) {
        return { status: "duplicate", value: current };
      }
      if (requireAvailable && current + delta < 0) {
        await srem(refsKey, ref);
        return { status: "insufficient", value: current };
      }
      return {
        status: "applied",
        value: await hincrby(counterKey, field, delta),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Sets (idempotency refs)
// ---------------------------------------------------------------------------

/**
 * Add members to a set. Returns how many were new, so `=== 1` on a single
 * member is an atomic "I am the first to apply this ref" gate.
 */
export async function sadd(
  key: string,
  ...members: string[]
): Promise<number> {
  if (members.length === 0) return 0;

  if (redis !== null) {
    return await redis.sadd<string>(KEY_PREFIX + key, members[0], ...members.slice(1));
  }

  return queued(key, async () => {
    const existing = await readFileJson<string[]>(key, []);
    const known = new Set(existing);
    let added = 0;
    for (const member of members) {
      if (known.has(member)) continue;
      known.add(member);
      added += 1;
    }
    if (added > 0) await writeFileJson(key, [...known]);
    return added;
  });
}

export async function srem(key: string, member: string): Promise<void> {
  if (redis !== null) {
    await redis.srem(KEY_PREFIX + key, member);
    return;
  }

  await queued(key, async () => {
    const existing = await readFileJson<string[]>(key, []);
    if (!existing.includes(member)) return;
    await writeFileJson(
      key,
      existing.filter((entry) => entry !== member),
    );
  });
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

// Compare-and-delete: a holder whose lock already expired must not delete the
// lock a later holder is relying on.
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const localLocks = new Map<string, { token: string; expiresAt: number }>();

export class LockUnavailableError extends Error {}

function lockKey(name: string): string {
  return `${KEY_PREFIX}lock:${name}`;
}

/**
 * Take a named lock. Returns an opaque token for the holder, or null when
 * somebody else holds it. The TTL is a deadline, not a promise: a holder that
 * overruns loses the lock, which is why release is compare-and-delete.
 */
export async function acquireLock(
  name: string,
  ttlMs: number,
): Promise<string | null> {
  const token = randomUUID();

  if (redis !== null) {
    const result = await redis.set(lockKey(name), token, {
      nx: true,
      px: ttlMs,
    });
    return result === "OK" ? token : null;
  }

  // No await between the read and the write, so this is atomic for one
  // process - which is all the file fallback ever serves.
  const held = localLocks.get(name);
  if (held !== undefined && held.expiresAt > Date.now()) return null;
  localLocks.set(name, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

/** Release a lock only if this token still holds it. */
export async function releaseLock(name: string, token: string): Promise<void> {
  if (redis !== null) {
    await redis.eval<[string], number>(RELEASE_LOCK, [lockKey(name)], [token]);
    return;
  }

  const held = localLocks.get(name);
  if (held !== undefined && held.token === token) localLocks.delete(name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run fn while holding a named lock, releasing it even if fn throws. Waits up
 * to waitMs for the lock and then throws: a money path that cannot serialise
 * must fail loudly rather than run unguarded.
 */
export async function withLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
  waitMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = await acquireLock(name, ttlMs);
    if (token !== null) {
      try {
        return await fn();
      } finally {
        // A failed release is not worth masking fn's own error with: the TTL
        // clears the lock either way.
        await releaseLock(name, token).catch(() => undefined);
      }
    }
    if (Date.now() >= deadline) {
      throw new LockUnavailableError(
        `could not acquire lock ${name} within ${waitMs}ms`,
      );
    }
    await sleep(10 + Math.random() * 30);
  }
}
