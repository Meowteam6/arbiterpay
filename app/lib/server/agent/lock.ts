// Cross-instance coordination for SPOTTER: mutual exclusion, spend-intent
// markers, and the pending-settlement queue.
//
// WHY THIS FILE EXISTS. On Vercel every request can land on a different lambda,
// so a module-scope Map is per-instance and provides no mutual exclusion at
// all. Two concurrent polls of the same claim would each buy the attester read
// (real USDC leaves the wallet on pay(), with no idempotency at the gateway)
// and each compute cap headroom from the same stale ledger snapshot, so the
// per-claim cap stops being enforceable the moment two tabs are open. The lock
// therefore has to live where every instance can see it: the same Upstash
// Redis the claim store already uses, read through the same env vars
// (KV_REST_API_* or UPSTASH_REDIS_REST_*) so there is nothing extra to
// configure.
//
// TTLs. Every lock is taken with a TTL ABOVE the route's maxDuration (60s), so
// a lambda killed mid-run always has its lock expire rather than wedging a
// claim forever. Nothing here is reentrant: acquire a goal lock, then a pool
// lock, never the reverse, and never the same name twice in one call stack.
//
// FAIL-CLOSED. A Redis transport error is reported as "not acquired", never as
// "acquired": stalling a claim until the next poll is recoverable, a double
// spend is not. Callers must treat a failed acquire as "someone else owns this
// right now" and report the current state instead of an error.
//
// LOCAL / TESTS. With no Redis env, this degrades to a process-local map. That
// is correct for a single long-lived dev server or a vitest run, and wrong for
// serverless - which is exactly why production must have Redis configured. The
// downgrade is logged once so a misconfigured deploy is visible in the logs.

import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

// Same namespace as store.ts so one Redis instance can be shared with another
// project without collisions.
const KEY_PREFIX = "gohealthme:";

/** Sorted set of claims waiting for their pool period to end, scored by
 *  periodEnd (unix seconds). The sweep reads only what is actually due
 *  instead of scanning the whole ledger index. */
const PENDING_KEY = `${KEY_PREFIX}agent-pending-settlement`;

/** Compare-and-delete: only the holder of the token may release the lock, so
 *  a lock that expired and was re-taken by another instance is never deleted
 *  out from under its new owner. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

let cachedRedis: Redis | null | undefined;
let warnedNoRedis = false;

/**
 * The shared Redis handle, or null when no Redis env is present. Exported so
 * budget.ts counts spend on the SAME instance the locks live on: a cap that
 * disagrees with the lock about which store is authoritative is not a cap.
 */
export function agentRedis(): Redis | null {
  if (cachedRedis !== undefined) return cachedRedis;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || token === undefined || url === "" || token === "") {
    if (!warnedNoRedis) {
      warnedNoRedis = true;
      console.warn(
        "[agent/lock] no Redis env present; falling back to process-local " +
          "coordination. This is correct locally and UNSAFE on serverless: " +
          "set KV_REST_API_URL/KV_REST_API_TOKEN in any deployed environment.",
      );
    }
    cachedRedis = null;
    return null;
  }
  cachedRedis = new Redis({ url, token });
  return cachedRedis;
}

// ------------------------------------------------------ process-local fallback

const localLocks = new Map<string, { token: string; expiresAt: number }>();
const localPending = new Map<string, number>();

function localAcquire(key: string, ttlMs: number): string | null {
  const now = Date.now();
  const held = localLocks.get(key);
  if (held !== undefined && held.expiresAt > now) return null;
  const token = randomUUID();
  localLocks.set(key, { token, expiresAt: now + ttlMs });
  return token;
}

function localRelease(key: string, token: string): boolean {
  const held = localLocks.get(key);
  if (held === undefined || held.token !== token) return false;
  localLocks.delete(key);
  return true;
}

/** Drop all process-local coordination state. Tests only; a no-op against
 *  Redis, which is deliberately never bulk-cleared from application code. */
export function resetLocalCoordinationState(): void {
  localLocks.clear();
  localPending.clear();
  cachedRedis = undefined;
}

