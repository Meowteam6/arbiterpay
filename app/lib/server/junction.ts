// Junction (formerly Vital) health-data integration (server only).
//
// Replaces the WHOOP-direct OAuth integration with Junction's unified API,
// which covers WHOOP, Oura, Fitbit, Garmin, etc. through one connect flow.
// (Apple Health is intentionally NOT supported here: it requires Junction's
// native mobile SDK and cannot be linked from a web app.)
//
// Auth: header `x-vital-api-key`. Base URL + env/region come from env so the
// same code runs against sandbox or production.
//
// Privacy invariant (unchanged from WHOOP): raw samples never leave this
// module — only derived per-day scores and a streak summary are surfaced, and
// nothing here is written on-chain directly.
//
// Resilience: every request carries an AbortSignal timeout (a hung Junction
// call used to burn the whole 60s function budget) and GET reads retry with
// backoff. Writes never retry — creating a user or a link token twice is not a
// no-op. The wallet -> Junction user_id mapping is memoized because it sat on
// the hot path: getProgress/isConnected/getRecent each re-resolved it, so one
// 800ms poll cost three HTTP round-trips instead of one.

import { requireEnv, optionalEnv } from "@/lib/server/env";
import { ttlCache } from "@/lib/server/arc-client";
import { isRetryableExternalError, withRetry } from "@/lib/server/retry";

/**
 * A hung upstream must fail well inside the function's 60s budget.
 * JUNCTION_TIMEOUT_MS overrides it (operator tuning, and tests that need to
 * exercise the timeout without waiting 15 seconds).
 */
const DEFAULT_JUNCTION_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 2;
const READ_BACKOFF_MS = [300];

function junctionTimeoutMs(): number {
  const raw = Number(optionalEnv("JUNCTION_TIMEOUT_MS", ""));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_JUNCTION_TIMEOUT_MS;
}

function apiKey(): string {
  return requireEnv("JUNCTION_API_KEY");
}
function baseUrl(): string {
  return optionalEnv("JUNCTION_BASE_URL", "https://api.sandbox.tryvital.io");
}
function linkBase(): { env: string; region: string } {
  const env = optionalEnv("JUNCTION_ENV", "sandbox");
  const region = optionalEnv("JUNCTION_REGION", "us");
  return { env, region };
}

async function jxOnce<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      "x-vital-api-key": apiKey(),
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(junctionTimeoutMs()),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Truncated: this message can surface through a route's error handler, so
    // it carries enough to debug without relaying an upstream response body.
    throw new Error(
      `Junction ${path} returned ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Junction request. Retries only when the call is a read: a GET is idempotent,
 * a POST here creates a user or issues a link token and must run exactly once.
 */
async function jx<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") return jxOnce<T>(path, init);
  return withRetry(() => jxOnce<T>(path, init), {
    attempts: READ_ATTEMPTS,
    backoffMs: READ_BACKOFF_MS,
    isRetryable: isRetryableExternalError,
    onRetry: (err, attempt, attempts) =>
      console.warn(
        `[junction] GET ${path} attempt ${attempt}/${attempts} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
  });
}

// --------------------------------------------------------------- user mapping

interface VitalUser {
  user_id: string;
  client_user_id?: string;
}

/**
 * A wallet's Junction user_id never changes once created, but every
 * progress/status/data call re-resolved it, so a single 800ms dashboard poll
 * cost three HTTP round-trips where one would do. The TTL is short so a user
 * deleted upstream is not pinned forever, and failures are never cached.
 */
const USER_ID_TTL_MS = 10 * 60_000;
const userIdCache = ttlCache<string>({
  ttlMs: USER_ID_TTL_MS,
  maxEntries: 512,
});

/**
 * Map a wallet address to a Junction user_id. Junction itself keys on
 * client_user_id, so we resolve-then-create and let it dedupe — no local store
 * needed. The address is lowercased to keep the client_user_id stable.
 *
 * Memoized per address; concurrent callers share one in-flight resolve, so a
 * burst of polls cannot fan out into a burst of create attempts.
 */
