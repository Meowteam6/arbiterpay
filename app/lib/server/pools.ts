// On-chain participant and verdict reads for HealthPools (server only).
//
// The entry gate is the contract itself: joinPool enforces one wallet, one
// entry (ALREADY_JOINED), so the participant's joined flag IS the record of
// who may receive results and payouts for a pool. Server routes gate on this
// read rather than any off-chain identity store. Payout routes additionally
// gate on the HealthVerdict registry (verdictCanSettle) — membership alone is
// not an achievement.

import {
  createPublicClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { optionalEnv, requireEnv } from "@/lib/server/env";

const HEALTH_POOLS_PARTICIPANT_ABI = [
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
] as const;

// Server-side twin of lib/chains.ts arcTestnet: same chain, but the RPC URL
// comes from server env rather than NEXT_PUBLIC. Same shape as verdict.ts and
// agent/spotter.ts keep privately.
function arcTestnet() {
  const rpcUrl = optionalEnv("ARC_RPC_URL", "https://rpc.testnet.arc.network");
  return defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** True when the address holds this pool's one-wallet-one-entry slot. */
export async function participantJoined(
  poolId: bigint,
  user: Address,
): Promise<boolean> {
  const pools = requireEnv("HEALTH_POOLS_ADDRESS") as Address;
  const publicClient = createPublicClient({
    chain: arcTestnet(),
    transport: http(),
  });
  const participant = await publicClient.readContract({
    address: pools,
    abi: HEALTH_POOLS_PARTICIPANT_ABI,
    functionName: "getParticipant",
    args: [poolId, user],
  });
  return participant.joined;
}

// canSettle is HealthVerdict's settlement predicate: recorded AND verified
// AND confidence above LOW. Deliberately NOT the bare `recorded` mapping —
// that flips true for a rejected (verified=false) verdict too, via
// recordVerdict, onReport, or overrideVerdict, and would wave a rejected
// claim through a payout gate.
const HEALTH_VERDICT_CAN_SETTLE_ABI = [
  {
    type: "function",
    name: "canSettle",
    stateMutability: "view",
    inputs: [{ name: "goalId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * True when the HealthVerdict registry holds a PASSING verdict for this goal
 * — the exact predicate HealthPools.settle() gates payment on.
 *
 * Requires HEALTH_VERDICT_ADDRESS: on the money path a missing registry
 * address must fail loudly (requireEnv throws), never silently wave a payout
 * through. scripts/demo-reset.sh keeps the env var in lockstep with the
 * on-chain settlement gate.
 */
export async function verdictCanSettle(goalId: Hex): Promise<boolean> {
  const registry = requireEnv("HEALTH_VERDICT_ADDRESS") as Address;
  const publicClient = createPublicClient({
    chain: arcTestnet(),
    transport: http(),
  });
  return publicClient.readContract({
    address: registry,
    abi: HEALTH_VERDICT_CAN_SETTLE_ABI,
    functionName: "canSettle",
    args: [goalId],
  });
}
