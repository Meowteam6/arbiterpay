// SPOTTER's on-chain actions, executed from its Circle wallet.
//
// Three writes: settle(poolId), recordResult(...), recordVerdict(...). All go
// through createContractExecutionTransaction so the tx `from` address on
// Arcscan IS the agent's wallet - that side-by-side is Circle proof 3.
//
// The money rule, everywhere: success is asserted on what actually moved
// (AchieverPaid payouts, registry state), never on transaction success alone.
// Three live pools settle green while paying zero; this module refuses to
// report that as settled.
//
// recordResult reverts NOT_ORACLE until HealthPools.oracle is flipped to the
// Circle wallet (scripts/set-agent-oracle.sh), and recordVerdict reverts
// NOT_ATTESTER until HealthVerdict.attester follows. run.ts dispatches on the
// live on-chain roles, so both the pre-flip and post-flip worlds work.
//
// LOSING A RACE IS NOT FAILING. Five participants in one pool all see
// settled == false and all try to settle it; one lands and four revert. Those
// four are not failures - the winning transaction paid every eligible achiever,
// including theirs. Two mechanisms keep that truth: a pool-scoped settle lock
// (injected, so this module stays free of storage concerns) means the four
// never spend gas at all, and revertKind() below decodes the reverts that mean
// "already on chain" so the run loop reconciles against AchieverPaid in the
// same request instead of writing a red row the next cron tick has to undo.

import {
  formatUnits,
  keccak256,
  parseEventLogs,
  stringToBytes,
  type Address,
  type Hex,
  type Log,
} from "viem";
import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { arcPublicClient, ttlCache } from "@/lib/server/arc-client";
import { requireEnv } from "@/lib/server/env";
import { errorMessage } from "@/lib/server/http";
import { readJson, writeJson } from "@/lib/server/store";
import type { Confidence } from "@/lib/server/judge";

const USDC_DECIMALS = 6;
const CONFIDENCE_U8: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * The contract reverts that mean "the state you wanted is already on chain".
 *
 * The legacy oracle/verdict path has always treated ALREADY_RECORDED as the
 * end state it wanted (verdict.ts, api/oracle/record); the SPOTTER path did
 * not, so a lost race there surfaced as a red error row on a claim that was in
 * fact fine. One matcher now serves both, walking the cause chain because viem
 * and the Circle SDK both bury the revert reason below the top-level message.
 *
 * NOT_PARTICIPANT is decoded here too, but it is NOT success: it means the
 * wallet never joined the pool, which the run loop reports as "blocked". It
 * belongs in the same matcher so every caller decodes reverts one way instead
 * of hand-rolling substring checks that also match ALREADY_JOINED.
 */
export type RevertKind =
  | "already-recorded"
  | "already-settled"
  | "not-participant";

const REVERT_PATTERNS: ReadonlyArray<[RegExp, RevertKind]> = [
  [/\bALREADY_RECORDED\b/, "already-recorded"],
  [/\bALREADY_SETTLED\b/, "already-settled"],
  [/\bNOT_PARTICIPANT\b/, "not-participant"],
];

