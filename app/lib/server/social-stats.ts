// Public, on-chain-derived stats for a wallet's profile page. Everything here
// is computed from HealthPools money/identity events, which carry addresses,
// amounts, and block positions ONLY - never an initiative or goalSpec - so the
// output is health-safe by construction. No health data, no ledger prose, no
// wearable read is ever touched by this module.
//
// The counters map to the paid-wall:
//   goalsHit    = AchieverPaid events paying this wallet (a verified win, paid)
//   usdcEarned  = sum of AchieverPaid + BackerPaid amounts to this wallet
//   poolsJoined = PoolJoined events for this wallet
//   backerWins  = BackerPaid events to this wallet as a backer
//   winStreak   = trailing run of verdict==true in this wallet's ResultRecorded
// and the peer sets (addresses only; the caller resolves handles):
//   backerAddresses  = wallets backing this wallet   (GoalBacked, participant=A)
//   backingAddresses = wallets this wallet backs      (GoalBacked, backer=A)
//
// getLogs is filtered server-side by the indexed address param, so each query
// is scoped to one wallet rather than the whole contract, and the result is
// cached briefly per wallet so a profile view does not re-scan on every render.

import { getAddress, type Address } from "viem";
import {
  achieverPaidEvent,
  backerPaidEvent,
  formatUsdc,
  getArcPublicClient,
  getHealthPoolsAddress,
  goalBackedEvent,
  poolJoinedEvent,
  resultRecordedEvent,
} from "@/lib/contract";
import { normalizeAddress } from "@/lib/social";
import { scanInWindows, poolsScanFromBlock } from "@/lib/server/chunked-logs";

export interface SocialWin {
  /** ISO-8601 block time, or "" when the block time could not be read. */
  at: string;
  amountUsd: string; // formatted, two decimals, e.g. "40.00"
  txHash: string; // the settlement tx -> Arcscan link
  role: "achiever" | "backer";
}

export interface SocialStats {
  goalsHit: number;
  usdcEarned: bigint; // USDC in 6-decimal base units
  poolsJoined: number;
  backerWins: number;
  winStreak: number;
  backerAddresses: string[];
  backingAddresses: string[];
  recentWins: SocialWin[]; // newest first, capped at WINS_LIMIT
}

export const EMPTY_STATS: SocialStats = {
  goalsHit: 0,
  usdcEarned: 0n,
  poolsJoined: 0,
  backerWins: 0,
  winStreak: 0,
  backerAddresses: [],
  backingAddresses: [],
  recentWins: [],
};

// How many recent payout rows the paid-wall shows. Block timestamps for these
// are fetched one block at a time, so the cap also bounds that fan-out.
const WINS_LIMIT = 12;

// Each event query is windowed (Arc caps a single getLogs at 100k blocks and
// runs sub-second blocks) via scanInWindows from the pinned deploy-era start.
// The six per-wallet scans run at once, so each uses a small window concurrency
// to keep their combined peak under the RPC rate limit.
const SCAN_CONCURRENCY = 2;

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; stats: SocialStats }>();

/** Test seam. */
export function clearSocialStatsCache(): void {
  cache.clear();
}

type Positioned = { blockNumber: bigint | null; logIndex: number | null };

