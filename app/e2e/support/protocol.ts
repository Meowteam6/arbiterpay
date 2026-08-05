// Shared contract between the Playwright specs, the Playwright config and the
// mock upstream server (e2e/support/mock-upstream.ts).
//
// Everything the e2e suite treats as "the outside world" — Arc testnet, the
// Junction wearable provider, the Chainlink Confidential AI attester — is
// described here as plain data. The mock server is the only thing that speaks
// those protocols; specs only ever hand it one of these fixtures.
//
// NOTHING IN THIS FILE IS A CREDENTIAL. The addresses are made-up constants,
// the oracle header value is a literal the mock stack invents for itself, and
// the oracle signing material is DERIVED at runtime from a public string in
// this file, so no key material is ever committed. All of it is local to the
// test run and none of it can reach a real chain: every RPC endpoint the
// server under test is pointed at is the mock on 127.0.0.1.

import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";

// ------------------------------------------------------------------- ports

/** The Next dev server under test. Deliberately not 3000 so a developer's own
 *  `npm run dev` is never clobbered by a test run. */
export const APP_PORT = 3100;
/** The single mock upstream (Arc RPC + Junction + attester + control plane). */
export const MOCK_PORT = 3111;

/**
 * `localhost`, not `127.0.0.1`: Next 16 dev blocks cross-origin access to its
 * own dev resources (the HMR socket among them) for any host that is not the
 * one it is serving under, and a blocked HMR socket means the page never
 * hydrates — every client component would sit in its server-rendered skeleton
 * forever and every interaction test would fail for a reason that has nothing
 * to do with the app.
 */
export const APP_BASE_URL = `http://localhost:${APP_PORT}`;
export const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
export const MOCK_RPC_URL = `${MOCK_BASE_URL}/rpc`;
export const MOCK_JUNCTION_URL = `${MOCK_BASE_URL}/junction`;
export const MOCK_ATTESTER_URL = `${MOCK_BASE_URL}/attester`;
export const MOCK_CONTROL_URL = `${MOCK_BASE_URL}/__fixtures__`;

// --------------------------------------------------------------- addresses

/** The HealthPools deployment the whole run pretends exists. */
export const HEALTH_POOLS_ADDRESS: Address =
  "0x1111111111111111111111111111111111111111";
/** The HealthVerdict registry — the gate `settle()` pays on. */
export const HEALTH_VERDICT_ADDRESS: Address =
  "0x2222222222222222222222222222222222222222";
/** Arc's canonical USDC ERC-20 interface (mirrors lib/contract.ts). */
export const USDC_ADDRESS: Address =
  "0x3600000000000000000000000000000000000000";

export const ARC_CHAIN_ID = 5042002;

// ------------------------------------------------ local, invented, inert

/**
 * The `x-oracle-secret` value the oracle push route is configured with for
 * this run. Invented here and checked against itself; it authenticates nothing
 * outside the test process.
 */
export const ORACLE_HEADER_VALUE = "e2e-oracle-header-value-not-a-credential";

/**
 * Throwaway Arc signing material for the oracle writes.
 *
 * Derived, never written down: it is the keccak hash of a public string in
 * this file, so the repository contains no key material and every checkout
 * produces the same account. It signs only transactions addressed to the mock
 * RPC on 127.0.0.1 and holds nothing anywhere.
 */
export const E2E_ORACLE_SIGNER: Hex = keccak256(
  toHex("gohealthme-e2e-oracle-signer"),
);

/** Placeholder token for upstreams that are configured but never invoked. */
export const PLACEHOLDER_TOKEN = "e2e-placeholder-not-a-credential";

/**
 * Circle's SDK validates that its entity secret is 32 bytes of hex before it
 * will construct a client, and the agent-run route constructs one on every
 * request even though SPOTTER_WALLET_ADDRESS is unset and that route never
 * calls it. Derived, like the signer above. The one route that DOES call the
 * SDK (/api/agent/wallet, behind the /agent console) is pointed at the mock's
 * /circle stub through CIRCLE_API_BASE_URL, so this value authenticates
 * nothing anywhere.
 */
export const PLACEHOLDER_ENTITY_HEX = keccak256(
  toHex("gohealthme-e2e-circle-entity"),
).slice(2);

// --------------------------------------------------------------- goal ids

/**
 * The goal id HealthPools derives for a (pool, participant) pair.
 *
 * The real contract is the authority and the app always reads it back rather
 * than deriving it, so the mock has to answer `computeGoalId` consistently and
 * the specs have to be able to predict it. Both call this.
 */
export function goalIdFor(poolId: bigint, user: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }],
      [poolId, user],
    ),
  );
}

// --------------------------------------------------------------- fixtures

/** One pool as HealthPools.getPool would return it. */
export interface PoolFixture {
  /** Decimal string: JSON has no bigint. */
  id: string;
  creator: Address;
  /** 0 = fixed bounty per achiever, 1 = pro-rata pot split. */
  bountyModel: number;
  settled: boolean;
  /** Epoch seconds, decimal string. */
  periodStart: string;
  periodEnd: string;
  /** 6-decimal USDC base units, decimal string. */
  entryFee: string;
  balance: string;
  initiative: string;
  /** A leading "[doc]" marker makes it a document-verified goal. */
  goalSpec: string;
}

