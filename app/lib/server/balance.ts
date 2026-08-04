// GoHealthMe balance ledger (server-side).
//
// A per-address uUSDC balance. uUSDC means integer micro-USDC with 6 decimals:
// 2 USDC == 2_000_000n.
//
// Flow this backs:
//   - A confirmed Blink top-up on Base Sepolia credits the address here.
//   - Joining/funding/backing a pool later debits this balance while the Arc
//     treasury sponsors the on-chain tx (that integration lives elsewhere).
//
// STORAGE, AND WHY IT CHANGED
// This used to be one JSON blob holding EVERY user, read-modify-written on
// every mutation. Two unrelated users topping up at the same time lost one of
// the credits, and two withdrawals for the same user could both read the same
// balance, both pass the "enough funds" check, and both send treasury USDC.
// Now each address owns a Redis hash for its amount and a Redis set for the
// refs it has applied, and every mutation is one atomic operation:
//   - credit: claim the ref and add, in one operation.
//   - debit:  claim the ref, check the funds and deduct, in one operation.
//     The check has to BE the deduction - read-then-check is exactly the
//     overdraw described above - and the ref claim has to ride along with it,
//     or a failure between the two burns the ref while the money never moves
//     and every retry then reports the transfer as already processed.
// Unrelated addresses no longer contend at all.
//
// Idempotency: credit and debit are keyed by a ref (the Blink tx hash for a
// credit). A ref is applied at most once per address, so retried webhooks or
// double-clicks never double-count.
//
// Balances written before this change live in the balances.json blob and are
// migrated into the per-address keys on first touch, under a lock, exactly
// once - losing a top-up would be losing real money.
//
// TODO post-hackathon: verify the Base Sepolia tx receipt before crediting.

import type { Address } from "viem";
import {
  applyCounterDelta,
  existsKey,
  hgetInt,
  readJson,
  sadd,
  setNx,
  withLock,
} from "@/lib/server/store";

const LEGACY_BALANCE_FILE = "balances.json";
const BALANCE_FIELD = "uusdc";
const MIGRATION_LOCK_TTL_MS = 10_000;

// Idempotency ref for carrying a pre-migration balance over. Namespaced so it
// can never collide with a Blink tx hash or a withdrawal ref.
const LEGACY_MIGRATION_REF = "gohealthme:legacy-balance-migration";

interface LegacyAddressEntry {
  // Stringified bigint of the current uUSDC balance.
  balanceUusdc: string;
  // Refs already applied to this address (credit or debit), for idempotency.
  applied: string[];
}

// Map of lowercased address -> entry.
type LegacyBalanceStore = Record<string, LegacyAddressEntry>;

export interface BalanceMutation {
  balanceUusdc: bigint;
  applied: boolean;
}

function key(address: Address): string {
  return address.toLowerCase();
}

function balanceKey(address: Address): string {
  return `balance:${key(address)}`;
}

function appliedKey(address: Address): string {
  return `balance-applied:${key(address)}`;
}

function migratedKey(address: Address): string {
  return `balance-migrated:${key(address)}`;
}

function assertPositiveAmount(amountUusdc: bigint): void {
  if (amountUusdc <= 0n) {
    throw new Error("amountUusdc must be a positive integer");
  }
}

function assertRef(ref: string): void {
  if (ref.trim() === "") {
    throw new Error("ref must be a non-empty string");
  }
}

/** The counter is a 64-bit integer server-side; refuse anything that would
 *  lose precision on the way in rather than silently rounding money. */
function toCounterDelta(amountUusdc: bigint): number {
  if (amountUusdc > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `amountUusdc ${amountUusdc.toString()} exceeds the balance counter range`,
    );
  }
  return Number(amountUusdc);
}

// Migration is one-way, so a process that has done it once can skip the
// round trip for the rest of its life.
const migratedInThisProcess = new Set<string>();

// Nothing writes the legacy blob any more, so one read per process is enough.
// A rejected read is not cached, or a single blip would poison every later
// balance call in this instance.
let legacyStorePromise: Promise<LegacyBalanceStore> | null = null;

function legacyStore(): Promise<LegacyBalanceStore> {
  legacyStorePromise ??= readJson<LegacyBalanceStore>(
    LEGACY_BALANCE_FILE,
    {},
  ).catch((err: unknown) => {
    legacyStorePromise = null;
    throw err;
  });
  return legacyStorePromise;
}

