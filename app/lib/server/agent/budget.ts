// SPOTTER's spending ceiling: a GLOBAL daily cap and a PER-WALLET daily cap.
//
// WHY THIS EXISTS. The per-claim cap frozen into the plan (ledger.ts) is scoped
// to one goalId, so a fresh goalId is a fresh budget. Nothing above it bounded
// total spend: a wallet that keeps opening claims could walk the agent's
// verification budget to zero one capped claim at a time. These two caps are
// what make the agent's wallet un-drainable by volume - Circle's guardrail
// criterion in one file.
//
// The counters are day-bucketed (UTC) integer cent totals in the same Redis
// the locks use, incremented ATOMICALLY with INCRBY before any money moves and
// rolled back when the purchase does not happen. Read-modify-write over the
// JSON store would lose increments under exactly the concurrency this defends
// against, which is why this does not go through store.ts.
//
// RESERVE THEN RECONCILE. The estimate is committed before pay(), because a
// check that runs after settlement cannot stop anything. Once the purchase
// returns, the reservation is corrected to the amount actually charged
// (reconcileDailySpend); if the purchase never happened the reservation is
// released. A purchase that throws mid-flight is ambiguous - the reservation is
// released there too, on the grounds that the ledger, not this counter, is the
// record of what was spent, and the spend-intent marker in run.ts is what stops
// an immediate re-buy.
//
// LOCAL / TESTS. With no Redis env this degrades to process-local counters:
// correct for one long-lived process, reset on restart, and documented as such.

import { optionalEnv } from "@/lib/server/env";
import { agentRedis } from "@/lib/server/agent/lock";

/** Total the agent may spend on verification across every claim, per UTC day. */
export const DEFAULT_DAILY_CAP_USD = "5.00";
/** Total the agent may spend on any ONE participant's claims, per UTC day. */
export const DEFAULT_WALLET_DAILY_CAP_USD = "1.00";

const KEY_PREFIX = "gohealthme:agent-budget:";
/** Two days, so a bucket outlives its day for late reconciliation and then
 *  disappears on its own. Nothing reads yesterday's total. */
const BUCKET_TTL_SECONDS = 172_800;

export interface SpendReservation {
  /** Cents committed, so a release cannot be fooled by a re-parsed string. */
  cents: number;
  walletKey: string;
  day: string;
}

export type BudgetOutcome =
  | { ok: true; reservation: SpendReservation }
  | { ok: false; message: string };

export interface SpendRequest {
  amountUsd: string;
  /** Whose claim this purchase serves - the participant address. Lower-cased
   *  into the key so address casing cannot mint a second budget. */
  walletKey: string;
  /** Marketplace service name, used only to make the refusal readable. */
  service: string;
}

export function dailyCapUsd(): string {
  return optionalEnv("AGENT_DAILY_CAP_USD", DEFAULT_DAILY_CAP_USD);
}

export function walletDailyCapUsd(): string {
  return optionalEnv("AGENT_WALLET_DAILY_CAP_USD", DEFAULT_WALLET_DAILY_CAP_USD);
}

/** Whole-cent USD parsing, identical in shape to x402.usdCents: a malformed
 *  amount throws rather than slipping past a cap as zero. */
function usdToCents(amount: string, context: string): number {
  if (!/^\d+\.\d{2}$/.test(amount)) {
    throw new Error(
      `${context}: amount ${JSON.stringify(amount)} must be a USD string with exactly two decimals`,
    );
  }
  const [dollars, cents] = amount.split(".");
  return Number(dollars) * 100 + Number(cents);
}

function centsToUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** UTC day bucket. UTC, not local: a Vercel lambda has no stable local zone,
 *  and a cap that shifts with the region is not a cap. */
export function budgetDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function globalKey(day: string): string {
  return `${KEY_PREFIX}${day}`;
}

function walletKeyFor(day: string, wallet: string): string {
  return `${KEY_PREFIX}${day}:${wallet.toLowerCase()}`;
}

// ------------------------------------------------------ process-local counters

const localCounters = new Map<string, number>();

/** Tests only. Redis buckets expire on their own and are never bulk-cleared. */
export function resetLocalBudgetState(): void {
  localCounters.clear();
}

async function addCents(key: string, delta: number): Promise<number> {
  const client = agentRedis();
  if (client === null) {
    const next = (localCounters.get(key) ?? 0) + delta;
    localCounters.set(key, next);
    return next;
  }
  const next = await client.incrby(key, delta);
  // Refreshing the TTL on every write keeps an active day alive; an idle
  // bucket ages out. expire() failing is not worth failing a purchase over.
  try {
    await client.expire(key, BUCKET_TTL_SECONDS);
  } catch {
    // The bucket keeps its previous TTL, or none. Harmless either way.
  }
  return next;
}