/** One participant as HealthPools.getParticipant would return it. */
export interface ParticipantFixture {
  joined: boolean;
  resultRecorded: boolean;
  verdict: boolean;
  multiplierBps: number;
  nullifierHash: string;
  backingTotal: string;
}

/**
 * How the Chainlink Confidential AI attester behaves this test.
 *
 * `submit`/`poll` model the two failure axes the app distinguishes and must
 * never conflate: an attester that refuses the job (durable, a verdict) versus
 * one we cannot reach (retryable, NOT a verdict).
 */
export interface AttesterFixture {
  submit: "accept" | "unreachable";
  poll: "completed" | "running" | "failed" | "unreachable";
  /** Raw `output` text for a completed inference — the app parses JSON out of
   *  it, so a malformed body is expressible here too. */
  output: string;
}

/** How the Junction wearable provider behaves this test. */
export interface JunctionFixture {
  /** "down" makes every Junction call answer 503. */
  mode: "up" | "down";
  /** Whether the wallet has any provider linked. */
  connected: boolean;
  /** Per-day sleep scores, `YYYY-MM-DD` keyed. */
  days: Array<{ date: string; score: number }>;
}

export interface MockState {
  pools: PoolFixture[];
  /** Keyed `${poolId}:${lowercased address}`. */
  participants: Record<string, ParticipantFixture>;
  /** Keyed by lowercased address, 6-decimal USDC base units. */
  usdcBalances: Record<string, string>;
  /** The account HealthPools trusts as its oracle. */
  oracleRole: Address;
  /** The account HealthVerdict trusts as its attester. */
  attesterRole: Address;
  attester: AttesterFixture;
  junction: JunctionFixture;
}

/**
 * The fixture plus what the app has since done to it: the chain writes it
 * landed and the prompts that actually crossed the enclave boundary. Read
 * back after a run to assert on effects rather than on responses.
 */
export interface MockSnapshot extends MockState {
  /** Every `prompt` the attester was sent, in order. */
  attesterPrompts: string[];
}

export const VERIFIED_OUTPUT = JSON.stringify({
  verified: true,
  confidence: "high",
  reason: "The uploaded panel shows total cholesterol under 200 mg/dL.",
});

export const REJECTED_OUTPUT = JSON.stringify({
  verified: false,
  confidence: "high",
  reason:
    "The uploaded document does not show the screening this goal asks for.",
});

/** A clean slate: no pools, no participants, provider up, attester agreeable. */
export function emptyState(): MockState {
  return {
    pools: [],
    participants: {},
    usdcBalances: {},
    oracleRole: "0x0000000000000000000000000000000000000000",
    attesterRole: "0x0000000000000000000000000000000000000000",
    attester: { submit: "accept", poll: "completed", output: VERIFIED_OUTPUT },
    junction: { mode: "up", connected: true, days: [] },
  };
}

export function participantKey(poolId: bigint | string, user: Address): string {
  return `${poolId.toString()}:${user.toLowerCase()}`;
}

/** A participant who holds the pool's one-wallet-one-entry slot. */
export function joinedParticipant(): ParticipantFixture {
  return {
    joined: true,
    resultRecorded: false,
    verdict: false,
    multiplierBps: 0,
    nullifierHash: "0",
    backingTotal: "0",
  };
}

const HOUR = 3600;

/** Epoch-seconds helper so fixtures can talk in "an hour from now". */
export function secondsFromNow(seconds: number): string {
  return String(Math.floor(Date.now() / 1000) + seconds);
}

export interface PoolOptions {
  id: string;
  initiative?: string;
  goal?: string;
  /** Document-verified when true — prefixes the on-chain "[doc]" marker. */
  document?: boolean;
  entryFee?: string;
  balance?: string;
  settled?: boolean;
  startsInSeconds?: number;
  endsInSeconds?: number;
  bountyModel?: number;
}

/** Build one pool fixture, defaulting to a live, funded, joinable pool. */
export function pool(options: PoolOptions): PoolFixture {
  const goal = options.goal ?? "Sleep 7 nights with a score of 75 or higher";
  return {
    id: options.id,
    creator: "0x00000000000000000000000000000000c0ffee00",
    bountyModel: options.bountyModel ?? 1,
    settled: options.settled ?? false,
    periodStart: secondsFromNow(options.startsInSeconds ?? -HOUR),
    periodEnd: secondsFromNow(options.endsInSeconds ?? 24 * HOUR),
    entryFee: options.entryFee ?? "0",
    balance: options.balance ?? "50000000", // 50.00 USDC
    initiative: options.initiative ?? "Sleep Streak",
    goalSpec: options.document === true ? `[doc] ${goal}` : goal,
  };
}

/** A run of `count` nights all scoring `score`, ending yesterday. */
export function sleepDays(
  count: number,
  score: number,
): Array<{ date: string; score: number }> {
  const days: Array<{ date: string; score: number }> = [];
  for (let back = 1; back <= count; back += 1) {
    const day = new Date(Date.now() - back * 24 * HOUR * 1000);
    days.push({ date: day.toISOString().slice(0, 10), score });
  }
  return days;
}
