// Atomic spend windows for the money routes.
//
// WHY NOT lib/server/store.ts
// That store reads a whole JSON blob, mutates it, and writes it back. That is
// the right shape for the balance ledger, where a lost update is caught by the
// per-ref idempotency check, but it is the wrong shape for a COUNTER: two
// concurrent requests read the same total, both conclude they are under the
// cap, and the second write silently overwrites the first. A cap that only
// holds when requests arrive one at a time is not a cap, and these caps are
// the only thing standing between an unauthenticated route and the treasury.
//
// So the counters live on their own keys and move through an atomic increment:
//   - With Upstash Redis (production, and the same env vars store.ts reads):
//     INCRBY returns the post-increment total, so exactly one caller can
//     observe the total crossing the cap. An over-cap increment is handed
//     straight back with a matching DECRBY.
//   - Without Redis (local dev and tests): a single process owns the JSON
//     file, so an in-process promise chain serialises the read-modify-write.
//
// Windows are fixed buckets of `floor(now / windowMs)` carried in the key, so
// the counter resets by key rotation rather than by TTL expiry. A TTL is still
// set, but only to stop old buckets accumulating: if it were ever lost, the
// cap would still be correct.
//
// TO CONSOLIDATE POST-MERGE: another branch is adding atomic primitives
// (setNx, hincrby, sadd, locks) to lib/server/store.ts. When that lands, this
// module's Redis client and the two primitives below should move onto it
// rather than holding a second client.
//
// `_money` is a Next private folder, so nothing here is routable. Server only.

import { Redis } from "@upstash/redis";
import { readJson, writeJson } from "@/lib/server/store";
import {
  spendVerdict,
  windowBucket,
  windowRetryAfterSeconds,
} from "@/lib/money-guards";

export interface WindowSpend {
  kind: "allow" | "deny";
  /** How much of the cap is still available in this window. */
  remainingUusdc: bigint;
  /** Seconds until the window rolls over. */
  retryAfterSeconds: number;
}

// ------------------------------------------------------------------- backends

const KEY_PREFIX = "gohealthme:spend:";
const SPEND_FILE = "spend-windows.json";

/** Same env var names store.ts reads, so one configuration drives both. */
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

const redis = redisClient();

/** Per-window counters for the file backend: name -> bucket + amount used. */
type SpendFile = Record<string, { bucket: number; usedUusdc: string }>;

/**
 * Serialise file-backed read-modify-writes through a single promise chain.
 * The file backend only runs where one process owns the file, so this is
 * sufficient there; it is never relied on in production, where Redis is.
 */
let fileQueue: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const run = fileQueue.then(work, work);
  fileQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function bucketKey(name: string, bucket: number): string {
  return `${KEY_PREFIX}${name}:${bucket}`;
}

/** A corrupt counter must never read as unused headroom. */
function readUsed(entry: { bucket: number; usedUusdc: string } | undefined, bucket: number): bigint {
  if (entry === undefined || entry.bucket !== bucket) return 0n;
  try {
    const used = BigInt(entry.usedUusdc);
    return used > 0n ? used : 0n;
  } catch {
    return 0n;
  }
}

/** Read a window's current total without reserving anything. */
async function currentUsed(name: string, bucket: number): Promise<bigint> {
  if (redis !== null) {
    const raw = await redis.get<number | string>(bucketKey(name, bucket));
    if (raw === null || raw === undefined) return 0n;
    try {
      const used = BigInt(raw);
      return used > 0n ? used : 0n;
    } catch {
      return 0n;
    }
  }
  const store = await readJson<SpendFile>(SPEND_FILE, {});
  return readUsed(store[name], bucket);
}

// ------------------------------------------------------------------ primitives

/**
 * Reserve amountUusdc against a capped window, atomically. Returns "allow"
 * only when the reservation actually fits, and the reservation is already
 * recorded when it does, so the caller may move money immediately afterwards.
 *
 * Reserve BEFORE moving money and release on failure. The reverse order leaves
 * a window in which a crash costs the treasury rather than the caller.
 */
export async function spendFromWindow(
  name: string,
  amountUusdc: bigint,
  capUusdc: bigint,
  windowMs: number,
  nowMs: number,
): Promise<WindowSpend> {
  const bucket = windowBucket(nowMs, windowMs);
  const retryAfterSeconds = windowRetryAfterSeconds(nowMs, windowMs);

  // Refuse anything that cannot fit before touching the counter. Two reasons:
  // an amount larger than the cap can never be allowed, and the amount is
  // caller-influenced, so this is what keeps it inside Number's exact-integer
  // range before it reaches INCRBY. Without it a 10^30 request would be
  // converted lossily and corrupt the counter on its way to being denied.
  // The remainder is still read so the caller is told the truth about how
  // much of their allowance is actually left.
  if (amountUusdc <= 0n || amountUusdc > capUusdc) {
    const used = await currentUsed(name, bucket);
    return {
      kind: "deny",
      remainingUusdc: capUusdc > used ? capUusdc - used : 0n,
      retryAfterSeconds,
    };
  }

  if (redis !== null) {
    const key = bucketKey(name, bucket);
    const totalAfter = BigInt(await redis.incrby(key, Number(amountUusdc)));

    // Expiry is cleanup only: bucket rotation, not this TTL, is what resets
    // the counter. A failure here must not abort the request, because the
    // increment above has already landed and throwing would leak it.
    try {
      await redis.pexpire(key, windowMs * 2);
    } catch (err) {
      console.error(`[money/rate-limit] pexpire failed for ${name}`, err);
    }

    const verdict = spendVerdict(totalAfter, amountUusdc, capUusdc);
    if (verdict.kind === "deny") {
      // Hand the over-cap increment straight back. If that fails the counter
      // stays inflated until the bucket rotates, which refuses more requests
      // rather than allowing them, so the denial still stands.
      try {
        await redis.decrby(key, Number(amountUusdc));
      } catch (err) {
        console.error(
          `[money/rate-limit] failed to return an over-cap increment for ${name}`,
          err,
        );
      }
    }
    return { ...verdict, retryAfterSeconds };
  }

  return await serialise(async () => {
    const store = await readJson<SpendFile>(SPEND_FILE, {});
    const totalAfter = readUsed(store[name], bucket) + amountUusdc;
    const verdict = spendVerdict(totalAfter, amountUusdc, capUusdc);
    if (verdict.kind === "allow") {
      store[name] = { bucket, usedUusdc: totalAfter.toString() };
      await writeJson<SpendFile>(SPEND_FILE, store);
    }
    return { ...verdict, retryAfterSeconds };
  });
}