export async function getOrCreateUser(address: string): Promise<string> {
  const clientUserId = address.toLowerCase();
  return userIdCache.get(clientUserId, async () => {
    // 1) resolve existing (idempotent read, so retried)
    try {
      const resolved = await withRetry(
        () =>
          jxOnce<VitalUser>(
            `/v2/user/resolve/${encodeURIComponent(clientUserId)}`,
          ),
        {
          attempts: READ_ATTEMPTS,
          backoffMs: READ_BACKOFF_MS,
          isRetryable: isRetryableExternalError,
        },
      );
      if (resolved.user_id) return resolved.user_id;
    } catch (err) {
      // A 404 here is the normal "not created yet" path, so this is expected
      // noise; anything else still falls through to the create below, which
      // Junction dedupes on client_user_id.
      console.warn(
        `[junction] user resolve fell through to create: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // 2) create — a write, so never retried.
    const created = await jx<VitalUser>("/v2/user", {
      method: "POST",
      body: JSON.stringify({ client_user_id: clientUserId }),
    });
    if (!created.user_id) {
      // Throw rather than return an empty id: the cache never stores a
      // rejected load, so a bad response cannot be pinned for the whole TTL.
      throw new Error("Junction created a user but returned no user_id");
    }
    return created.user_id;
  });
}

// ------------------------------------------------------------------ link flow

interface LinkTokenResponse {
  link_token: string;
}

/**
 * Create a Junction Link token + the hosted connect URL the browser opens to
 * link a provider (WHOOP/Oura/Fitbit/Garmin/…).
 */
export async function createLinkToken(
  address: string,
): Promise<{ userId: string; linkUrl: string }> {
  const userId = await getOrCreateUser(address);
  const { link_token } = await jx<LinkTokenResponse>("/v2/link/token", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  const { env, region } = linkBase();
  const linkUrl = `https://link.tryvital.io/?token=${encodeURIComponent(
    link_token,
  )}&env=${env}&region=${region}`;
  return { userId, linkUrl };
}

// ---------------------------------------------------------- connection status

interface ProvidersResponse {
  providers: Array<{ slug?: string; status?: string }>;
}

/** True once the user has linked at least one health-data provider. */
export async function isConnected(address: string): Promise<boolean> {
  const userId = await getOrCreateUser(address);
  const { providers } = await jx<ProvidersResponse>(
    `/v2/user/providers/${userId}`,
  );
  return Array.isArray(providers) && providers.length > 0;
}

// -------------------------------------------------------------- progress feed

export interface JunctionProgress {
  streakDays: number;
  lastNight: number | null;
  qualified: boolean;
  /** Average score over days 8-14 back (the week before the current week). */
  baselineWeekAvg: number | null;
  /** Per-day scores used, newest first. */
  days: Array<{ date: string; score: number }>;
}

interface SleepRecord {
  calendar_date?: string;
  date?: string;
  bedtime_stop?: string;
  score?: number | null;
  efficiency?: number | null;
  sleep_efficiency?: number | null;
}

interface SleepResponse {
  sleep?: SleepRecord[];
  data?: SleepRecord[];
}

function dayKey(rec: SleepRecord): string | null {
  if (rec.calendar_date) return rec.calendar_date.slice(0, 10);
  if (rec.date) return rec.date.slice(0, 10);
  if (rec.bedtime_stop) return rec.bedtime_stop.slice(0, 10);
  return null;
}

function recScore(rec: SleepRecord): number | null {
  const v = rec.score ?? rec.efficiency ?? rec.sleep_efficiency;
  return typeof v === "number" ? v : null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the current sleep streak for an address from Junction data.
 *
 * Mirrors the previous WHOOP logic: a day qualifies when its best sleep score
 * meets `threshold`; the streak is the run of consecutive calendar days ending
 * at the most recent scored night. baselineWeekAvg averages days 8-14 back,
 * feeding the comeback multiplier.
 */
export async function getProgress(
  address: string,
  threshold = 75,
  goalDays = 7,
  windowStartISO?: string,
  windowEndISO?: string,
): Promise<JunctionProgress> {
  const userId = await getOrCreateUser(address);
  const end = new Date();
  // Fetch enough history to cover either the rolling window or the pool period.
  const defaultStart = new Date(end.getTime() - 21 * 24 * 3600 * 1000);
  const start =
    windowStartISO !== undefined
      ? new Date(`${windowStartISO}T00:00:00Z`)
      : defaultStart;
  const resp = await jx<SleepResponse>(
    `/v2/summary/sleep/${userId}?start_date=${isoDate(start)}&end_date=${isoDate(end)}`,
  );
  const records = resp.sleep ?? resp.data ?? [];

  // Best score per calendar day.
  const byDay = new Map<string, number>();
  for (const rec of records) {
    const key = dayKey(rec);
    const score = recScore(rec);
    if (key === null || score === null) continue;
    const prev = byDay.get(key);
    if (prev === undefined || score > prev) byDay.set(key, score);
  }

  const dates = Array.from(byDay.keys()).sort().reverse(); // newest first
  if (dates.length === 0) {
    return {
      streakDays: 0,
      lastNight: null,
      qualified: false,
      baselineWeekAvg: null,
      days: [],
    };
  }

  const newest = dates[0];
  const lastNight = byDay.get(newest) ?? null;

  // Count qualifying days (score >= threshold). With a pool window we count
  // within [windowStart, min(windowEnd, today)] — progress scoped to the pool's
  // goal period (counting from when the goal started), not a rolling last-N.
  // Otherwise fall back to the last `goalDays`. Days over threshold are counted
  // rather than a strict consecutive run, so a single missing day of wearable
  // data doesn't reset progress.
  let streakDays = 0;
  if (windowStartISO !== undefined) {
    const today = new Date();
    const winEndDate =
      windowEndISO !== undefined &&
      new Date(`${windowEndISO}T00:00:00Z`) < today
        ? new Date(`${windowEndISO}T00:00:00Z`)
        : today;
    const cur = new Date(`${windowStartISO}T00:00:00Z`);
    while (cur <= winEndDate) {
      const key = cur.toISOString().slice(0, 10);
      const score = byDay.get(key);
      if (score !== undefined && score >= threshold) streakDays += 1;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  } else {
    const cursor = new Date(`${newest}T00:00:00Z`);
    for (let i = 0; i < goalDays; i += 1) {
      const key = cursor.toISOString().slice(0, 10);
      const score = byDay.get(key);
      if (score !== undefined && score >= threshold) streakDays += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
  }

  // Baseline week: days 8..14 back from the newest night.
  const baselineScores: number[] = [];
  for (let back = 7; back < 14; back += 1) {
    const d = new Date(`${newest}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - back);
    const score = byDay.get(d.toISOString().slice(0, 10));
    if (score !== undefined) baselineScores.push(score);
  }
  const baselineWeekAvg =
    baselineScores.length > 0
      ? baselineScores.reduce((a, b) => a + b, 0) / baselineScores.length
      : null;

  return {
    streakDays,
    lastNight,
    qualified: streakDays >= goalDays,
    baselineWeekAvg,
    days: dates.map((d) => ({ date: d, score: byDay.get(d) as number })),
  };
}