/**
 * Move a counter, best effort.
 *
 * Used for every correction after the decision to spend has been made -
 * rollbacks, releases, reconciliations. A correction that throws would replace
 * a recoverable accounting slip with a lost refusal message or a failed
 * purchase that actually succeeded, so the failure is logged loudly and
 * swallowed. The day bucket expires on its own, which bounds how long a slip
 * can last.
 */
async function adjustCents(key: string, delta: number): Promise<void> {
  try {
    await addCents(key, delta);
  } catch (err) {
    console.error(
      `[agent/budget] could not adjust ${key} by ${delta} cents; today's ` +
        `total is off until the bucket expires: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}

async function readCents(key: string): Promise<number> {
  const client = agentRedis();
  if (client === null) return localCounters.get(key) ?? 0;
  const raw = await client.get<number | string | null>(key);
  if (raw === null || raw === undefined) return 0;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Commit `amountUsd` against both caps before the purchase runs.
 *
 * Both counters are incremented first and rolled back on refusal, which is the
 * only ordering that is safe under concurrency: checking then incrementing lets
 * two lambdas both read a total under the cap and both spend past it.
 */
export async function reserveDailySpend(
  request: SpendRequest,
): Promise<BudgetOutcome> {
  const cents = usdToCents(request.amountUsd, "reserveDailySpend");
  const day = budgetDay();
  const gKey = globalKey(day);
  const wKey = walletKeyFor(day, request.walletKey);
  const globalCap = usdToCents(dailyCapUsd(), "AGENT_DAILY_CAP_USD");
  const walletCap = usdToCents(
    walletDailyCapUsd(),
    "AGENT_WALLET_DAILY_CAP_USD",
  );

  const globalAfter = await addCents(gKey, cents);
  if (globalAfter > globalCap) {
    await adjustCents(gKey, -cents);
    return {
      ok: false,
      message:
        `SPOTTER's daily spend cap of ${centsToUsd(globalCap)} USDC stops this ` +
        `purchase: buying ${request.service} at ${request.amountUsd} USDC would ` +
        `take today's total to ${centsToUsd(globalAfter)} USDC. The claim is ` +
        "not verified and nobody is paid; the cap resets at 00:00 UTC.",
    };
  }

  // The global counter is already committed. If this second increment fails,
  // that commitment has to come back off or the day's total permanently counts
  // a purchase that never happened, and SPOTTER eventually reports itself out
  // of budget for spending it never did.
  let walletAfter: number;
  try {
    walletAfter = await addCents(wKey, cents);
  } catch (err) {
    await adjustCents(gKey, -cents);
    throw err;
  }
  if (walletAfter > walletCap) {
    await adjustCents(wKey, -cents);
    await adjustCents(gKey, -cents);
    return {
      ok: false,
      message:
        `SPOTTER's per-wallet daily spend cap of ${centsToUsd(walletCap)} USDC ` +
        `stops this purchase: buying ${request.service} at ${request.amountUsd} ` +
        `USDC would take this wallet's spend today to ${centsToUsd(walletAfter)} ` +
        "USDC. The claim is not verified and nobody is paid; the cap resets at " +
        "00:00 UTC.",
    };
  }

  return {
    ok: true,
    reservation: { cents, walletKey: request.walletKey, day },
  };
}

/**
 * Give the reservation back: the purchase did not happen.
 *
 * Best effort on both counters, and deliberately so - this runs on paths that
 * are already reporting a refusal (an intent marker held, a purchase that
 * threw), and letting a counter write throw there would swap a clear message
 * for an opaque 500. Both sides are always attempted, never one.
 */
export async function releaseDailySpend(
  reservation: SpendReservation,
): Promise<void> {
  if (reservation.cents === 0) return;
  await adjustCents(globalKey(reservation.day), -reservation.cents);
  await adjustCents(
    walletKeyFor(reservation.day, reservation.walletKey),
    -reservation.cents,
  );
}

/**
 * Correct a reservation to what was actually charged. A service that came in
 * over its estimate is recorded at the real figure - the daily total must never
 * understate what left the wallet, even when the overage is the thing that
 * breaks the per-claim cap.
 */
export async function reconcileDailySpend(
  reservation: SpendReservation,
  actualUsd: string,
): Promise<void> {
  const actual = usdToCents(actualUsd, "reconcileDailySpend");
  const delta = actual - reservation.cents;
  if (delta === 0) return;
  // Best effort, and both sides always attempted: this runs AFTER the money
  // moved and after the ledger row landed, so throwing here would fail a
  // purchase that actually succeeded. The ledger, not this counter, is the
  // record of what was spent.
  await adjustCents(globalKey(reservation.day), delta);
  await adjustCents(walletKeyFor(reservation.day, reservation.walletKey), delta);
}

/** Committed spend so far today, two decimals. Observability and tests. */
export async function dailySpentUsd(walletKey?: string): Promise<string> {
  const day = budgetDay();
  const key =
    walletKey === undefined ? globalKey(day) : walletKeyFor(day, walletKey);
  return centsToUsd(await readCents(key));
}
