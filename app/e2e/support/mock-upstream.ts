// The one mock upstream for the e2e suite: Arc testnet JSON-RPC, the Junction
// wearable provider, the Chainlink Confidential AI attester, and the control
// plane the specs seed fixtures through — all on one port, one process.
//
// WHY ONE SERVER AND NOT page.route()
//
// Almost every external call on Path A is made by the Next server, not the
// browser: /api/evidence/submit talks to the enclave, /api/agent/run reads and
// writes the chain, /api/oracle/record reads Junction. Browser-level request
// interception cannot see any of it. The app is pointed at this process
// instead, through the env it already honours (ARC_RPC_URL, JUNCTION_BASE_URL,
// CONFIDENTIAL_AI_BASE_URL), so the code under test is the real code down to
// the socket. The browser is pointed at the same process for the client-side
// chain reads (see routeArcRpc in support/test.ts), so there is exactly one
// source of fixture truth per test.
//
// The ABI fragments below are deliberately a private copy rather than an
// import from lib/contract.ts: this process is standing in for the CONTRACT,
// and a mock that reads its shape from the app under test cannot catch the app
// getting that shape wrong. The field order of the Pool and Participant tuples
// must mirror HealthPools.sol exactly (a mismatch decodes silently into the
// wrong fields, which is the bug lib/server/agent/spotter.ts warns about).

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_CHAIN_ID,
  MOCK_PORT,
  MOCK_SPOTTER_ADDRESS,
  MOCK_SPOTTER_USDC,
  emptyState,
  goalIdFor,
  participantKey,
  type MockState,
  type ParticipantFixture,
  type PoolFixture,
} from "./protocol";

// ------------------------------------------------------------------- state

let state: MockState = emptyState();

/** Transactions this RPC has "mined", by hash. */
const minedTransactions = new Map<Hex, { to: Address; blockNumber: bigint }>();
/** Broadcast count, served back as every account's transaction nonce. Only the
 *  oracle signer ever broadcasts here, so one counter is the whole story. */
let broadcastCount = 0;
let blockNumber = 1_000n;

function poolById(id: string): PoolFixture | undefined {
  return state.pools.find((p) => p.id === id);
}

function participantFor(
  poolId: bigint,
  user: Address,
): ParticipantFixture | undefined {
  return state.participants[participantKey(poolId, user)];
}

// --------------------------------------------------------------------- abi

const POOL_TUPLE = {
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
} as const;

const PARTICIPANT_TUPLE = {
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
} as const;