/**
 * Hand back a reservation for money that never moved. Best effort: if it
 * fails, the caller keeps their funds and loses only this window's allowance,
 * which is the safe direction. Never silent.
 */
export async function releaseFromWindow(
  name: string,
  amountUusdc: bigint,
  windowMs: number,
  nowMs: number,
): Promise<void> {
  const bucket = windowBucket(nowMs, windowMs);
  try {
    if (redis !== null) {
      await redis.decrby(bucketKey(name, bucket), Number(amountUusdc));
      return;
    }
    await serialise(async () => {
      const store = await readJson<SpendFile>(SPEND_FILE, {});
      const used = readUsed(store[name], bucket);
      if (used === 0n) return;
      const restored = used - amountUusdc;
      store[name] = {
        bucket,
        usedUusdc: (restored > 0n ? restored : 0n).toString(),
      };
      await writeJson<SpendFile>(SPEND_FILE, store);
    });
  } catch (err) {
    console.error(`[money/rate-limit] failed to release ${name}`, err);
  }
}

/**
 * Allow one claim per name per window, atomically. Built on the same counter
 * with a cap of one, so the claim gate and the spend gate cannot drift apart.
 *
 * Honest about the window shape: this is a fixed bucket, not a rolling 24
 * hours from the last claim. An address that claims immediately before a
 * bucket boundary can claim again immediately after it. That is worth one
 * extra grant, and the global budget still bounds the day.
 */
export async function claimOncePerWindow(
  name: string,
  windowMs: number,
  nowMs: number,
): Promise<WindowSpend> {
  return await spendFromWindow(name, 1n, 1n, windowMs, nowMs);
}

/** Give back a one-per-window claim whose follow-up work failed. */
export async function releaseOncePerWindow(
  name: string,
  windowMs: number,
  nowMs: number,
): Promise<void> {
  await releaseFromWindow(name, 1n, windowMs, nowMs);
}

// ------------------------------------------------------------- mutual exclusion

/**
 * The balance ledger (lib/server/balance.ts) reads a whole JSON blob, mutates
 * it, and writes it back, with no compare-and-swap. That is safe for its own
 * per-ref idempotency, but it is NOT safe against concurrent mutations: two
 * requests can read the same blob, each apply their own change, and the last
 * write silently drops the other. On the withdraw path that is a double spend
 * -- both callers pass the balance check, both debit, one debit is lost, and
 * both transfers land.
 *
 * Making the ledger itself atomic belongs in that module and is owned
 * elsewhere, so until it lands the routes serialise their own ledger
 * mutations through this lock. Hold it across a read-then-write of the
 * ledger, never across an on-chain transfer.
 *
 * TO CONSOLIDATE POST-MERGE: when lib/server/store.ts grows atomic primitives
 * and balance.ts uses them, this lock becomes redundant and should be removed
 * rather than left to rot.
 */
export const LEDGER_LOCK = "ledger";

/** How long a held lock survives a crashed request before it is reclaimed. */
const LOCK_TTL_MS = 15_000;

/** Bounded wait so a brief overlap does not surface as a spurious refusal. */
const LOCK_ATTEMPTS = 12;
const LOCK_RETRY_MS = 120;

export type LockedResult<T> = { kind: "done"; value: T } | { kind: "busy" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run work under a named exclusive lock.
 *
 * With Redis, SET NX PX gives a cross-instance lock and a caller that cannot
 * take it within the bounded retry window gets "busy" rather than proceeding
 * unsafely. Without Redis a single process owns the store, so the existing
 * in-process queue already provides mutual exclusion and no caller is ever
 * turned away.
 *
 * The lock is always released, including when work throws.
 */
export async function withLock<T>(
  name: string,
  work: () => Promise<T>,
): Promise<LockedResult<T>> {
  if (redis === null) {
    return { kind: "done", value: await serialise(work) };
  }

  const key = `${KEY_PREFIX}lock:${name}`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const acquired = await redis.set(key, Date.now().toString(), {
      nx: true,
      px: LOCK_TTL_MS,
    });
    if (acquired === "OK") {
      try {
        return { kind: "done", value: await work() };
      } finally {
        try {
          await redis.del(key);
        } catch (err) {
          // The TTL reclaims it; log so a stuck lock is never a silent stall.
          console.error(`[money/rate-limit] failed to release lock ${name}`, err);
        }
      }
    }
    await sleep(LOCK_RETRY_MS);
  }
  return { kind: "busy" };
}