/** Chronological order across the chain: block first, log index within block. */
function byPosition(a: Positioned, b: Positioned): number {
  const ab = a.blockNumber ?? 0n;
  const bb = b.blockNumber ?? 0n;
  if (ab !== bb) return ab < bb ? -1 : 1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

/** Distinct lowercased addresses, preserving first-seen order. */
function distinctAddresses(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === undefined) continue;
    const lower = value.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * Resolve ISO timestamps for a bounded set of block numbers. Best-effort: a
 * block whose header cannot be read is simply absent from the map, and the
 * caller renders that win without a relative time rather than failing.
 */
async function resolveBlockTimes(
  blockNumbers: (bigint | null)[],
): Promise<Map<bigint, string>> {
  const out = new Map<bigint, string>();
  const distinct = Array.from(
    new Set(
      blockNumbers.filter((b): b is bigint => b !== null).map((b) => b.toString()),
    ),
  ).map((s) => BigInt(s));
  if (distinct.length === 0) return out;

  const client = getArcPublicClient();
  await Promise.all(
    distinct.map(async (blockNumber) => {
      try {
        const block = await client.getBlock({ blockNumber });
        out.set(blockNumber, new Date(Number(block.timestamp) * 1000).toISOString());
      } catch {
        // Leave this block out; the win row renders without a timestamp.
      }
    }),
  );
  return out;
}

/**
 * Compute a wallet's public stats. Never throws: a dead RPC or a rejected log
 * query yields zeroed counters so the profile still renders its identity, and
 * the failure is loud server-side only.
 */
export async function getSocialStats(rawAddress: string): Promise<SocialStats> {
  const lower = normalizeAddress(rawAddress);
  if (lower === null) return EMPTY_STATS;

  const cached = cache.get(lower);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.stats;
  }

  const poolsAddress = getHealthPoolsAddress();
  if (poolsAddress === null) return EMPTY_STATS;
  const account = getAddress(lower) as Address;
  const client = getArcPublicClient();
  const start = poolsScanFromBlock();

  try {
    const latest = await client.getBlockNumber();
    const scan = <T>(
      query: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
    ) => scanInWindows(start, latest, query, SCAN_CONCURRENCY);
    const [achiever, backerPaid, joined, results, backedForMe, backedByMe] =
      await Promise.all([
        scan((fromBlock, toBlock) =>
          client.getLogs({
            address: poolsAddress,
            event: achieverPaidEvent,
            args: { participant: account },
            fromBlock,
            toBlock,
          }),
        ),
        scan((fromBlock, toBlock) =>
          client.getLogs({
            address: poolsAddress,
            event: backerPaidEvent,
            args: { backer: account },
            fromBlock,
            toBlock,
          }),
        ),
        scan((fromBlock, toBlock) =>
          client.getLogs({
            address: poolsAddress,
            event: poolJoinedEvent,
            args: { participant: account },
            fromBlock,
            toBlock,
          }),
        ),
        scan((fromBlock, toBlock) =>
          client.getLogs({
            address: poolsAddress,
            event: resultRecordedEvent,
            args: { participant: account },
            fromBlock,
            toBlock,
          }),
        ),
        scan((fromBlock, toBlock) =>
          client.getLogs({
            address: poolsAddress,
            event: goalBackedEvent,
            args: { participant: account },
            fromBlock,
            toBlock,
          }),
        ),
        scan((fromBlock, toBlock) =>
          client.getLogs({
            address: poolsAddress,
            event: goalBackedEvent,
            args: { backer: account },
            fromBlock,
            toBlock,
          }),
        ),
      ]);

    let usdcEarned = 0n;
    for (const log of achiever) usdcEarned += log.args.amount ?? 0n;
    for (const log of backerPaid) usdcEarned += log.args.amount ?? 0n;

    // Win streak: trailing run of verified results in chronological order.
    const streak = [...results].sort(byPosition).reduce((run, log) => {
      return log.args.verdict === true ? run + 1 : 0;
    }, 0);

    // Recent payout rows: both kinds of money-in event this wallet received,
    // newest first, capped. Each carries the settlement tx hash directly off
    // the log; block time is resolved for the capped set only.
    type WinLog = {
      blockNumber: bigint | null;
      logIndex: number | null;
      txHash: string;
      amount: bigint;
      role: "achiever" | "backer";
    };
    const winLogs: WinLog[] = [
      ...achiever.map((log) => ({
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        txHash: String(log.transactionHash ?? ""),
        amount: log.args.amount ?? 0n,
        role: "achiever" as const,
      })),
      ...backerPaid.map((log) => ({
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        txHash: String(log.transactionHash ?? ""),
        amount: log.args.amount ?? 0n,
        role: "backer" as const,
      })),
    ]
      .filter((w) => w.txHash !== "")
      .sort((a, b) => byPosition(b, a))
      .slice(0, WINS_LIMIT);

    const blockTimes = await resolveBlockTimes(
      winLogs.map((w) => w.blockNumber),
    );
    const recentWins: SocialWin[] = winLogs.map((w) => ({
      at:
        w.blockNumber !== null
          ? (blockTimes.get(w.blockNumber) ?? "")
          : "",
      amountUsd: formatUsdc(w.amount),
      txHash: w.txHash,
      role: w.role,
    }));

    const stats: SocialStats = {
      goalsHit: achiever.length,
      usdcEarned,
      poolsJoined: joined.length,
      backerWins: backerPaid.length,
      winStreak: streak,
      // backers OF this wallet: the backer address on each GoalBacked to it.
      backerAddresses: distinctAddresses(
        backedForMe.map((log) => log.args.backer),
      ),
      // wallets this wallet is backing: the participant on each of its stakes.
      backingAddresses: distinctAddresses(
        backedByMe.map((log) => log.args.participant),
      ),
      recentWins,
    };

    cache.set(lower, { at: Date.now(), stats });
    return stats;
  } catch (err) {
    console.error("[social-stats] log scan failed", err);
    return EMPTY_STATS;
  }
}
