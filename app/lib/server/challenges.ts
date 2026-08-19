// Read and write GoHealthMe peer challenges in Supabase.
//
// Unlike profiles, this table has NO public read policy. Both reads and writes
// go through the service-role client:
//   - WRITES are only ever called after the route has verified an EIP-191
//     signature proving the caller controls challenger_address AND that the
//     same address is the on-chain creator of pool_id. This module assumes the
//     route enforced that; it does not re-check the signature.
//   - READS are token-gated: getChallengeByToken filters by the EXACT invite
//     token. The token is the capability. Because there is no anon policy, a
//     public key cannot enumerate the table even though it is public - the only
//     way to reach a row is to already hold its token.
//
// A challenge row is a pool id, who created it, an unguessable token, and the
// challenger's framing text. There is NO health column anywhere: the goal
// ("lose 10 lbs") lives on-chain in the pool goalSpec and is read live from the
// chain by the landing, never copied here.

import { getSupabaseServiceRole } from "@/lib/server/supabase";
import {
  checkMessage,
  checkTargetHandle,
  generateInviteToken,
  isValidInviteToken,
} from "@/lib/challenges";
import { normalizeAddress } from "@/lib/social";

const CHALLENGES_TABLE = "challenges";

/** How many times to retry on the astronomically unlikely token collision. */
const TOKEN_COLLISION_RETRIES = 3;

export interface Challenge {
  inviteToken: string;
  poolId: string; // decimal string; bigint does not survive JSON
  challengerAddress: string; // lowercased 0x hex
  targetHandle: string | null;
  message: string | null;
  createdAt: string;
}

interface ChallengeRow {
  invite_token: string;
  pool_id: number | string;
  challenger_address: string;
  target_handle: string | null;
  message: string | null;
  created_at: string;
}

function rowToChallenge(row: ChallengeRow): Challenge {
  return {
    inviteToken: row.invite_token,
    // Supabase returns bigint as a number or string depending on size; coerce
    // through String so a huge pool id never loses precision on the wire.
    poolId: String(row.pool_id),
    challengerAddress: row.challenger_address,
    targetHandle: row.target_handle,
    message: row.message,
    createdAt: row.created_at,
  };
}

/**
 * The challenge behind an invite token, or null when the token is malformed,
 * unknown, or Supabase is not configured. Token-gated: only an exact-token
 * match returns a row, so possession of the token is what grants the read.
 */
export async function getChallengeByToken(
  rawToken: string,
): Promise<Challenge | null> {
  if (!isValidInviteToken(rawToken)) return null;
  const supabase = getSupabaseServiceRole();
  if (supabase === null) return null;

  const { data, error } = await supabase
    .from(CHALLENGES_TABLE)
    .select("invite_token, pool_id, challenger_address, target_handle, message, created_at")
    .eq("invite_token", rawToken)
    .maybeSingle<ChallengeRow>();

  if (error !== null || data === null) return null;
  return rowToChallenge(data);
}

export type CreateChallengeResult =
  | { ok: true; challenge: Challenge }
  | { ok: false; status: number; reason: string };

/**
 * Create the one challenge row for a pool. The caller MUST already have proven
 * (a) control of `rawChallengerAddress` with a wallet signature and (b) that
 * this address is the pool's on-chain creator - this function trusts its route
 * for both and only validates and writes.
 *
 * The invite token is minted here from crypto-random bytes, retried on the
 * (near-impossible) unique-token collision. A second challenge for the same
 * pool trips the unique(pool_id) constraint and comes back as a conflict.
 */
export async function createChallenge(params: {
  rawChallengerAddress: string;
  poolId: bigint;
  rawTargetHandle: string | null | undefined;
  rawMessage: string | null | undefined;
}): Promise<CreateChallengeResult> {
  const challengerAddress = normalizeAddress(params.rawChallengerAddress);
  if (challengerAddress === null) {
    return { ok: false, status: 400, reason: "That is not a valid address." };
  }
  if (params.poolId <= 0n) {
    return { ok: false, status: 400, reason: "That is not a valid pool id." };
  }
  const messageCheck = checkMessage(params.rawMessage);
  if (!messageCheck.ok) {
    return { ok: false, status: 400, reason: messageCheck.reason };
  }
  const targetCheck = checkTargetHandle(params.rawTargetHandle);
  if (!targetCheck.ok) {
    return { ok: false, status: 400, reason: targetCheck.reason };
  }

  const supabase = getSupabaseServiceRole();
  if (supabase === null) {
    return {
      ok: false,
      status: 503,
      reason: "Challenges are not configured on this deployment.",
    };
  }

  // pool_id is written as a decimal string so a value beyond 2^53 is not
  // rounded on the way into the bigint column.
  const poolIdText = params.poolId.toString();

  for (let attempt = 0; attempt < TOKEN_COLLISION_RETRIES; attempt++) {
    const inviteToken = generateInviteToken();
    const { data, error } = await supabase
      .from(CHALLENGES_TABLE)
      .insert({
        invite_token: inviteToken,
        pool_id: poolIdText,
        challenger_address: challengerAddress,
        target_handle: targetCheck.targetHandle,
        message: messageCheck.message,
      })
      .select("invite_token, pool_id, challenger_address, target_handle, message, created_at")
      .maybeSingle<ChallengeRow>();

    if (error === null && data !== null) {
      return { ok: true, challenge: rowToChallenge(data) };
    }

    if (error !== null && error.code === "23505") {
      // Unique violation. Two constraints can trip it:
      //   - pool_id: a challenge already exists for this pool -> conflict, do
      //     not retry (a fresh token would still collide on pool_id).
      //   - invite_token: retry with a new token.
      const message = (error.message ?? "").toLowerCase();
      if (message.includes("pool_id")) {
        return {
          ok: false,
          status: 409,
          reason: "A challenge already exists for this pool.",
        };
      }
      // Otherwise assume a token collision and loop to mint a new one.
      continue;
    }

    // Any other error is terminal.
    return {
      ok: false,
      status: 500,
      reason: "Could not create the challenge. Try again.",
    };
  }

  return {
    ok: false,
    status: 500,
    reason: "Could not create the challenge. Try again.",
  };
}