// ------------------------------------------------------------- recent data

export interface RecentData {
  sleep: Array<{ date: string; score: number | null; hours: number | null }>;
  activity: Array<{ date: string; steps: number | null }>;
}

interface ActivityRecord {
  calendar_date?: string;
  date?: string;
  steps?: number | null;
}
interface ActivityResponse {
  activity?: ActivityRecord[];
  data?: ActivityRecord[];
}

/**
 * Recent per-day sleep + activity, newest first, for the dashboard demo
 * display once a provider is linked. Each summary call is best-effort so a
 * provider that only reports one modality still renders the other.
 */
export async function getRecent(address: string, days = 7): Promise<RecentData> {
  const userId = await getOrCreateUser(address);
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const range = `start_date=${isoDate(start)}&end_date=${isoDate(end)}`;

  const [sleepResp, actResp] = await Promise.all([
    jx<SleepResponse>(`/v2/summary/sleep/${userId}?${range}`).catch(
      () => ({ sleep: [] }) as SleepResponse,
    ),
    jx<ActivityResponse>(`/v2/summary/activity/${userId}?${range}`).catch(
      () => ({ activity: [] }) as ActivityResponse,
    ),
  ]);

  const sleepRecs = sleepResp.sleep ?? sleepResp.data ?? [];
  const actRecs = actResp.activity ?? actResp.data ?? [];

  const sleep = sleepRecs
    .map((r) => {
      const date = dayKey(r);
      if (date === null) return null;
      const rec = r as SleepRecord & {
        duration?: number;
        total_sleep_seconds?: number;
      };
      const secs = rec.total_sleep_seconds ?? rec.duration ?? null;
      return {
        date,
        score: recScore(r),
        hours:
          typeof secs === "number" ? Math.round((secs / 3600) * 10) / 10 : null,
      };
    })
    .filter(
      (x): x is { date: string; score: number | null; hours: number | null } =>
        x !== null,
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const activity = actRecs
    .map((r) => {
      const date =
        r.calendar_date?.slice(0, 10) ?? r.date?.slice(0, 10) ?? null;
      if (date === null) return null;
      return { date, steps: typeof r.steps === "number" ? r.steps : null };
    })
    .filter((x): x is { date: string; steps: number | null } => x !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return { sleep, activity };
}