/** Every function this RPC can decode, across all three contracts. */
const ABI = [
  // ---- HealthPools
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "uint256" }],
    outputs: [POOL_TUPLE],
  },
  {
    type: "function",
    name: "getParticipant",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [PARTICIPANT_TUPLE],
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
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
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
    name: "joinPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "uint256" },
      { name: "nullifierHash", type: "uint256" },
    ],
    outputs: [],
  },
  // ---- HealthVerdict
  {
    type: "function",
    name: "canSettle",
    stateMutability: "view",
    inputs: [{ name: "goalId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "recorded",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
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
    name: "recordVerdict",
    stateMutability: "nonpayable",
    inputs: [
      { name: "goalId", type: "bytes32" },
      { name: "verified", type: "bool" },
      { name: "confidence", type: "uint8" },
      { name: "digest", type: "bytes32" },
      { name: "facets", type: "uint16" },
    ],
    outputs: [],
  },
  // ---- USDC
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
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
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Goal ids whose verdict has been written to the registry this run. */
const recordedVerdicts = new Set<string>();

// ----------------------------------------------------------------- rpc core

/** A contract-level revert, as opposed to an RPC-level failure. The
 *  distinction is load-bearing: lib/server/evidence.ts decodes NO_POOL out of
 *  a revert to answer "no such pool", and treats anything else as a broken
 *  RPC that must fail loudly. */
class RpcRevert extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * A method this RPC does not serve. It must come back as JSON-RPC -32601 and
 * not as anything else: viem probes optional node APIs (eth_fillTransaction
 * among them) and only falls back to building the transaction itself when the
 * endpoint answers "no such method". Any other error shape aborts the write.
 */
class RpcMethodNotFound extends Error {
  constructor(readonly method: string) {
    super(`the method ${method} does not exist/is not available`);
  }
}

/**
 * Answer one `eth_call`. Reverts are raised as RpcRevert and surface to viem
 * as a proper `execution reverted: REASON` error, which is what
 * lib/server/evidence.ts decodes a missing pool (NO_POOL) out of.
 */
function ethCall(to: Address, data: Hex): Hex {
  const { functionName, args } = decodeFunctionData({ abi: ABI, data });
  const list = (args ?? []) as readonly unknown[];

  switch (functionName) {
    case "poolCount":
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: BigInt(state.pools.length),
      });

    case "getPool": {
      const found = poolById(String(list[0]));
      if (found === undefined) throw new RpcRevert("NO_POOL");
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: {
          creator: found.creator,
          bountyModel: found.bountyModel,
          settled: found.settled,
          periodStart: BigInt(found.periodStart),
          periodEnd: BigInt(found.periodEnd),
          entryFee: BigInt(found.entryFee),
          balance: BigInt(found.balance),
          initiative: found.initiative,
          goalSpec: found.goalSpec,
        },
      });
    }

    case "getParticipant": {
      const found =
        participantFor(list[0] as bigint, list[1] as Address) ??
        ({
          joined: false,
          resultRecorded: false,
          verdict: false,
          multiplierBps: 0,
          nullifierHash: "0",
          backingTotal: "0",
        } satisfies ParticipantFixture);
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: {
          joined: found.joined,
          resultRecorded: found.resultRecorded,
          verdict: found.verdict,
          multiplierBps: found.multiplierBps,
          nullifierHash: BigInt(found.nullifierHash),
          backingTotal: BigInt(found.backingTotal),
        },
      });
    }

    case "getParticipants": {
      const prefix = `${String(list[0])}:`;
      const members = Object.entries(state.participants)
        .filter(([key, value]) => key.startsWith(prefix) && value.joined)
        .map(([key]) => key.slice(prefix.length) as Address);
      return encodeFunctionResult({ abi: ABI, functionName, result: members });
    }

    case "computeGoalId":
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: goalIdFor(list[0] as bigint, list[1] as Address),
      });

    case "oracle":
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: state.oracleRole,
      });

    case "attester":
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: state.attesterRole,
      });

    case "recorded":
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: recordedVerdicts.has(String(list[0]).toLowerCase()),
      });

    case "canSettle":
      // The registry's settlement predicate: a PASSING verdict is on record.
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: recordedVerdicts.has(String(list[0]).toLowerCase()),
      });

    case "balanceOf":
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: BigInt(
          state.usdcBalances[String(list[0]).toLowerCase()] ?? "0",
        ),
      });

    case "allowance":
      return encodeFunctionResult({ abi: ABI, functionName, result: 0n });

    // Writes reach eth_call through viem's simulateContract preflight. The
    // mock accepts them there and applies the state change on broadcast.
    case "recordResult":
    case "recordVerdict":
    case "settle":
    case "joinPool":
      return "0x";
    case "approve":
      return encodeFunctionResult({ abi: ABI, functionName, result: true });

    default:
      throw new Error(`mock RPC has no answer for ${functionName}`);
  }
}

/** Apply the state change a broadcast transaction represents. */
function applyTransaction(data: Hex): void {
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({ abi: ABI, data });
  } catch {
    return; // not one of ours; the receipt still succeeds
  }
  const list = (decoded.args ?? []) as readonly unknown[];

  if (decoded.functionName === "recordResult") {
    const key = participantKey(list[0] as bigint, list[1] as Address);
    const existing = state.participants[key];
    if (existing !== undefined) {
      existing.resultRecorded = true;
      existing.verdict = list[2] as boolean;
      existing.multiplierBps = Number(list[3]);
    }
  }

  if (decoded.functionName === "recordVerdict") {
    // Only a PASSING verdict opens the canSettle gate, exactly as the registry
    // behaves: recording a rejection must not make a claim settleable.
    if (list[1] === true) recordedVerdicts.add(String(list[0]).toLowerCase());
  }

  if (decoded.functionName === "settle") {
    const found = poolById(String(list[0]));
    if (found !== undefined) found.settled = true;
  }
}

