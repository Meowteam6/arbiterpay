// Windowed eth_getLogs for Arc testnet.
//
// Arc caps a single eth_getLogs at a 100,000-block range, and Arc blocks are
// sub-second (~0.5s), so any scan that must cover the contract's history has to
// be split into windows under that cap. A full scan from block 0 is 600+
// windows; pinning the start near the HealthPools deploy keeps it to a few dozen.

/** Under Arc's 100k eth_getLogs window. */
const RANGE = 90_000n;

/** Default window batch size. A caller running several scans at once passes a
 *  lower value so their combined peak stays under the RPC rate limit. */
const CONCURRENCY = 6;

/**
 * Scan start for HealthPools history. The canonical contract deployed on
 * 2026-07-27 (~block 54.15M on Arc testnet, which runs ~0.5s blocks), so a full
 * scan from 0 wastes 600+ empty windows. Pinned safely before the deploy;
 * override with HEALTH_POOLS_FROM_BLOCK once history grows enough to retune it.
 */
export function poolsScanFromBlock(): bigint {
  const raw = process.env.HEALTH_POOLS_FROM_BLOCK ?? "";
  if (/^\d+$/.test(raw)) return BigInt(raw);
  return 54_000_000n;
}

/**
 * Split [fromBlock, toBlock] into windows no wider than RANGE, run `query` on
 * each, and concatenate the results in window order. `query` receives one
 * window's block bounds and returns that window's logs. Windows run CONCURRENCY
 * at a time so a multi-window scan stays under the RPC's rate limit while still
 * overlapping round trips. A range that fits in one window is a single call.
 */
export async function scanInWindows<T>(
  fromBlock: bigint,
  toBlock: bigint,
  query: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  concurrency: number = CONCURRENCY,
): Promise<T[]> {
  if (toBlock < fromBlock) return [];
  const batchSize = concurrency < 1 ? 1 : concurrency;
  const windows: Array<[bigint, bigint]> = [];
  for (let from = fromBlock; from <= toBlock; from += RANGE) {
    const to = from + RANGE - 1n > toBlock ? toBlock : from + RANGE - 1n;
    windows.push([from, to]);
  }
  const out: T[] = [];
  for (let i = 0; i < windows.length; i += batchSize) {
    const batch = windows.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(([f, t]) => query(f, t)));
    for (const r of results) out.push(...r);
  }
  return out;
}
