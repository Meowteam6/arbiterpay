// On-chain aggregation for the sponsor console.
//
// Every number the console shows is read from the chain: HealthPools events for
// what happened (joins, verified results, top-ups, achiever payouts) plus the
// current pool balance from state. Nothing here reads a per-participant address
// out to the UI — the events carry addresses, but this module reduces them to
// COUNTS and USDC SUMS keyed by pool id and discards the identities. The
// k-anonymity floor is then applied downstream in lib/sponsor-metrics.
//
// One getLogs call covers all four event types across the whole contract, then
// the rows are grouped by pool id. That is one round trip for the entire
// console rather than one per pool, and it reuses the same Arc public client
// (and RPC fallback) as the rest of the read path.

import { parseAbiItem, type Address } from "viem";
import {
  getArcPublicClient,
  getHealthPoolsAddress,
  ContractNotConfiguredError,
} from "@/lib/contract";
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

  const logs = await client.getLogs({
    address,
    events: [
      poolJoinedEvent,
      resultRecordedEvent,
      poolFundedEvent,
      achieverPaidEvent,
    ],
    fromBlock: 0n,
    toBlock: "latest",
  });

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
