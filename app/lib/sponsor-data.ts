// On-chain aggregation for the sponsor console.
//
// Every number the console shows is read from the chain: HealthPools events for
// what happened (joins, verified results, top-ups, achiever payouts) plus the
// current pool balance from state. Nothing here reads a per-participant address
// out to the UI — the events carry addresses, but this module reduces them to
// COUNTS and USDC SUMS keyed by pool id and discards the identities. The
// k-anonymity floor is then applied downstream in lib/sponsor-metrics.
//
// A windowed getLogs scan covers all four event types across the contract's
// history, then the rows are grouped by pool id. Arc caps a single eth_getLogs
// at 100k blocks and runs sub-second blocks, so the scan is split into windows
// from the pinned deploy-era start block to the chain tip (see chunked-logs).
// It reuses the same Arc public client (and RPC fallback) as the rest of the
// read path.

import { parseAbiItem, type Address } from "viem";
import {
  getArcPublicClient,
  getHealthPoolsAddress,
  ContractNotConfiguredError,
} from "@/lib/contract";
import { scanInWindows, poolsScanFromBlock } from "@/lib/server/chunked-logs";
import type { PoolAggregate } from "@/lib/sponsor-metrics";

const poolJoinedEvent = parseAbiItem(
  "event PoolJoined(uint256 indexed poolId, address indexed participant, uint256 nullifierHash)",
);
const resultRecordedEvent = parseAbiItem(
  "event ResultRecorded(uint256 indexed poolId, address indexed participant, bool verdict, uint16 multiplierBps)",
);
const poolFundedEvent = parseAbiItem(
  "event PoolFunded(uint256 indexed poolId, address indexed funder, uint256 amount)",
);
const achieverPaidEvent = parseAbiItem(
  "event AchieverPaid(uint256 indexed poolId, address indexed participant, uint256 amount)",
);

/** Event-derived aggregate for one pool, before the current balance is added. */
export interface PoolEventTotals {
  /** PoolJoined count = one-wallet-one-entry participants. */
  joined: number;
  /** ResultRecorded with a passing verdict = verified achievers. */
  completions: number;
  /** Sum of AchieverPaid amounts = USDC that actually moved to achievers. */
  paidUsdc: bigint;
  /** Sum of PoolFunded amounts = the sponsor's own fundPool top-ups. */
  toppedUpUsdc: bigint;
}

function emptyTotals(): PoolEventTotals {
  return { joined: 0, completions: 0, paidUsdc: 0n, toppedUpUsdc: 0n };
}

function totalsFor(
  map: Map<string, PoolEventTotals>,
  poolId: bigint,
): PoolEventTotals {
  const key = poolId.toString();
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const fresh = emptyTotals();
  map.set(key, fresh);
  return fresh;
}

/**
 * Read all HealthPools activity in one query and reduce it to per-pool counts
 * and USDC sums keyed by pool id. Participant addresses on the events are used
 * only to be counted, never returned.
 */
export async function fetchPoolEventTotals(): Promise<
  Record<string, PoolEventTotals>
> {
  const address = getHealthPoolsAddress();
  if (address === null) throw new ContractNotConfiguredError();
  const client = getArcPublicClient();

  // Historical event scanning is unreliable from the browser: the primary Arc
  // RPC prunes deploy-era history and the archival one caps eth_getLogs well
  // below a full scan and rate-limits bursts. So this aggregation degrades
  // gracefully - if the scan cannot complete, the console still lists the
  // sponsor's pools (from the poolCount read) with outcomes shown as pending,
  // rather than failing the whole page. A server-side archival scan is the
  // durable fix and is tracked separately.
  try {
    const latest = await client.getBlockNumber();
    const logs = await scanInWindows(poolsScanFromBlock(), latest, (fromBlock, toBlock) =>
      client.getLogs({
        address,
        events: [
          poolJoinedEvent,
          resultRecordedEvent,
          poolFundedEvent,
          achieverPaidEvent,
        ],
        fromBlock,
        toBlock,
      }),
    );

    const map = new Map<string, PoolEventTotals>();
    for (const log of logs) {
      const poolId = log.args.poolId;
      if (poolId === undefined) continue;
      const totals = totalsFor(map, poolId);
      switch (log.eventName) {
        case "PoolJoined":
          totals.joined += 1;
          break;
        case "ResultRecorded":
          if (log.args.verdict === true) totals.completions += 1;
          break;
        case "PoolFunded":
          totals.toppedUpUsdc += log.args.amount ?? 0n;
          break;
        case "AchieverPaid":
          totals.paidUsdc += log.args.amount ?? 0n;
          break;
      }
    }

    return Object.fromEntries(map);
  } catch (err) {
    console.warn(
      "[sponsor] pool-event scan unavailable from this RPC; showing pools without live outcomes",
      err,
    );
    return {};
  }
}

/** The pool-state fields the console pairs with the event totals. */
export interface PoolBalanceFields {
  id: bigint;
  balance: bigint;
  creator: Address;
}

/**
 * Combine a pool's current balance with its event totals into the raw
 * PoolAggregate the metrics gate consumes. A pool with no events yet reduces
 * to zero counts and its balance, which the floor then reports as "below the
 * floor" rather than a misleading zero-outcome row.
 */
export function toPoolAggregate(
  pool: PoolBalanceFields,
  totals: PoolEventTotals | undefined,
): PoolAggregate {
  const t = totals ?? emptyTotals();
  return {
    balanceUsdc: pool.balance,
    toppedUpUsdc: t.toppedUpUsdc,
    joined: t.joined,
    completions: t.completions,
    paidUsdc: t.paidUsdc,
  };
}