// -------------------------------------------------------------------- locking

export type LockOutcome<T> = { acquired: true; value: T } | { acquired: false };

function lockKey(name: string): string {
  return `${KEY_PREFIX}lock:${name}`;
}

/**
 * Take `name` for at most `ttlMs`. Returns the holder token, or null when the
 * lock is already held (or when Redis could not answer - see FAIL-CLOSED).
 */
export async function acquireLock(
  name: string,
  ttlMs: number,
): Promise<string | null> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`acquireLock(${name}) needs a positive ttlMs`);
  }
  const client = agentRedis();
  if (client === null) return localAcquire(lockKey(name), ttlMs);
  const token = randomUUID();
  try {
    const result = await client.set(lockKey(name), token, {
      nx: true,
      px: Math.ceil(ttlMs),
    });
    return result === "OK" ? token : null;
  } catch (err) {
    console.error(
      `[agent/lock] acquire ${name} failed; treating the lock as held: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** Release `name` only if this token still holds it. */
export async function releaseLock(
  name: string,
  token: string,
): Promise<boolean> {
  const client = agentRedis();
  if (client === null) return localRelease(lockKey(name), token);
  try {
    const deleted = await client.eval<[string], number>(
      RELEASE_SCRIPT,
      [lockKey(name)],
      [token],
    );
    return deleted === 1;
  } catch (err) {
    // The TTL is the backstop: a lock that cannot be released expires on its
    // own, so this is loud but never fatal.
    console.error(
      `[agent/lock] release ${name} failed; the TTL will expire it: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Run `fn` under `name`, releasing afterwards even if it throws. The caller
 * gets `{ acquired: false }` when another holder owns the lock; that is not an
 * error, it means a sibling is doing this work right now.
 */
export async function withLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<LockOutcome<T>> {
  const token = await acquireLock(name, ttlMs);
  if (token === null) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await releaseLock(name, token);
  }
}

// ------------------------------------------------- pending-settlement queue
//
// Every function here swallows its own transport errors: the queue is an index
// that makes the sweep cheap, never the authority on whether a claim is paid.
// Losing a queue write costs one bounded index scan, so it must not be allowed
// to fail a settlement that is otherwise fine.

/**
 * Mark a claim as awaiting settlement, due at `dueSeconds` (unix seconds -
 * the pool's periodEnd, or now for a claim that is due and retrying).
 */
export async function addPendingSettlement(
  goalId: string,
  dueSeconds: number,
): Promise<void> {
  const member = goalId.toLowerCase();
  const score = Number.isFinite(dueSeconds) ? Math.floor(dueSeconds) : 0;
  const client = agentRedis();
  if (client === null) {
    localPending.set(member, score);
    return;
  }
  try {
    await client.zadd(PENDING_KEY, { score, member });
  } catch (err) {
    console.warn(
      `[agent/lock] could not queue ${member} for settlement: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Drop a claim from the queue: settled, or terminal beyond recovery. */
export async function removePendingSettlement(goalId: string): Promise<void> {
  const member = goalId.toLowerCase();
  const client = agentRedis();
  if (client === null) {
    localPending.delete(member);
    return;
  }
  try {
    await client.zrem(PENDING_KEY, member);
  } catch (err) {
    console.warn(
      `[agent/lock] could not dequeue ${member}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Claims whose pool period has ended, oldest first, capped at `limit`. */
export async function listDuePendingSettlements(
  nowSeconds: number,
  limit: number,
): Promise<string[]> {
  const cutoff = Math.floor(nowSeconds);
  const client = agentRedis();
  if (client === null) {
    return [...localPending.entries()]
      .filter(([, score]) => score <= cutoff)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([member]) => member);
  }
  try {
    return await client.zrange<string[]>(PENDING_KEY, 0, cutoff, {
      byScore: true,
      offset: 0,
      count: limit,
    });
  } catch (err) {
    console.warn(
      `[agent/lock] could not read the pending-settlement queue: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}
