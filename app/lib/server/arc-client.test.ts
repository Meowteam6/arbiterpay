import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arcTestnet } from "@/lib/chains";
import {
  arcPublicClient,
  arcRpcUrls,
  resetArcClients,
  ttlCache,
} from "@/lib/server/arc-client";

// The defect these tests pin: every server module used a SINGLE Arc endpoint
// with no fallback, and rebuilt its client per call, so one agent run fired six
// to nine separate HTTP requests at one public RPC. Five concurrent users hit
// "request limit reached" and the app answered 500.
//
// What is asserted here: the fallback list is real and ordered, the client is
// shared rather than rebuilt, and concurrent reads leave as ONE batched
// JSON-RPC request rather than one request each.

interface FakeRpc {
  url: string;
  /** One entry per HTTP request; each entry is the parsed JSON body. */
  requests: unknown[];
  close: () => Promise<void>;
}

function answer(method: string): string {
  if (method === "eth_chainId") return "0x4cef52"; // 5042002
  if (method === "eth_blockNumber") return "0x1";
  if (method === "eth_gasPrice") return "0x2";
  return "0x0";
}

async function startFakeRpc(): Promise<FakeRpc> {
  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(parsed);
      const reply = (one: { id: number; method: string }) => ({
        jsonrpc: "2.0",
        id: one.id,
        result: answer(one.method),
      });
      const body = Array.isArray(parsed)
        ? parsed.map(reply)
        : reply(parsed as { id: number; method: string });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

beforeEach(() => {
  resetArcClients();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetArcClients();
});

describe("arcRpcUrls", () => {
  it("defaults to the three public Arc RPCs the browser client already uses", () => {
    vi.stubEnv("ARC_RPC_URL", "");
    expect(arcRpcUrls()).toEqual([...arcTestnet.rpcUrls.default.http]);
    expect(arcRpcUrls().length).toBe(3);
  });

  it("serves ONLY an ARC_RPC_URL override when one is set", () => {
    vi.stubEnv("ARC_RPC_URL", "https://private.example/rpc");
    // An operator who pins an endpoint means it: a private RPC is pinned for
    // policy reasons and a test RPC for hermeticity, and in both cases quietly
    // falling through to a public endpoint defeats the pin. The multi-URL
    // resilience list is for the no-override case only.
    expect(arcRpcUrls()).toEqual(["https://private.example/rpc"]);
  });

  it("treats a public RPC set as the override the same way", () => {
    const first = arcTestnet.rpcUrls.default.http[0];
    vi.stubEnv("ARC_RPC_URL", first);
    expect(arcRpcUrls()).toEqual([first]);
  });
});

describe("arcPublicClient", () => {
  it("is module-scoped, not rebuilt per call", () => {
    vi.stubEnv("ARC_RPC_URL", "");
    expect(arcPublicClient()).toBe(arcPublicClient());
  });

  it("runs a fallback transport over every RPC in order", () => {
    vi.stubEnv("ARC_RPC_URL", "https://private.example/rpc");
    const transport = arcPublicClient().transport as unknown as {
      type: string;
      transports: { value?: { url?: string } }[];
    };
    expect(transport.type).toBe("fallback");
    expect(transport.transports.map((t) => t.value?.url)).toEqual(
      arcRpcUrls(),
    );
  });

  it("rebuilds when ARC_RPC_URL changes so a redeploy is not served a stale endpoint", () => {
    vi.stubEnv("ARC_RPC_URL", "");
    const before = arcPublicClient();
    vi.stubEnv("ARC_RPC_URL", "https://private.example/rpc");
    expect(arcPublicClient()).not.toBe(before);
  });

  it("collapses concurrent reads into ONE batched JSON-RPC request", async () => {
    const rpc = await startFakeRpc();
    try {
      vi.stubEnv("ARC_RPC_URL", rpc.url);
      const client = arcPublicClient();
      const [chainId, gasPrice, blockNumber] = await Promise.all([
        client.getChainId(),
        client.getGasPrice(),
        client.getBlockNumber({ cacheTime: 0 }),
      ]);
      expect(chainId).toBe(5042002);
      expect(gasPrice).toBe(2n);
      expect(blockNumber).toBe(1n);

      // The whole point of batch: three reads, one HTTP request.
      expect(rpc.requests.length).toBe(1);
      expect(Array.isArray(rpc.requests[0])).toBe(true);
      expect((rpc.requests[0] as unknown[]).length).toBe(3);
    } finally {
      await rpc.close();
    }
  });
});

describe("ttlCache", () => {
  it("serves a cached value inside the TTL and reloads after it", async () => {
    const cache = ttlCache<number>({ ttlMs: 30 });
    let loads = 0;
    const load = () => Promise.resolve(++loads);

    expect(await cache.get("k", load)).toBe(1);
    expect(await cache.get("k", load)).toBe(1);
    expect(loads).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(await cache.get("k", load)).toBe(2);
  });

  it("shares one in-flight load across concurrent callers", async () => {
    const cache = ttlCache<string>({ ttlMs: 1_000 });
    let loads = 0;
    const load = () => {
      loads += 1;
      return new Promise<string>((resolve) =>
        setTimeout(() => resolve("value"), 20),
      );
    };
    // A burst of polls must cost one upstream read, not one per poll.
    const results = await Promise.all([
      cache.get("k", load),
      cache.get("k", load),
      cache.get("k", load),
    ]);
    expect(results).toEqual(["value", "value", "value"]);
    expect(loads).toBe(1);
  });

  it("never caches a failure", async () => {
    const cache = ttlCache<string>({ ttlMs: 10_000 });
    let calls = 0;
    const load = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve("recovered");
    };
    await expect(cache.get("k", load)).rejects.toThrow("rpc down");
    // A transient failure must not pin a broken answer for the whole TTL.
    await expect(cache.get("k", load)).resolves.toBe("recovered");
  });

  it("keys entries independently and honours invalidate", async () => {
    const cache = ttlCache<string>({ ttlMs: 10_000 });
    await cache.get("a", () => Promise.resolve("A"));
    await cache.get("b", () => Promise.resolve("B"));
    expect(await cache.get("a", () => Promise.resolve("A2"))).toBe("A");
    cache.invalidate("a");
    expect(await cache.get("a", () => Promise.resolve("A2"))).toBe("A2");
    expect(await cache.get("b", () => Promise.resolve("B2"))).toBe("B");
    cache.invalidate();
    expect(await cache.get("b", () => Promise.resolve("B3"))).toBe("B3");
  });

  it("evicts oldest-first so a long-lived instance cannot grow without bound", async () => {
    const cache = ttlCache<string>({ ttlMs: 10_000, maxEntries: 2 });
    await cache.get("a", () => Promise.resolve("A"));
    await cache.get("b", () => Promise.resolve("B"));
    await cache.get("c", () => Promise.resolve("C"));
    // "a" was evicted, "b" and "c" survive.
    expect(await cache.get("a", () => Promise.resolve("A2"))).toBe("A2");
    expect(await cache.get("c", () => Promise.resolve("C2"))).toBe("C");
  });
});
