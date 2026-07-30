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

import {
  createPublicClient,
  defineChain,
  formatUnits,
  http,
  keccak256,
  parseEventLogs,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import type { CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { optionalEnv, requireEnv } from "@/lib/server/env";
import type { Confidence } from "@/lib/server/judge";

const USDC_DECIMALS = 6;
const CONFIDENCE_U8: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export type SpotterExecutor = Pick<
  CircleDeveloperControlledWalletsClient,
  "createContractExecutionTransaction" | "getTransaction"
>;

/** Chain reads the agent needs, injectable so tests never touch an RPC. */
export interface ArcReader {
  getPoolState(poolId: bigint): Promise<{ settled: boolean; periodEnd: bigint }>;
  canSettle(goalId: Hex): Promise<boolean>;
  oracleAddress(): Promise<Address>;
  attesterAddress(): Promise<Address>;
  participantRecorded(poolId: bigint, user: Address): Promise<boolean>;
  verdictRecorded(goalId: Hex): Promise<boolean>;
  /** Waits for the receipt, throws if reverted, returns AchieverPaid payouts. */
  achieverPayouts(txHash: Hex): Promise<
    { participant: Address; amount: bigint }[]
  >;
}

export interface SpotterDeps {
  circle: SpotterExecutor;
  reader: ArcReader;
  /** Injectable clock for the periodEnd comparison. */
  nowSeconds?: () => bigint;
}

export type SettleOutcome =
  | { status: "not-due"; periodEnd: bigint }
  | { status: "already-settled" }
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

  const polled = await circle.getTransaction({
    id,
    waitForTxHash: true,
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
 * Preflights: pool due and unsettled, and canSettle(goalId) open for the
 * participant - settling a gated participant produces a green transaction
 * that pays them nothing, which is the exact failure the spec forbids.
 * Postflight: the participant appears in AchieverPaid with amount > 0.
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

  const open = await deps.reader.canSettle(input.goalId);
  if (!open) {
    throw new Error(
      `canSettle(${input.goalId}) is false - settling now would pay this ` +
        "participant nothing. Record the verdict first.",
    );
  }

  const txHash = await executeAsSpotter(deps.circle, {
    contractAddress: pools,
    abiFunctionSignature: "settle(uint256)",
    abiParameters: [input.poolId.toString()],
  });

  const payouts = await deps.reader.achieverPayouts(txHash);
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
  const txHash = await executeAsSpotter(deps.circle, {
    contractAddress: pools,
    abiFunctionSignature: "recordResult(uint256,address,bool,uint16)",
    abiParameters: [
      input.poolId.toString(),
      input.user,
      input.verdict,
      input.multiplierBps,
    ],
  });
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
  const txHash = await executeAsSpotter(deps.circle, {
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
  return { status: "recorded", txHash };
}

// ------------------------------------------------------------- live reader

const ACHIEVER_PAID_ABI = [
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

function arcTestnet() {
  const rpcUrl = optionalEnv("ARC_RPC_URL", "https://rpc.testnet.arc.network");
  return defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** Live ArcReader over viem. Everything here is a read; no keys involved. */
export function arcReader(): ArcReader {
  const client = createPublicClient({ chain: arcTestnet(), transport: http() });
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
      return { settled: pool.settled, periodEnd: BigInt(pool.periodEnd) };
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
      return client.readContract({
        address: pools(),
        abi: POOLS_READ_ABI,
        functionName: "oracle",
      });
    },
    async attesterAddress() {
      return client.readContract({
        address: registry(),
        abi: VERDICT_READ_ABI,
        functionName: "attester",
      });
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