function blockAt(number: bigint): Record<string, unknown> {
  return {
    number: toHex(number),
    hash: keccak256(toHex(`block-${number}`)),
    parentHash: keccak256(toHex(`block-${number - 1n}`)),
    nonce: "0x0000000000000000",
    sha3Uncles: `0x${"0".repeat(64)}`,
    logsBloom: `0x${"0".repeat(512)}`,
    transactionsRoot: `0x${"0".repeat(64)}`,
    stateRoot: `0x${"0".repeat(64)}`,
    receiptsRoot: `0x${"0".repeat(64)}`,
    miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x400",
    gasLimit: "0x1c9c380",
    gasUsed: "0x5208",
    baseFeePerGas: "0x3b9aca00",
    timestamp: toHex(BigInt(Math.floor(Date.now() / 1000))),
    uncles: [],
    transactions: [],
  };
}

function rpcResult(method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId":
      return toHex(ARC_CHAIN_ID);
    case "net_version":
      return String(ARC_CHAIN_ID);
    case "web3_clientVersion":
      return "gohealthme-e2e-mock/1.0";

    case "eth_blockNumber":
      blockNumber += 1n;
      return toHex(blockNumber);

    case "eth_getBlockByNumber":
    case "eth_getBlockByHash":
      return blockAt(blockNumber);

    case "eth_call": {
      const call = params[0] as { to?: Address; data?: Hex };
      return ethCall(call.to as Address, (call.data ?? "0x") as Hex);
    }

    case "eth_getLogs":
      // Pool discovery falls back to poolCount enumeration when the log query
      // yields nothing, which is the path this mock exercises. AchieverPaid
      // searches find nothing too: no claim in this suite reaches settlement.
      return [];

    case "eth_getTransactionCount":
      return toHex(broadcastCount);

    case "eth_estimateGas":
      return "0x186a0";
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return "0x3b9aca00";

    case "eth_sendRawTransaction": {
      const raw = String(params[0]) as Hex;
      // The transaction hash IS the keccak of the signed payload, so a
      // rebroadcast of the same transaction hashes identically here too.
      const hash = keccak256(raw);
      const tx = parseTransaction(raw);
      broadcastCount += 1;
      blockNumber += 1n;
      minedTransactions.set(hash, {
        to: (tx.to ?? "0x") as Address,
        blockNumber,
      });
      if (tx.data !== undefined) applyTransaction(tx.data as Hex);
      return hash;
    }

    case "eth_getTransactionReceipt": {
      const hash = String(params[0]) as Hex;
      const mined = minedTransactions.get(hash);
      if (mined === undefined) return null;
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: keccak256(toHex(`block-${mined.blockNumber}`)),
        blockNumber: toHex(mined.blockNumber),
        from: "0x0000000000000000000000000000000000000000",
        to: mined.to,
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        status: "0x1",
        effectiveGasPrice: "0x3b9aca00",
        type: "0x2",
      };
    }

    case "eth_getTransactionByHash": {
      const hash = String(params[0]) as Hex;
      const mined = minedTransactions.get(hash);
      if (mined === undefined) return null;
      return {
        hash,
        nonce: "0x0",
        blockHash: keccak256(toHex(`block-${mined.blockNumber}`)),
        blockNumber: toHex(mined.blockNumber),
        transactionIndex: "0x0",
        from: "0x0000000000000000000000000000000000000000",
        to: mined.to,
        value: "0x0",
        gas: "0x186a0",
        gasPrice: "0x3b9aca00",
        input: "0x",
        type: "0x2",
      };
    }

    default:
      throw new RpcMethodNotFound(method);
  }
}

interface RpcRequest {
  id?: number | string;
  method: string;
  params?: unknown[];
}

function handleRpc(request: RpcRequest): Record<string, unknown> {
  const base = { jsonrpc: "2.0", id: request.id ?? null };
  try {
    return { ...base, result: rpcResult(request.method, request.params ?? []) };
  } catch (err) {
    if (err instanceof RpcRevert) {
      // Shape matters: viem decodes `execution reverted: X` into a
      // ContractFunctionRevertedError, which is how the app tells "no such
      // pool" apart from "the RPC is broken".
      return {
        ...base,
        error: {
          code: 3,
          message: `execution reverted: ${err.reason}`,
          data: "0x",
        },
      };
    }
    if (err instanceof RpcMethodNotFound) {
      return { ...base, error: { code: -32601, message: err.message } };
    }
    return {
      ...base,
      error: { code: -32000, message: (err as Error).message },
    };
  }
}

