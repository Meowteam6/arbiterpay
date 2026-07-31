// Small JSON key/value persistence used by the claims store and the agent
// ledger.
//
// PRODUCTION (serverless): uses Upstash Redis over its REST API — a shared,
// persistent store reachable from every function instance. This is required
// because serverless invocations don't share a filesystem: a record written
// on one instance is invisible to a route handled by another, so any
// cross-request state kept in files always breaks in prod.
//
// LOCAL / TESTS (no Redis env): falls back to JSON files under os.tmpdir()
// (or DATA_DIR). A single long-lived process shares one dir, so the file
// store behaves correctly there. Tests pin DATA_DIR to <cwd>/.data.
//
// Configure Redis via the Vercel Upstash/KV Marketplace integration, which
// provides KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/
// UPSTASH_REDIS_REST_TOKEN). Either naming works.

import { promises as fs } from "fs";
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

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (redis !== null) {
    // @upstash/redis auto-deserializes JSON values; missing key -> null.
    const value = await redis.get<T>(KEY_PREFIX + file);
    return value ?? fallback;
  }

  try {
    const raw = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    throw new Error(`Failed to read ${file} from ${DATA_DIR}: ${String(err)}`);
  }
}

export async function writeJson<T>(file: string, value: T): Promise<void> {
  if (redis !== null) {
    await redis.set(KEY_PREFIX + file, value);
    return;
  }

  await ensureDataDir();
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, target);
}
