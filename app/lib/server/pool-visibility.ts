// User-owned, MUTABLE public/private visibility for an on-chain pool.
//
// On-chain EVERY pool is public. "Private" is an app-layer choice: the pool is
// unlisted (kept off the public /pools board and the Payout Feed) and its
// /pools/[id] detail is gated to strangers, reachable only by an unguessable
// link. The on-chain `initiative` is immutable, so it can only be the DEFAULT,
// never the source of truth for a setting the owner can flip. The truth lives
// in the Supabase pool_visibility table (project lynhrbkspjsmqzywfhht):
//   pool_id       bigint unique  the on-chain pool this row governs
//   owner_address text           lowercased 0x, the pool creator
//   visibility    text           'public' | 'private'  (the mutable flag)
//   share_token   text nullable  unguessable [A-Za-z0-9_-]{32,64} bearer link
//
// RESOLUTION ORDER (privacy-first, mirrors challenge-pool.ts's fail-closed
// posture). A public payout wrongly withheld is invisible; a private one
// wrongly shown is a leak, so every uncertainty resolves to PRIVATE:
//   1. Store row present -> its visibility wins. Authoritative and mutable;
//      this is what makes the owner toggle work in both directions.
//   2. No row -> the initiative default: initiative "challenge" -> private,
//      anything else -> public. isChallengePool() supplies this and itself
//      fails closed (an unreadable pool reads as a challenge -> private).
//   3. Store read error -> fail-safe private, NOT cached, self-heals next
//      request. resolvePoolVisibility never throws for this reason;
//      resolvePoolVisibilities DOES propagate a genuine store error so a list
//      surface can 500 (and show an error) rather than render a fake board.
//
// share_token is NEVER returned by the resolver - it only emits the enum. The
// token is read solely by the token-gated /p/[token] landing via
// getPoolByShareToken. NO health data lives here: the goal is on-chain in the
// pool goalSpec, never copied into this table.

import { isChallengePool } from "@/lib/server/challenge-pool";
import { getSupabaseServiceRole } from "@/lib/server/supabase";
import {
  generateInviteToken,
  isValidInviteToken,
} from "@/lib/challenges";
import { normalizeAddress } from "@/lib/social";

export type PoolVisibility = "public" | "private";

const VISIBILITY_TABLE = "pool_visibility";

/** Retries on the astronomically unlikely share-token collision. */
const TOKEN_COLLISION_RETRIES = 3;

/** Only decimal pool ids ever reach the bigint column; anything else is
 *  skipped before it becomes a query (a non-numeric id would error the cast). */