// --------------------------------------------------------------- junction

let junctionUserSeq = 0;
const junctionUsers = new Map<string, string>();

function junctionUserId(clientUserId: string): string {
  const existing = junctionUsers.get(clientUserId);
  if (existing !== undefined) return existing;
  junctionUserSeq += 1;
  const id = `jx-user-${junctionUserSeq}`;
  junctionUsers.set(clientUserId, id);
  return id;
}

function handleJunction(
  path: string,
  method: string,
  body: string,
): { status: number; payload: unknown } {
  if (state.junction.mode === "down") {
    // 503 is retryable-shaped, which is what the app's own resilience layer
    // treats as an outage rather than an answer.
    return { status: 503, payload: { detail: "provider unavailable" } };
  }

  if (method === "GET" && path.startsWith("/v2/user/resolve/")) {
    const clientUserId = decodeURIComponent(
      path.slice("/v2/user/resolve/".length),
    );
    if (!junctionUsers.has(clientUserId)) {
      return { status: 404, payload: { detail: "user not found" } };
    }
    return {
      status: 200,
      payload: { user_id: junctionUserId(clientUserId), client_user_id: clientUserId },
    };
  }

  if (method === "POST" && path === "/v2/user") {
    const parsed = JSON.parse(body === "" ? "{}" : body) as {
      client_user_id?: string;
    };
    const clientUserId = parsed.client_user_id ?? "anonymous";
    return {
      status: 200,
      payload: { user_id: junctionUserId(clientUserId), client_user_id: clientUserId },
    };
  }

  if (method === "GET" && path.startsWith("/v2/user/providers/")) {
    return {
      status: 200,
      payload: {
        providers: state.junction.connected
          ? [{ slug: "whoop", status: "connected" }]
          : [],
      },
    };
  }

  if (method === "GET" && path.startsWith("/v2/summary/sleep/")) {
    return {
      status: 200,
      payload: {
        sleep: state.junction.days.map((day) => ({
          calendar_date: day.date,
          score: day.score,
        })),
      },
    };
  }

  if (method === "POST" && path === "/v2/link/token") {
    return { status: 200, payload: { link_token: "jx-link-token-e2e" } };
  }

  return { status: 404, payload: { detail: `no junction route for ${path}` } };
}

// --------------------------------------------------------------- attester

let attesterSeq = 0;
const attesterJobs = new Set<string>();
/** Every prompt that crossed the enclave boundary, so a test can assert on
 *  WHAT was asked rather than only on the answer. */
const attesterPrompts: string[] = [];

function handleAttester(
  path: string,
  method: string,
  body: string,
): { status: number; payload: unknown } {
  if (method === "POST" && path === "/v1/inference") {
    if (state.attester.submit === "unreachable") {
      return { status: 503, payload: { detail: "enclave unavailable" } };
    }
    const submitted = JSON.parse(body === "" ? "{}" : body) as {
      prompt?: string;
    };
    attesterPrompts.push(submitted.prompt ?? "");
    attesterSeq += 1;
    const id = `e2e-inference-${attesterSeq}`;
    attesterJobs.add(id);
    return { status: 202, payload: { id, status: "queued" } };
  }

  if (method === "GET" && path.startsWith("/v1/inference/")) {
    const id = decodeURIComponent(path.slice("/v1/inference/".length));
    if (state.attester.poll === "unreachable") {
      return { status: 503, payload: { detail: "enclave unavailable" } };
    }
    if (!attesterJobs.has(id)) {
      return { status: 404, payload: { detail: "unknown inference" } };
    }
    if (state.attester.poll === "running") {
      return { status: 200, payload: { id, status: "running" } };
    }
    if (state.attester.poll === "failed") {
      return { status: 200, payload: { id, status: "failed" } };
    }
    return {
      status: 200,
      payload: { id, status: "completed", output: state.attester.output },
    };
  }

  return { status: 404, payload: { detail: `no attester route for ${path}` } };
}

