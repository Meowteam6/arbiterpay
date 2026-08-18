import {
  createPublicClient,
  fallback,
  formatUnits,
  http,
  parseAbiItem,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { arcTestnet } from "@/lib/chains";

// ---------------------------------------------------------------- addresses

/** Canonical USDC ERC-20 interface on Arc testnet (6 decimals). */
export const USDC_ADDRESS: Address =
  "0x3600000000000000000000000000000000000000";

export const USDC_DECIMALS = 6;

/**
 * HealthPools deployment address. Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS once
 * the contract agent deploys; pages surface a visible configuration error
 * until then rather than failing silently.
 */
export function getHealthPoolsAddress(): Address | null {
  const raw = process.env.NEXT_PUBLIC_HEALTH_POOLS_ADDRESS;
  if (raw === undefined || raw === "") return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as Address;
}

// ---------------------------------------------------------------------- abi

export const healthPoolsAbi = [
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "initiative", type: "string" },
      { name: "goalSpec", type: "string" },
      { name: "entryFee", type: "uint256" },
      { name: "periodStart", type: "uint64" },
      { name: "periodEnd", type: "uint64" },
      { name: "bountyModel", type: "uint8" },
      { name: "initialFunding", type: "uint256" },
    ],
    outputs: [{ name: "poolId", type: "uint256" }],
  },
  {
    type: "function",
    name: "joinPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "nullifierHash", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "recordResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "user", type: "address" },
      { name: "verdict", type: "bool" },
      { name: "multiplierBps", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "poolId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "backGoal",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fundPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "uint256" }],
    outputs: [
      {
        name: "pool",
        type: "tuple",
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
    name: "getParticipant",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [
      {
        name: "participant",
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
  {
    type: "function",
    name: "getParticipants",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "poolCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
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
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "poolId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "initiative", type: "string", indexed: false },
      { name: "goalSpec", type: "string", indexed: false },
      { name: "entryFee", type: "uint256", indexed: false },
      { name: "periodStart", type: "uint64", indexed: false },
      { name: "periodEnd", type: "uint64", indexed: false },
      { name: "bountyModel", type: "uint8", indexed: false },
    ],
  },
  // Read-only money/identity events for the social layer. These carry
  // addresses, amounts, and tx hashes ONLY - no initiative, no goalSpec, no
  // health string of any kind - so aggregating them is redaction-safe by
  // construction. Signatures verified against contracts/src/HealthPools.sol.
  {
    type: "event",
    name: "PoolJoined",
    inputs: [
      { name: "poolId", type: "uint256", indexed: true },
      { name: "participant", type: "address", indexed: true },
      { name: "nullifierHash", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ResultRecorded",
    inputs: [
      { name: "poolId", type: "uint256", indexed: true },
      { name: "participant", type: "address", indexed: true },
      { name: "verdict", type: "bool", indexed: false },
      { name: "multiplierBps", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GoalBacked",
    inputs: [
      { name: "poolId", type: "uint256", indexed: true },
      { name: "participant", type: "address", indexed: true },
      { name: "backer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BackerPaid",
    inputs: [
      { name: "poolId", type: "uint256", indexed: true },
      { name: "backer", type: "address", indexed: true },
      { name: "participant", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
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

export const poolCreatedEvent = parseAbiItem(
  "event PoolCreated(uint256 indexed poolId, address indexed creator, string initiative, string goalSpec, uint256 entryFee, uint64 periodStart, uint64 periodEnd, uint8 bountyModel)",
);

// Parsed event items for getLogs in the social-stats aggregator. Indexed
// address params let the RPC filter server-side per wallet.
export const achieverPaidEvent = parseAbiItem(
  "event AchieverPaid(uint256 indexed poolId, address indexed participant, uint256 amount)",
);
export const backerPaidEvent = parseAbiItem(
  "event BackerPaid(uint256 indexed poolId, address indexed backer, address participant, uint256 amount)",
);
export const goalBackedEvent = parseAbiItem(
  "event GoalBacked(uint256 indexed poolId, address indexed participant, address indexed backer, uint256 amount)",
);
export const poolJoinedEvent = parseAbiItem(
  "event PoolJoined(uint256 indexed poolId, address indexed participant, uint256 nullifierHash)",
);
export const resultRecordedEvent = parseAbiItem(
  "event ResultRecorded(uint256 indexed poolId, address indexed participant, bool verdict, uint16 multiplierBps)",
);

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ------------------------------------------------------------------ clients

let cachedClient: PublicClient | null = null;
let cachedRpcOverride: string | null = null;

/**
 * The endpoints this client falls back across.
 *
 * The public list is the chain definition itself, so there is one copy of it
 * for the browser, lib/server/arc-client.ts and lib/chains.ts to share.
 *
 * ARC_RPC_URL, when set, is the ONLY endpoint, matching the operator override
 * lib/server/arc-client.ts and lib/server/pools.ts already honour — this
 * module was the last Arc consumer that ignored it, which meant a server-side
 * read through fetchPool() (loadClaimPool, and therefore both claim routes)
 * could not be pointed at a private or local endpoint at all. The override
 * replaces the public list rather than heading it: an operator who pins an
 * endpoint means it, and quietly falling through a pinned endpoint sends
 * traffic to exactly the endpoints the pin exists to avoid.
 *
 * The browser never sees the variable (it is not NEXT_PUBLIC), so this is a
 * server-side override by construction.
 */
function arcRpcUrls(): string[] {
  const override = process.env.ARC_RPC_URL ?? "";
  if (override === "") return [...arcTestnet.rpcUrls.default.http];
  return [override];
}

/** Shared Arc testnet public client with RPC fallbacks for flaky venue WiFi. */
export function getArcPublicClient(): PublicClient {
  const override = process.env.ARC_RPC_URL ?? "";
  // Rebuild when the override changes rather than serving a client pinned to
  // an endpoint the operator has since moved off.
  if (cachedClient === null || cachedRpcOverride !== override) {
    cachedRpcOverride = override;
    cachedClient = createPublicClient({
      chain: arcTestnet,
      transport: fallback(arcRpcUrls().map((url) => http(url))),
    });
  }
  return cachedClient;
}

// -------------------------------------------------------------------- types

export interface PoolInfo {
  id: bigint;
  creator: Address;
  bountyModel: number;
  settled: boolean;
  periodStart: bigint;
  periodEnd: bigint;
  entryFee: bigint;
  balance: bigint;
  initiative: string;
  goalSpec: string;
}

export interface ParticipantInfo {
  joined: boolean;
  resultRecorded: boolean;
  verdict: boolean;
  multiplierBps: number;
  nullifierHash: bigint;
  backingTotal: bigint;
}

export class ContractNotConfiguredError extends Error {
  constructor() {
    super(
      "HealthPools contract address is not configured. Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS and redeploy.",
    );
    this.name = "ContractNotConfiguredError";
  }
}

// -------------------------------------------------------------------- reads

async function readPool(address: Address, id: bigint): Promise<PoolInfo> {
  const client = getArcPublicClient();
  const pool = await client.readContract({
    address,
    abi: healthPoolsAbi,
    functionName: "getPool",
    args: [id],
  });
  return {
    id,
    creator: pool.creator,
    bountyModel: pool.bountyModel,
    settled: pool.settled,
    periodStart: pool.periodStart,
    periodEnd: pool.periodEnd,
    entryFee: pool.entryFee,
    balance: pool.balance,
    initiative: pool.initiative,
    goalSpec: pool.goalSpec,
  };
}

/**
 * Discover pools via PoolCreated logs, falling back to sequential poolCount
 * enumeration if the RPC rejects the log query (pool ids run 1..poolCount).
 */
export async function fetchPools(): Promise<PoolInfo[]> {
  const address = getHealthPoolsAddress();
  if (address === null) throw new ContractNotConfiguredError();
  const client = getArcPublicClient();

  let ids: bigint[] = [];
  try {
    const logs = await client.getLogs({
      address,
      event: poolCreatedEvent,
      fromBlock: 0n,
      toBlock: "latest",
    });
    ids = logs
      .map((log) => log.args.poolId)
      .filter((id): id is bigint => id !== undefined);
  } catch {
    ids = [];
  }

  if (ids.length === 0) {
    const count = await client.readContract({
      address,
      abi: healthPoolsAbi,
      functionName: "poolCount",
    });
    ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  }

  const unique = Array.from(new Set(ids.map((id) => id.toString()))).map(
    (s) => BigInt(s),
  );
  const pools = await Promise.all(unique.map((id) => readPool(address, id)));
  return pools.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function fetchPool(id: bigint): Promise<PoolInfo> {
  const address = getHealthPoolsAddress();
  if (address === null) throw new ContractNotConfiguredError();
  return readPool(address, id);
}

export async function fetchParticipants(id: bigint): Promise<Address[]> {
  const address = getHealthPoolsAddress();
  if (address === null) throw new ContractNotConfiguredError();
  const client = getArcPublicClient();
  const list = await client.readContract({
    address,
    abi: healthPoolsAbi,
    functionName: "getParticipants",
    args: [id],
  });
  return [...list];
}

export async function fetchParticipant(
  id: bigint,
  user: Address,
): Promise<ParticipantInfo> {
  const address = getHealthPoolsAddress();
  if (address === null) throw new ContractNotConfiguredError();
  const client = getArcPublicClient();
  const p = await client.readContract({
    address,
    abi: healthPoolsAbi,
    functionName: "getParticipant",
    args: [id, user],
  });
  return {
    joined: p.joined,
    resultRecorded: p.resultRecorded,
    verdict: p.verdict,
    multiplierBps: p.multiplierBps,
    nullifierHash: p.nullifierHash,
    backingTotal: p.backingTotal,
  };
}

/**
 * Ask the contract for the goal id of a (pool, participant) pair. The agent
 * run route keys its ledger by this id and re-derives it server-side, so the
 * browser must read it from the same source of truth, never re-derive it.
 */
export async function fetchGoalId(id: bigint, user: Address): Promise<Hex> {
  const address = getHealthPoolsAddress();
  if (address === null) throw new ContractNotConfiguredError();
  const client = getArcPublicClient();
  return client.readContract({
    address,
    abi: healthPoolsAbi,
    functionName: "computeGoalId",
    args: [id, user],
  });
}

// ------------------------------------------------------------------ helpers

export function formatUsdc(amount: bigint): string {
  const value = Number(formatUnits(amount, USDC_DECIMALS));
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function parseUsdc(input: string): bigint {
  return parseUnits(input, USDC_DECIMALS);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export const BOUNTY_MODEL_LABELS: Record<number, string> = {
  0: "Fixed bounty per achiever",
  1: "Pro-rata pot split",
};

// ------------------------------------------------------------ evidence type

/**
 * Evidence convention. The contract goalSpec is a free-form string, so we
 * encode how a goal is verified by an optional leading marker:
 *
 *   "[doc] ..."  -> verified by an uploaded document (flu shot, lab PDF, etc.)
 *   anything else -> verified by wearable data (the original behavior)
 *
 * The marker is for routing and badges only; no contract call changes. Older
 * pools created before this convention have no marker and render as wearable,
 * which keeps the feature fully backward compatible.
 */
export const DOC_GOAL_MARKER = "[doc]";

export type EvidenceType = "document" | "wearable";

/** Decide how a goal is verified from its goalSpec string. */
export function evidenceTypeOf(goalSpec: string): EvidenceType {
  return goalSpec.trimStart().toLowerCase().startsWith(DOC_GOAL_MARKER)
    ? "document"
    : "wearable";
}

/** Prefix a goalSpec with the document marker, avoiding duplicate markers. */
export function withDocMarker(goalSpec: string): string {
  const trimmed = goalSpec.trim();
  return evidenceTypeOf(trimmed) === "document"
    ? trimmed
    : `${DOC_GOAL_MARKER} ${trimmed}`;
}

/** Strip the document marker for human-readable display. */
export function displayGoalSpec(goalSpec: string): string {
  const trimmed = goalSpec.trim();
  if (evidenceTypeOf(trimmed) !== "document") return trimmed;
  return trimmed.slice(trimmed.toLowerCase().indexOf(DOC_GOAL_MARKER) + DOC_GOAL_MARKER.length).trim();
}