function isNumericId(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

/** Coerce a stored value into the enum, or null when it is neither. */
export function normalizeVisibility(
  raw: string | null | undefined,
): PoolVisibility | null {
  return raw === "public" || raw === "private" ? raw : null;
}

/** The default visibility implied by a pool's immutable on-chain initiative:
 *  a challenge is a person-aimed dare (private); everything else is public.
 *  This is the canonical, unit-tested statement of the default rule;
 *  initiativeDefault() below is the cached, fail-closed runtime reader that
 *  encodes the same rule through isChallengePool. */
export function defaultVisibilityForInitiative(
  initiative: string,
): PoolVisibility {
  return initiative === "challenge" ? "private" : "public";
}

/**
 * Read the stored visibility for a set of pool ids in ONE query. Returns a map
 * containing only the ids that HAVE a row (with a valid enum value); ids with
 * no row are simply absent, and the caller falls back to the initiative
 * default. Returns an empty map when Supabase is unconfigured. THROWS on a
 * genuine query error so batch callers can distinguish "no rows" from "store
 * is down" - the single-pool resolver catches that throw and fails safe.
 */
async function readVisibilityRows(
  poolIds: string[],
): Promise<Map<string, PoolVisibility>> {
  const map = new Map<string, PoolVisibility>();
  const valid = poolIds.filter(isNumericId);
  if (valid.length === 0) return map;

  const supabase = getSupabaseServiceRole();
  if (supabase === null) return map;

  const { data, error } = await supabase
    .from(VISIBILITY_TABLE)
    .select("pool_id, visibility")
    .in("pool_id", valid);
  if (error !== null) {
    throw new Error(`pool_visibility read failed: ${error.message}`);
  }

  for (const row of (data ?? []) as {
    pool_id: number | string;
    visibility: string;
  }[]) {
    const v = normalizeVisibility(row.visibility);
    if (v !== null) map.set(String(row.pool_id), v);
  }
  return map;
}

/** The initiative default for one pool. isChallengePool fails closed (true, so
 *  private) on an unreadable pool, so an unknown pool is treated as private. */
async function initiativeDefault(poolId: string): Promise<PoolVisibility> {
  return (await isChallengePool(poolId)) ? "private" : "public";
}

/**
 * The effective visibility of one pool: store row first, else the initiative
 * default, else (any store error) fail-safe private. Never throws - every
 * surface that calls this (pool detail SSR, generateMetadata) is safe to hide
 * on doubt, and hiding a real public pool during a store outage is preferable
 * to leaking a private dare.
 */
export async function resolvePoolVisibility(
  poolId: string,
): Promise<PoolVisibility> {
  let rows: Map<string, PoolVisibility>;
  try {
    rows = await readVisibilityRows([poolId]);
  } catch {
    return "private";
  }
  const stored = rows.get(poolId);
  if (stored !== undefined) return stored;
  return initiativeDefault(poolId);
}

/**
 * The effective visibility of many pools, resolved with one store query.
 * Propagates a genuine store error to the caller (the batch route turns it into
 * a 500 so the /pools board shows an error rather than a fake-empty list). Ids
 * without a stored row fall back to the initiative default, which never throws.
 */
export async function resolvePoolVisibilities(
  poolIds: string[],
): Promise<Map<string, PoolVisibility>> {
  const out = new Map<string, PoolVisibility>();
  const unique = Array.from(new Set(poolIds));
  if (unique.length === 0) return out;

  const rows = await readVisibilityRows(unique);
  await Promise.all(
    unique.map(async (poolId) => {
      const stored = rows.get(poolId);
      out.set(poolId, stored ?? (await initiativeDefault(poolId)));
    }),
  );
  return out;
}

export interface PoolByShareToken {
  poolId: string;
  visibility: PoolVisibility;
}

/**
 * The pool behind a private share token, or null when the token is malformed,
 * unknown, or Supabase is not configured. Token-gated: only an exact-token
 * match returns a row, so possession of the unguessable token grants the read.
 * Mirrors getChallengeByToken - the token is the capability.
 */
export async function getPoolByShareToken(
  rawToken: string,
): Promise<PoolByShareToken | null> {
  if (!isValidInviteToken(rawToken)) return null;
  const supabase = getSupabaseServiceRole();
  if (supabase === null) return null;

  const { data, error } = await supabase
    .from(VISIBILITY_TABLE)
    .select("pool_id, visibility")
    .eq("share_token", rawToken)
    .maybeSingle<{ pool_id: number | string; visibility: string }>();
  if (error !== null || data === null) return null;

  const visibility = normalizeVisibility(data.visibility);
  if (visibility === null) return null;
  return { poolId: String(data.pool_id), visibility };
}

export type SetVisibilityResult =
  | { ok: true; visibility: PoolVisibility; shareToken: string | null }
  | { ok: false; status: number; reason: string };

/**
 * Write a pool's visibility. The caller MUST already have proven (a) control of
 * ownerAddress with a wallet signature and (b) that this address is the pool's
 * on-chain creator - this function trusts its route for both, exactly as
 * createChallenge does, and only validates and writes.
 *
 * A private pool needs an unguessable link, so a share token is minted the
 * first time it goes private and preserved thereafter (so a public<->private
 * flip keeps one stable link). The row is upserted on the unique pool_id.
 */
export async function setPoolVisibility(params: {
  poolId: bigint;
  ownerAddress: string;
  visibility: PoolVisibility;
}): Promise<SetVisibilityResult> {
  const owner = normalizeAddress(params.ownerAddress);
  if (owner === null) {
    return { ok: false, status: 400, reason: "That is not a valid address." };
  }
  if (params.poolId <= 0n) {
    return { ok: false, status: 400, reason: "That is not a valid pool id." };
  }

  const supabase = getSupabaseServiceRole();
  if (supabase === null) {
    return {
      ok: false,
      status: 503,
      reason: "Pool visibility is not configured on this deployment.",
    };
  }

  const poolIdText = params.poolId.toString();
  const nowIso = new Date().toISOString();

  // Reuse an existing share token so a pool keeps one stable private link
  // across public<->private flips.
  const { data: existing, error: readErr } = await supabase
    .from(VISIBILITY_TABLE)
    .select("share_token")
    .eq("pool_id", poolIdText)
    .maybeSingle<{ share_token: string | null }>();
  if (readErr !== null) {
    return {
      ok: false,
      status: 500,
      reason: "Could not read the current visibility. Try again.",
    };
  }
  const existingToken = existing?.share_token ?? null;

  const writeRow = async (
    shareToken: string | null,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> => {
    const { error } = await supabase
      .from(VISIBILITY_TABLE)
      .upsert(
        {
          pool_id: poolIdText,
          owner_address: owner,
          visibility: params.visibility,
          share_token: shareToken,
          updated_at: nowIso,
        },
        { onConflict: "pool_id" },
      );
    if (error === null) return { ok: true };
    return { ok: false, code: error.code ?? "", message: error.message ?? "" };
  };

  // A private pool with no token yet gets a fresh one, retried on the
  // near-impossible unique-token collision. Every other case reuses the token
  // it already has (or null for a public pool that never had one).
  if (params.visibility === "private" && existingToken === null) {
    for (let attempt = 0; attempt < TOKEN_COLLISION_RETRIES; attempt++) {
      const token = generateInviteToken();
      const result = await writeRow(token);
      if (result.ok) {
        return { ok: true, visibility: "private", shareToken: token };
      }
      if (
        result.code === "23505" &&
        result.message.toLowerCase().includes("share_token")
      ) {
        continue;
      }
      return {
        ok: false,
        status: 500,
        reason: "Could not update visibility. Try again.",
      };
    }
    return {
      ok: false,
      status: 500,
      reason: "Could not update visibility. Try again.",
    };
  }

  const result = await writeRow(existingToken);
  if (!result.ok) {
    return {
      ok: false,
      status: 500,
      reason: "Could not update visibility. Try again.",
    };
  }
  return {
    ok: true,
    visibility: params.visibility,
    shareToken: existingToken,
  };
}