async function ensureMigrated(address: Address): Promise<void> {
  const marker = migratedKey(address);
  if (migratedInThisProcess.has(marker)) return;

  // Addresses with nothing to carry over - which is every address created
  // after this change - skip the lock and never get a marker key.
  if ((await legacyStore())[key(address)] === undefined) {
    migratedInThisProcess.add(marker);
    return;
  }

  if (await existsKey(marker)) {
    migratedInThisProcess.add(marker);
    return;
  }

  await withLock(`balance-migrate:${key(address)}`, MIGRATION_LOCK_TTL_MS, async () => {
    // Re-check inside the lock: crediting the legacy balance twice would mint
    // money out of nothing.
    if (await existsKey(marker)) return;

    const entry = (await legacyStore())[key(address)];
    if (entry !== undefined) {
      // Refs first: they are the record of what was already applied, and SADD
      // is idempotent, so replaying this step can never move money.
      if (entry.applied.length > 0) {
        await sadd(appliedKey(address), ...entry.applied);
      }
      const amount = BigInt(entry.balanceUusdc);
      if (amount > 0n) {
        // Carried over under its own ref rather than a bare increment. The
        // marker below is only an optimisation: if the process dies before it
        // is written, this runs again and the ref makes it a no-op instead of
        // crediting the legacy balance a second time.
        await applyCounterDelta({
          counterKey: balanceKey(address),
          field: BALANCE_FIELD,
          refsKey: appliedKey(address),
          ref: LEGACY_MIGRATION_REF,
          delta: toCounterDelta(amount),
          requireAvailable: false,
        });
      }
    }
    await setNx(marker, new Date().toISOString());
  });

  migratedInThisProcess.add(marker);
}

async function currentBalance(address: Address): Promise<bigint> {
  return BigInt(await hgetInt(balanceKey(address), BALANCE_FIELD));
}

/**
 * Current balance for an address in uUSDC. Returns 0n when the address has no
 * ledger entry.
 */
export async function getBalance(address: Address): Promise<bigint> {
  await ensureMigrated(address);
  return currentBalance(address);
}

/**
 * Credit an address by amountUusdc, idempotent by ref. If the ref was already
 * applied to this address, the balance is unchanged and applied is false.
 */
export async function credit(
  address: Address,
  amountUusdc: bigint,
  ref: string,
): Promise<BalanceMutation> {
  assertPositiveAmount(amountUusdc);
  assertRef(ref);
  await ensureMigrated(address);

  // Claiming the ref and adding the money is one operation. Split in two, a
  // failure between them commits the ref without the credit, and every retry
  // then reports the top-up as already applied while the money is gone.
  const result = await applyCounterDelta({
    counterKey: balanceKey(address),
    field: BALANCE_FIELD,
    refsKey: appliedKey(address),
    ref,
    delta: toCounterDelta(amountUusdc),
    requireAvailable: false,
  });

  return {
    balanceUusdc: BigInt(result.value),
    applied: result.status === "applied",
  };
}

/**
 * Debit an address by amountUusdc, idempotent by ref. Throws when the balance
 * is insufficient. If the ref was already applied, the balance is unchanged and
 * applied is false.
 */
export async function debit(
  address: Address,
  amountUusdc: bigint,
  ref: string,
): Promise<BalanceMutation> {
  assertPositiveAmount(amountUusdc);
  assertRef(ref);
  await ensureMigrated(address);

  // Ref claim, funds check and deduction are one operation. Anything less and
  // a failure between the steps either overdraws the treasury or burns the
  // ref, which makes a withdrawal that never happened look already processed.
  const result = await applyCounterDelta({
    counterKey: balanceKey(address),
    field: BALANCE_FIELD,
    refsKey: appliedKey(address),
    ref,
    delta: -toCounterDelta(amountUusdc),
    requireAvailable: true,
  });

  if (result.status === "insufficient") {
    // The ref was released, so the same move works after a top-up.
    throw new Error(
      `Insufficient balance: have ${result.value} uUSDC, need ${amountUusdc.toString()} uUSDC`,
    );
  }

  return {
    balanceUusdc: BigInt(result.value),
    applied: result.status === "applied",
  };
}