// ----------------------------------------------------------------- circle

/**
 * The two Circle reads /api/agent/wallet performs, and nothing more.
 *
 * The SDK unwraps Circle's `{ data: ... }` envelope before the app sees it,
 * so these payloads carry the envelope exactly as api.circle.com would.
 * `CIRCLE_WALLET_ID` is a placeholder in this suite; whatever id the app asks
 * for is echoed back, because the identity under test is the address, not the
 * id. Every other Circle endpoint — all of them writes — stays refused.
 */
function handleCircle(
  path: string,
  method: string,
): { status: number; payload: unknown } {
  const balances = path.match(/^\/v1\/w3s\/wallets\/([^/]+)\/balances$/);
  if (method === "GET" && balances !== null) {
    return {
      status: 200,
      payload: {
        data: {
          tokenBalances: [
            {
              token: { symbol: "USDC", id: "e2e-usdc-token" },
              amount: MOCK_SPOTTER_USDC,
            },
          ],
        },
      },
    };
  }

  const wallet = path.match(/^\/v1\/w3s\/wallets\/([^/]+)$/);
  if (method === "GET" && wallet !== null) {
    return {
      status: 200,
      payload: {
        data: {
          wallet: {
            id: decodeURIComponent(wallet[1]),
            address: MOCK_SPOTTER_ADDRESS,
            blockchain: "ARC-TESTNET",
            accountType: "EOA",
          },
        },
      },
    };
  }

  return {
    status: 501,
    payload: {
      code: 501,
      message: `the Circle API is stubbed out in this suite (${path})`,
    },
  };
}

// ----------------------------------------------------------------- server

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    // The browser reads the RPC through this server too (routeArcRpc in
    // support/test.ts proxies it), and a preflight-free POST needs these.
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

/** Everything a fresh test must not inherit from the previous one. */
function resetRuntime(): void {
  minedTransactions.clear();
  recordedVerdicts.clear();
  attesterJobs.clear();
  attesterPrompts.length = 0;
  junctionUsers.clear();
  broadcastCount = 0;
  attesterSeq = 0;
  junctionUserSeq = 0;
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = (request.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "POST, GET, OPTIONS",
      });
      response.end();
      return;
    }

    if (path === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    const body = await readBody(request);

    if (path === "/__fixtures__") {
      if (method === "GET") {
        sendJson(response, 200, { ...state, attesterPrompts });
        return;
      }
      state = JSON.parse(body) as MockState;
      resetRuntime();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (path === "/rpc") {
      const parsed = JSON.parse(body) as RpcRequest | RpcRequest[];
      // viem's shared transport batches concurrent reads into one array.
      const payload = Array.isArray(parsed)
        ? parsed.map(handleRpc)
        : handleRpc(parsed);
      sendJson(response, 200, payload);
      return;
    }

    if (path.startsWith("/junction")) {
      const result = handleJunction(path.slice("/junction".length), method, body);
      sendJson(response, result.status, result.payload);
      return;
    }

    if (path.startsWith("/attester")) {
      const result = handleAttester(
        path.slice("/attester".length),
        method,
        body,
      );
      sendJson(response, result.status, result.payload);
      return;
    }

    if (path.startsWith("/circle")) {
      // CIRCLE_API_BASE_URL points here so no Circle SDK call can reach
      // api.circle.com from a test run. The only Circle traffic Path A is
      // supposed to produce is /api/agent/wallet reading SPOTTER's identity
      // back (SPOTTER_WALLET_ADDRESS is unset, so the run loop never signs
      // with Circle), so this stub answers exactly those two reads with a
      // provisioned wallet — the console and the header strip render the real
      // agent state instead of a not-configured error card — and refuses
      // everything else: any write reaching here is a bug worth failing on.
      const result = handleCircle(path.slice("/circle".length), method);
      sendJson(response, result.status, result.payload);
      return;
    }

    sendJson(response, 404, { detail: `no mock route for ${path}` });
  })().catch((err: unknown) => {
    sendJson(response, 500, { detail: String(err) });
  });
});

server.listen(MOCK_PORT, "127.0.0.1", () => {
  console.log(
    `[mock-upstream] arc rpc + junction + attester listening on ${MOCK_PORT}`,
  );
});
