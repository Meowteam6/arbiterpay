// HealthVerdict registry writer (server only) — Tier 1.
//
// In addition to recording the result on HealthPools (oracle.recordResult), the
// oracle writes the verdict into the HealthVerdict registry so HealthPools.settle
// can gate on canSettle(goalId). Same oracle key — it is the registry's
// authorized attester.
//
// The `digest` here is an ADVISORY content hash of the attester inference id: the
// poll-based live path (judge.ts) does not return the DON-signed inference digest
// — that is the CRE / onReport path (Tier 2). canSettle ignores the digest; it
// gates only on verified + confidence. No raw health data is hashed or stored.

import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcPublicClient,
  arcWalletClient,
  ttlCache,
} from "@/lib/server/arc-client";
import { optionalEnv, requireEnv } from "@/lib/server/env";
import type { Confidence } from "@/lib/server/judge";
import {
  isRetryableExternalError,
  withRetry,
  DEFAULT_BACKOFF_MS,
} from "@/lib/server/retry";

const HEALTH_VERDICT_ABI = [
  {
    type: "function",
    name: "recordVerdict",
    stateMutability: "nonpayable",
    inputs: [
      { name: "goalId", type: "bytes32" },
      { name: "verified", type: "bool" },
      { name: "confidence", type: "uint8" },
      { name: "digest", type: "bytes32" },
      { name: "bitmap", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

// Facet bits mirror HealthVerdict.sol FACET_* constants. Bit1 (World ID) is
// intentionally never set: entry is one wallet, one entry, enforced by the
// pool contract, and no proof-of-humanity check runs anymore. Writing the bit
// would be a false provenance claim.
const FACET_WEARABLE = 1 << 0; // bit0: wearable/device data verified
const FACET_AI_ATTESTED = 1 << 2; // bit2: AI attested (TEE inference)

/**
 * What actually backed a verdict. The bitmap is the on-chain provenance record,
 * so it has to describe the evidence that was really used — tagging a
 * deterministic wearable streak check as AI-attested would write a false claim
 * to the chain, where anyone can read it back.
 */
export const VERDICT_FACETS = {
  /** Document judged by the Confidential AI attester (TEE inference). */
  document: FACET_AI_ATTESTED,
  /** Wearable streak checked against Junction provider data. No AI involved. */
  wearable: FACET_WEARABLE,
  /**
   * Self-reported photo/screenshot: asserts NO trust facet, so the on-chain
   * bitmap is 0. A self-reported claim MUST NOT set FACET_AI_ATTESTED even
   * though the TEE reads the image, because the trust claim is not "AI read
   * it" but "we verified it is real, recent, and theirs" — which self-reported
   * evidence cannot support. bitmap 0 is legal (0 & ~FACET_MASK == 0), needs no
   * redeploy, and is the honest on-chain representation of the low-trust tier.
   * The distinguishable tier itself is carried off-chain by the ledger verdict
   * entry's `selfReported` flag, where the receipt and feed read it.
   */
  "self-reported": 0,
} as const;

const CONFIDENCE_U8: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * The on-chain provenance digest (Tier C): keccak256 over ONLY public routing
 * scalars the contract already stores in plaintext (goalId, verified,
 * confidence). It commits nothing derived from the health document — no output
 * prose, no transcript hash — so the permanent public ledger cannot become an
 * unsalted commitment to health-derived content. A third party recomputes this
 * exact value to tie an on-chain record to a goal (verify-chain). The enclave's
 * off-chain signature separately binds the full transcript via keccak256(output);
 * that hash stays off-chain, where the output already appears.
 */
export function verdictDigest(
  goalId: Hex,
  verified: boolean,
  confidence: Confidence,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bool" }, { type: "uint8" }],
      [goalId, verified, CONFIDENCE_U8[confidence]],
    ),
  );
}

/** Attempts for a chain call before giving up and surfacing the failure. */
const RECORD_ATTEMPTS = 3;
/** Backoff before attempts 2 and 3. Keeps the polling endpoint responsive. */
const RETRY_BACKOFF_MS = DEFAULT_BACKOFF_MS;

/**
 * Wall-clock ceilings for the retry sequences below.
 *
 * The Arc transport already falls back across three endpoints with its own
 * timeout, so a single read can take tens of seconds during a full outage.
 * Multiplying that by an attempt count overruns the 60s maxDuration on the
 * routes that call this (app/api/agent/run/[goalId], app/api/agent/sweep) and
 * the platform kills the request without surfacing any error. These budgets
 * collapse the retry to a single attempt when the chain is slow, while still
 * allowing the full three attempts when failures are fast — a rate-limited
 * endpoint answering 429 immediately, which is what the retry is really for.
 */
const READ_DEADLINE_MS = 15_000;
const WRITE_DEADLINE_MS = 35_000;

function oracleAccount() {
  const pk = requireEnv("ORACLE_SIGNER_PRIVATE_KEY");
  return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
}

const HEALTH_POOLS_GOALID_ABI = [
  {
    type: "function",
    name: "computeGoalId",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "participant", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

/**
 * goalId is fixed the moment a pool is created (it hashes the pool address,
 * pool id, participant and periodStart, none of which can change afterwards),
 * yet POST /api/agent/run re-reads it on every ~800ms poll. Caching it removes
 * one RPC read per poll per user without any staleness risk; the TTL exists
 * only to bound a redeploy that repoints HEALTH_POOLS_ADDRESS, which is also
 * why the contract address is part of the key.
 */
const GOAL_ID_TTL_MS = 5 * 60_000;
const goalIdCache = ttlCache<Hex>({ ttlMs: GOAL_ID_TTL_MS, maxEntries: 512 });

/**
 * Ask HealthPools for the goal id instead of re-deriving it here.
 *
 * The id is keccak256(abi.encode(pools, poolId, participant, periodStart)). It
 * depends on the pool's on-chain periodStart, which this server does not
 * otherwise track, and on the pool contract address, which domain-separates the
 * shared registry. Reading it from the contract keeps exactly ONE source of
 * truth for the formula: if it ever changes again, the registry write and the
 * settlement gate cannot silently desync.
 *
 * The read is retried: this is the first chain call of every agent run, so a
 * single rate-limited RPC response here used to surface as an HTTP 500 before
 * the run had done anything at all.
 */
export async function computeGoalId(
  poolId: bigint,
  user: Address,
): Promise<Hex> {
  const pools = requireEnv("HEALTH_POOLS_ADDRESS") as Address;
  const key = `${pools.toLowerCase()}:${poolId.toString()}:${user.toLowerCase()}`;
  return goalIdCache.get(key, () =>
    withRetry(
      () =>
        arcPublicClient().readContract({
          address: pools,
          abi: HEALTH_POOLS_GOALID_ABI,
          functionName: "computeGoalId",
          args: [poolId, user],
        }),
      {
        attempts: RECORD_ATTEMPTS,
        backoffMs: RETRY_BACKOFF_MS,
        deadlineMs: READ_DEADLINE_MS,
        isRetryable: isRetryableExternalError,
        onRetry: (err, attempt, attempts) =>
          console.warn(
            `[verdict] computeGoalId attempt ${attempt}/${attempts} failed for pool ${poolId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      },
    ),
  );
}

export type RecordVerdictOutcome =
  | { status: "recorded"; txHash: Hex; goalId: Hex }
  | { status: "already-recorded"; goalId: Hex }
  | { status: "skipped"; reason: string };

/** Marks a simulate/write failure that means the goal is already on chain. */
const ALREADY_RECORDED_RE = /ALREADY_RECORDED/;

/**
 * Write the verdict into the HealthVerdict registry (the canSettle gate).
 *
 * THROWS on failure — callers MUST NOT swallow it. When HealthPools has a
 * healthVerdict registry configured, settle() pays a participant only if
 * canSettle(goalId) is true, so a missing registry verdict means that
 * participant receives NOTHING even though their result is recorded on chain.
 * Reporting success after a failed write silently costs a verified user their
 * entire payout.
 *
 * No-op (status "skipped") when HEALTH_VERDICT_ADDRESS is unset — that is the
 * explicit opt-out for the pre-gate, oracle-only deployment. scripts/demo-reset.sh
 * keeps that env var in lockstep with the on-chain gate.
 *
 * Idempotent: a goalId already on chain resolves as "already-recorded", which is
 * the desired end state and therefore success, not failure. Safe to call on every
 * poll — that is what makes a failed write recoverable.
 *
 * Transient RPC/network failures are retried in-process; the caller's poll loop
 * provides a second, longer-horizon retry on top of that.
 */
export async function recordVerdict(
  poolId: bigint,
  user: Address,
  verified: boolean,
  confidence: Confidence,
  attesterId: string,
  facets: number = VERDICT_FACETS.document,
): Promise<RecordVerdictOutcome> {
  const registry = optionalEnv("HEALTH_VERDICT_ADDRESS", "");
  if (registry === "") {
    return { status: "skipped", reason: "HEALTH_VERDICT_ADDRESS not set" };
  }

  // A failure here throws to the caller, which surfaces it. The frontend re-polls,
  // so a transient read failure self-heals on the next poll.
  const goalId = await computeGoalId(poolId, user);
  // Tier C: commit only to public routing scalars, never the attester id or
  // any health-derived content. Recomputable by any third-party verifier.
  const digest = verdictDigest(goalId, verified, confidence);
  const account = oracleAccount();
  const wallet = arcWalletClient(account);
  const publicClient = arcPublicClient();

  try {
    // Retrying this write is safe despite it being a write: it simulates first
    // and the registry reverts ALREADY_RECORDED on a second write for the same
    // goalId, so a repeat cannot double-record. Anything ALREADY_RECORDED is
    // the end state we wanted, so it is non-retryable and handled below.
    const txHash = await withRetry(
      async () => {
        const { request } = await publicClient.simulateContract({
          account,
          address: registry as Address,
          abi: HEALTH_VERDICT_ABI,
          functionName: "recordVerdict",
          args: [goalId, verified, CONFIDENCE_U8[confidence], digest, facets],
        });
        const hash = await wallet.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
        });
        if (receipt.status !== "success") {
          throw new Error(`recordVerdict tx ${hash} reverted`);
        }
        return hash;
      },
      {
        attempts: RECORD_ATTEMPTS,
        backoffMs: RETRY_BACKOFF_MS,
        deadlineMs: WRITE_DEADLINE_MS,
        isRetryable: (err) =>
          !ALREADY_RECORDED_RE.test(
            err instanceof Error ? err.message : String(err),
          ),
        onRetry: (err, attempt, attempts) =>
          console.warn(
            `[verdict] recordVerdict attempt ${attempt}/${attempts} failed for goal ${goalId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      },
    );
    return { status: "recorded", txHash, goalId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Already on chain — the end state we wanted, so success, not failure.
    if (ALREADY_RECORDED_RE.test(msg)) {
      return { status: "already-recorded", goalId };
    }
    throw new Error(
      `recordVerdict failed after ${RECORD_ATTEMPTS} attempts for goal ${goalId} ` +
        `(pool ${poolId}, user ${user}): ${msg}`,
    );
  }
}