/** Decode a thrown chain error, or null when it is a real failure. */
export function revertKind(err: unknown): RevertKind | null {
  const message = errorMessage(err);
  for (const [pattern, kind] of REVERT_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return null;
}

export type SpotterExecutor = Pick<
  CircleDeveloperControlledWalletsClient,
  "createContractExecutionTransaction" | "getTransaction"
>;

/** Chain reads the agent needs, injectable so tests never touch an RPC. */
export interface ArcReader {
  /** periodStart is optional so pre-existing fakes keep compiling; the live
   *  reader always sets it. The run route needs it to key wearable claims. */
  getPoolState(
    poolId: bigint,
  ): Promise<{ settled: boolean; periodEnd: bigint; periodStart?: bigint }>;
  /** The pool's USDC balance as a two-decimal USD string. Optional so
   *  existing fakes keep compiling; callers must tolerate its absence. */
  poolBalanceUsd?(poolId: bigint): Promise<string>;
  canSettle(goalId: Hex): Promise<boolean>;
  oracleAddress(): Promise<Address>;
  attesterAddress(): Promise<Address>;
  participantRecorded(poolId: bigint, user: Address): Promise<boolean>;
  verdictRecorded(goalId: Hex): Promise<boolean>;
  /**
   * Blocks until the transaction is mined on the SAME RPC every other read
   * here uses, throwing if it reverted. Circle reports a txHash for an EOA
   * wallet at SENT - before inclusion - so a record write that returns on the
   * hash alone lets the settle preflight read canSettle before the registry
   * write lands, and a one-shot settle() can then burn the pool paying
   * nobody. Waiting on the reading RPC closes that race.
   */
  waitForInclusion(txHash: Hex): Promise<void>;
  /**
   * The AchieverPaid payout this pool's settlement emitted for a participant,
   * or null when it paid them nothing. One settle() pays EVERY eligible
   * achiever in a single transaction, so "the pool is already settled" is not
   * evidence that THIS participant went unpaid - the log is the authority.
   * Optional so pre-existing fakes keep compiling.
   */
  settledPayout?(
    poolId: bigint,
    participant: Address,
  ): Promise<{ txHash: Hex; amount: bigint } | null>;
  /** Waits for the receipt, throws if reverted, returns AchieverPaid payouts. */
  achieverPayouts(txHash: Hex): Promise<
    { participant: Address; amount: bigint }[]
  >;
}

/**
 * Pool-scoped mutual exclusion around the one-shot settle(). Injected rather
 * than imported so this module keeps talking only to the chain, and so tests
 * can drive both sides of the race deterministically. Absent means unlocked,
 * which is the pre-existing behaviour every older fake still expects.
 */
export interface PoolSettleLock {
  /** Holder token, or null when another settler owns this pool right now. */
  acquire(poolId: bigint): Promise<string | null>;
  release(poolId: bigint, token: string): Promise<void>;
}

export interface SpotterDeps {
  circle: SpotterExecutor;
  reader: ArcReader;
  /** Injectable clock for the periodEnd comparison. */
  nowSeconds?: () => bigint;
  settleLock?: PoolSettleLock;
}

export type SettleOutcome =
  | { status: "not-due"; periodEnd: bigint }
  | { status: "already-settled" }
  /** Another claim in this pool holds the settle right now. No transaction was
   *  sent, no gas was spent, and nothing failed: one settle() pays every
   *  eligible achiever, so the caller waits for the holder's result. */
  | { status: "busy" }
  | {
      status: "settled";
      txHash: Hex;
      participantPaidUsd: string;
      payouts: { participant: Address; amount: bigint }[];
    };

export type RecordOutcome =
  | { status: "already-recorded" }
  | { status: "recorded"; txHash: Hex };

/**
 * Execute one contract call from SPOTTER's wallet and wait for the tx hash.
 * Throws when Circle reports a terminal failure state.
 */
async function executeAsSpotter(
  circle: SpotterExecutor,
  args: {
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: unknown[];
  },
): Promise<Hex> {
  const walletId = requireEnv("CIRCLE_WALLET_ID");
  const created = await circle.createContractExecutionTransaction({
    walletId,
    contractAddress: args.contractAddress,
    abiFunctionSignature: args.abiFunctionSignature,
    abiParameters: args.abiParameters,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  } as Parameters<SpotterExecutor["createContractExecutionTransaction"]>[0]);
  const id = created.data?.id;
  if (!id) {
    throw new Error(
      `Circle returned no transaction id for ${args.abiFunctionSignature}`,
    );
  }

  // waitForState (not waitForTxHash): an EOA wallet has a txHash at SENT,
  // pre-inclusion, and returning that early is the race this module must not
  // reopen. CONFIRMED is Circle's own inclusion signal; callers still wait on
  // the reading RPC via ArcReader.waitForInclusion as the authority.
  const polled = await circle.getTransaction({
    id,
    waitForState: "CONFIRMED",
  } as Parameters<SpotterExecutor["getTransaction"]>[0]);
  const tx = polled.data?.transaction;
  if (!tx) {
    throw new Error(`Circle transaction ${id} disappeared while polling`);
  }
  if (tx.state === "FAILED" || tx.state === "DENIED" || tx.state === "CANCELLED") {
    throw new Error(
      `Circle transaction ${id} (${args.abiFunctionSignature}) ended ${tx.state}` +
        (tx.errorReason ? `: ${tx.errorReason}` : ""),
    );
  }
  if (!tx.txHash) {
    throw new Error(
      `Circle transaction ${id} has state ${tx.state} but no txHash`,
    );
  }
  return tx.txHash as Hex;
}

/**
 * Settle a pool from SPOTTER's wallet.
 *
 * Preflights: pool due and unsettled, the pool-scoped settle lock free, the
 * pool STILL unsettled once the lock is held, and canSettle(goalId) open for
 * the participant - settling a gated participant produces a green transaction
 * that pays them nothing, which is the exact failure the spec forbids.
 * Postflight: the participant appears in AchieverPaid with amount > 0.
 *
 * The first state read runs BEFORE the lock so a claim whose period is still
 * running still gets its "not due until" answer (and its deferred receipt row)
 * while another claim in the same pool is mid-settlement. The second runs
 * AFTER it, because that first read is stale by the time the lock is handed
 * over and acting on it would burn gas on a certain revert.
 */
export async function settlePoolAsSpotter(
  deps: SpotterDeps,
  input: { poolId: bigint; goalId: Hex; participant: Address },
): Promise<SettleOutcome> {
  const now = deps.nowSeconds?.() ?? BigInt(Math.floor(Date.now() / 1000));
  const pools = requireEnv("HEALTH_POOLS_ADDRESS");

  const state = await deps.reader.getPoolState(input.poolId);
  if (state.settled) {
    return { status: "already-settled" };
  }
  if (now <= state.periodEnd) {
    return { status: "not-due", periodEnd: state.periodEnd };
  }

  let lockToken: string | null = null;
  if (deps.settleLock !== undefined) {
    lockToken = await deps.settleLock.acquire(input.poolId);
    if (lockToken === null) return { status: "busy" };
  }

  try {
    if (deps.settleLock !== undefined) {
      // The state read above happened BEFORE the lock. Holding the lock only
      // rules out a simultaneous settler; it says nothing about one that
      // already finished and released while this claim was queued behind it.
      // Without this second read that claim broadcasts a settle() that is
      // certain to revert ALREADY_SETTLED - handled gracefully below, but paid
      // for in gas. Re-read under the lock and the doomed transaction is never
      // sent at all.
      const fresh = await deps.reader.getPoolState(input.poolId);
      if (fresh.settled) return { status: "already-settled" };
    }

    const open = await deps.reader.canSettle(input.goalId);
    if (!open) {
      throw new Error(
        `canSettle(${input.goalId}) is false - settling now would pay this ` +
          "participant nothing. Record the verdict first.",
      );
    }

    let txHash: Hex;
    let payouts: { participant: Address; amount: bigint }[];
    try {
      txHash = await executeAsSpotter(deps.circle, {
        contractAddress: pools,
        abiFunctionSignature: "settle(uint256)",
        abiParameters: [input.poolId.toString()],
      });
      payouts = await deps.reader.achieverPayouts(txHash);
    } catch (err) {
      // A settle that lost the race reverts ALREADY_SETTLED, which surfaces
      // either as a Circle FAILED state or as a reverted receipt. Neither is a
      // failure of this claim: re-read the pool and, if it is settled now, hand
      // back already-settled so the caller reconciles against the winning
      // transaction's AchieverPaid log in this same request.
      if (revertKind(err) === "already-settled") {
        return { status: "already-settled" };
      }
      const after = await deps.reader
        .getPoolState(input.poolId)
        .catch(() => null);
      if (after?.settled === true) return { status: "already-settled" };
      throw err;
    }

    const mine = payouts.find(
      (p) => p.participant.toLowerCase() === input.participant.toLowerCase(),
    );
    if (!mine || mine.amount === 0n) {
      throw new Error(
        `settle tx ${txHash} succeeded but ${input.participant} received no payout - ` +
          "a green transaction is not money; do not report this as paid",
      );
    }

    return {
      status: "settled",
      txHash,
      participantPaidUsd: formatUnits(mine.amount, USDC_DECIMALS),
      payouts,
    };
  } finally {
    if (deps.settleLock !== undefined && lockToken !== null) {
      await deps.settleLock.release(input.poolId, lockToken);
    }
  }
}

export async function recordResultAsSpotter(
  deps: SpotterDeps,
  input: {
    poolId: bigint;
    user: Address;
    verdict: boolean;
    multiplierBps: number;
  },
): Promise<RecordOutcome> {
  const pools = requireEnv("HEALTH_POOLS_ADDRESS");
  if (await deps.reader.participantRecorded(input.poolId, input.user)) {
    return { status: "already-recorded" };
  }
  let txHash: Hex;
  try {
    txHash = await executeAsSpotter(deps.circle, {
      contractAddress: pools,
      abiFunctionSignature: "recordResult(uint256,address,bool,uint16)",
      abiParameters: [
        input.poolId.toString(),
        input.user,
        input.verdict,
        input.multiplierBps,
      ],
    });
    // Do not report recorded until the write is mined on the RPC the settle
    // preflights read; a hash alone is not on-chain state.
    await deps.reader.waitForInclusion(txHash);
  } catch (err) {
    // The preflight read above can go stale between the read and the write:
    // another instance recorded the same participant first. That is the end
    // state this call wanted, exactly as the legacy signer path treats it.
    // NOT_PARTICIPANT is deliberately NOT swallowed - it propagates so the run
    // loop can report the claim blocked.
    if (revertKind(err) === "already-recorded") {
      return { status: "already-recorded" };
    }
    throw err;
  }
  return { status: "recorded", txHash };
}

export async function recordVerdictAsSpotter(
  deps: SpotterDeps,
  input: {
    goalId: Hex;
    verified: boolean;
    confidence: Confidence;
    attesterRef: string;
    facets: number;
  },
): Promise<RecordOutcome> {
  const registry = requireEnv("HEALTH_VERDICT_ADDRESS");
  if (await deps.reader.verdictRecorded(input.goalId)) {
    return { status: "already-recorded" };
  }
  const digest = keccak256(stringToBytes(input.attesterRef));
  let txHash: Hex;
  try {
    txHash = await executeAsSpotter(deps.circle, {
      contractAddress: registry,
      abiFunctionSignature: "recordVerdict(bytes32,bool,uint8,bytes32,uint16)",
      abiParameters: [
        input.goalId,
        input.verified,
        CONFIDENCE_U8[input.confidence],
        digest,
        input.facets,
      ],
    });
    // This write is the canSettle gate itself. Settling before it is mined
    // burns the one-shot settle() paying nobody, so block here until the RPC
    // that answers canSettle has it.
    await deps.reader.waitForInclusion(txHash);
  } catch (err) {
    // Same stale-preflight race as recordResult: the registry entry this call
    // wanted is already on chain, which opens the canSettle gate all the same.
    if (revertKind(err) === "already-recorded") {
      return { status: "already-recorded" };
    }
    throw err;
  }
  return { status: "recorded", txHash };
}

// ------------------------------------------------------------- live reader

// Exported so run.ts can parse AchieverPaid out of a paid chain-read receipt
// with the exact same event shape the free-RPC verification uses.
export const ACHIEVER_PAID_ABI = [
  {
    type: "event",
    name: "AchieverPaid",
    inputs: [
      { name: "poolId", type: "uint256", indexed: true },
      { name: "participant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

const POOLS_READ_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        // Field order MUST mirror struct Pool in HealthPools.sol exactly;
        // a mismatch decodes silently into the wrong fields.
        components: [
          { name: "creator", type: "address" },
          { name: "bountyModel", type: "uint8" },
          { name: "settled", type: "bool" },
          { name: "periodStart", type: "uint64" },
          { name: "periodEnd", type: "uint64" },
          { name: "entryFee", type: "uint256" },
          { name: "balance", type: "uint256" },
          { name: "initiative", type: "string" },
          { name: "goalSpec", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "oracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getParticipant",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "joined", type: "bool" },
          { name: "resultRecorded", type: "bool" },
          { name: "verdict", type: "bool" },
          { name: "multiplierBps", type: "uint16" },
          { name: "nullifierHash", type: "uint256" },
          { name: "backingTotal", type: "uint256" },
        ],
      },
    ],
  },
] as const;

const VERDICT_READ_ABI = [
  {
    type: "function",
    name: "canSettle",
    stateMutability: "view",
    inputs: [{ name: "goalId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "attester",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "recorded",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * The agent's on-chain roles change roughly never, but they are read on every
 * poll of every claim - two RPC calls per poll at an 800ms interval, per user.
 * A short TTL collapses that to one read per instance per minute while still
 * picking up a role cutover (scripts/set-agent-oracle.sh) within the window.
 */
const roleCache = ttlCache<Address>({ ttlMs: 60_000, maxEntries: 8 });

/**
 * Remembers which transaction settled a pool.
 *
 * A pool settles exactly once and that transaction pays EVERY eligible
 * achiever, so the block search that finds it is the same work for every
 * participant in the pool. Uncached it is a ~24-call block binary search plus
 * up to 30 getLogs ranges, per claim, per sweep pass, against a rate-limited
 * RPC - the second participant onward pays that bill for an answer the first
 * one already has. Cached, they parse one receipt.
 */
export interface SettleTxCache {
  read(poolId: bigint): Promise<Hex | null>;
  write(poolId: bigint, txHash: Hex): Promise<void>;
}

function settleTxFile(poolId: bigint): string {
  return `agent-settle-tx-${poolId.toString()}.json`;
}

/** Cache over the shared store (Redis in prod, tmpdir JSON locally). Both
 *  sides swallow store failures: a cache that cannot answer must degrade to
 *  the scan, never fail a payout reconciliation. */
export function storeSettleTxCache(): SettleTxCache {
  return {
    async read(poolId) {
      try {
        return await readJson<Hex | null>(settleTxFile(poolId), null);
      } catch {
        return null;
      }
    },
    async write(poolId, txHash) {
      try {
        await writeJson(settleTxFile(poolId), txHash);
      } catch {
        // Next reader repeats the scan. Slower, never wrong.
      }
    },
  };
}

/**
 * The AchieverPaid payout for one participant inside a set of logs, or null
 * when the pool's settlement paid them nothing. Shared by the cached-receipt
 * path and the log-scan path so both answer identically.
 */
export function payoutFromLogs(
  logs: Log[],
  poolId: bigint,
  participant: Address,
): { txHash: Hex; amount: bigint } | null {
  const events = parseEventLogs({
    abi: ACHIEVER_PAID_ABI,
    logs,
    eventName: "AchieverPaid",
  });
  const hit = events.find(
    (e) =>
      e.args.poolId === poolId &&
      e.args.participant.toLowerCase() === participant.toLowerCase() &&
      e.args.amount > 0n,
  );
  if (hit === undefined) return null;
  return { txHash: hit.transactionHash as Hex, amount: hit.args.amount };
}

/** Live ArcReader over viem. Everything here is a read; no keys involved. */
export function arcReader(
  settleTxCache: SettleTxCache = storeSettleTxCache(),
): ArcReader {
  // The shared fallback client: batches the 6-9 reads a single claim poll
  // makes into one JSON-RPC request, and survives one endpoint rate-limiting
  // us. A per-call client could do neither.
  const client = arcPublicClient();
  const pools = () => requireEnv("HEALTH_POOLS_ADDRESS") as Address;
  const registry = () => requireEnv("HEALTH_VERDICT_ADDRESS") as Address;

  return {
    async getPoolState(poolId) {
      const pool = await client.readContract({
        address: pools(),
        abi: POOLS_READ_ABI,
        functionName: "getPool",
        args: [poolId],
      });
      return {
        settled: pool.settled,
        periodEnd: BigInt(pool.periodEnd),
        periodStart: BigInt(pool.periodStart),
      };
    },
    async poolBalanceUsd(poolId) {
      const pool = await client.readContract({
        address: pools(),
        abi: POOLS_READ_ABI,
        functionName: "getPool",
        args: [poolId],
      });
      // Two-decimal USD, truncated: the escalation note must not overstate
      // what is at stake.
      const cents = pool.balance / 10_000n;
      return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
    },
    async canSettle(goalId) {
      return client.readContract({
        address: registry(),
        abi: VERDICT_READ_ABI,
        functionName: "canSettle",
        args: [goalId],
      });
    },
    async oracleAddress() {
      return roleCache.get(`oracle:${pools()}`, () =>
        client.readContract({
          address: pools(),
          abi: POOLS_READ_ABI,
          functionName: "oracle",
        }),
      );
    },
    async attesterAddress() {
      return roleCache.get(`attester:${registry()}`, () =>
        client.readContract({
          address: registry(),
          abi: VERDICT_READ_ABI,
          functionName: "attester",
        }),
      );
    },
    async participantRecorded(poolId, user) {
      const participant = await client.readContract({
        address: pools(),
        abi: POOLS_READ_ABI,
        functionName: "getParticipant",
        args: [poolId, user],
      });
      return participant.resultRecorded;
    },
    async verdictRecorded(goalId) {
      return client.readContract({
        address: registry(),
        abi: VERDICT_READ_ABI,
        functionName: "recorded",
        args: [goalId],
      });
    },
    async waitForInclusion(txHash) {
      // Same viem client as every preflight read above, so "mined" here means
      // mined where canSettle/participantRecorded will be answered next.
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new Error(`tx ${txHash} reverted on Arc testnet`);
      }
    },
    async settledPayout(poolId, participant) {
      // Cheapest path first: the pool's settle transaction is already known,
      // so one receipt read answers every participant in it.
      const cached = await settleTxCache.read(poolId);
      if (cached !== null) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: cached });
          if (receipt.status === "success") {
            return payoutFromLogs(receipt.logs, poolId, participant);
          }
        } catch {
          // Unknown or pruned hash - fall through to the scan and re-cache.
        }
      }

      // The RPC caps eth_getLogs at 100k blocks, so an earliest-to-latest
      // query is rejected outright. settle() can only land after the pool's
      // periodEnd (block.timestamp gate), so binary-search the first block
      // past periodEnd and scan forward from there in capped ranges. In
      // practice the settlement sits in the first range: the sweep settles
      // pools within minutes of their period ending.
      const pool = await client.readContract({
        address: pools(),
        abi: POOLS_READ_ABI,
        functionName: "getPool",
        args: [poolId],
      });
      const periodEnd = BigInt(pool.periodEnd);
      const latest = await client.getBlock({ blockTag: "latest" });
      if (latest.timestamp <= periodEnd) {
        // A settled pool implies a block past periodEnd exists; a tip that
        // disagrees is a stale or inconsistent RPC view. Unknown, not unpaid.
        throw new Error(
          `chain tip ${latest.number} predates pool ${poolId} periodEnd; cannot reconcile the payout yet`,
        );
      }
      let lo = 0n;
      let hi = latest.number;
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const block = await client.getBlock({ blockNumber: mid });
        if (block.timestamp > periodEnd) {
          hi = mid;
        } else {
          lo = mid + 1n;
        }
      }
      const RANGE = 90_000n; // under the RPC's 100k getLogs window
      const MAX_RANGES = 30;
      let from = lo;
      for (let i = 0; i < MAX_RANGES && from <= latest.number; i += 1) {
        const to =
          from + RANGE - 1n > latest.number ? latest.number : from + RANGE - 1n;
        // Filtered by pool, NOT by participant: any AchieverPaid from this
        // pool identifies the settle transaction, which is what gets cached so
        // the next participant never runs this search at all.
        const logs = await client.getLogs({
          address: pools(),
          event: ACHIEVER_PAID_ABI[0],
          args: { poolId },
          fromBlock: from,
          toBlock: to,
        });
        if (logs.length > 0) {
          const settleTx = logs[0].transactionHash;
          if (settleTx !== null) {
            await settleTxCache.write(poolId, settleTx as Hex);
          }
          return payoutFromLogs(logs as Log[], poolId, participant);
        }
        from = to + 1n;
      }
      if (from <= latest.number) {
        // The scan budget ran out before covering the tip. Refusing to
        // answer beats declaring a possibly-paid participant unpaid.
        throw new Error(
          `AchieverPaid scan for pool ${poolId} exhausted its range budget before reaching the chain tip; refusing to declare the participant unpaid`,
        );
      }
      return null;
    },
    async achieverPayouts(txHash) {
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new Error(`tx ${txHash} reverted on Arc testnet`);
      }
      const events = parseEventLogs({
        abi: ACHIEVER_PAID_ABI,
        logs: receipt.logs,
        eventName: "AchieverPaid",
      });
      return events.map((e) => ({
        participant: e.args.participant,
        amount: e.args.amount,
      }));
    },
  };
}
