import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateUser } from "@/lib/server/junction";

// Two defects pinned here:
//   1. getOrCreateUser re-resolved the wallet -> Junction user_id mapping on
//      every call, so one 800ms dashboard poll cost three HTTP round-trips
//      where one would do. The mapping never changes once created.
//   2. No Junction request had a timeout, so a hung upstream consumed the whole
//      60s function budget and took the request down with it.
//
// The module cache is process-wide, so every test uses its own address.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function resolveOnlyFetch(userId: string) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v2/user/resolve/")) {
      return Promise.resolve(Response.json({ user_id: userId }));
    }
    return Promise.resolve(Response.json({ user_id: userId }, { status: 201 }));
  });
}

describe("getOrCreateUser memoization", () => {
  it("resolves a wallet once and serves later calls from the cache", async () => {
    vi.stubEnv("JUNCTION_API_KEY", "test-key");
    const fetchMock = resolveOnlyFetch("vital-1");
    vi.stubGlobal("fetch", fetchMock);

    const address = "0x1111111111111111111111111111111111111111";
    expect(await getOrCreateUser(address)).toBe("vital-1");
    expect(await getOrCreateUser(address.toUpperCase())).toBe("vital-1");
    expect(await getOrCreateUser(address)).toBe("vital-1");

    // Three calls, one round-trip. This is the poll cost that used to triple.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight resolve across a burst of concurrent callers", async () => {
    vi.stubEnv("JUNCTION_API_KEY", "test-key");
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(Response.json({ user_id: "vital-2" })), 20),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const address = "0x2222222222222222222222222222222222222222";
    const results = await Promise.all([
      getOrCreateUser(address),
      getOrCreateUser(address),
      getOrCreateUser(address),
    ]);
    expect(results).toEqual(["vital-2", "vital-2", "vital-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure", async () => {
    vi.stubEnv("JUNCTION_API_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        // First pass: both resolve attempts and the create fail. Second pass:
        // the resolve works.
        return calls <= 3
          ? Promise.resolve(new Response("down", { status: 500 }))
          : Promise.resolve(Response.json({ user_id: "vital-3" }));
      }),
    );

    const address = "0x3333333333333333333333333333333333333333";
    await expect(getOrCreateUser(address)).rejects.toThrow(/Junction/);
    // A transient outage must not pin an unusable entry for the whole TTL.
    await expect(getOrCreateUser(address)).resolves.toBe("vital-3");
  });

  it("creates the user when the resolve says not found", async () => {
    vi.stubEnv("JUNCTION_API_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/v2/user/resolve/")
        ? Promise.resolve(new Response("not found", { status: 404 }))
        : Promise.resolve(Response.json({ user_id: "vital-4" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const address = "0x4444444444444444444444444444444444444444";
    expect(await getOrCreateUser(address)).toBe("vital-4");
    // A 404 on resolve is the normal not-created-yet path, not a retryable
    // failure: one resolve, one create.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("junction request timeouts", () => {
  it("a hung Junction aborts on the timeout instead of consuming the budget", async () => {
    const sockets = new Set<Socket>();
    const server: Server = createServer(() => {
      // Never answers.
    });
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      vi.stubEnv("JUNCTION_API_KEY", "test-key");
      vi.stubEnv("JUNCTION_BASE_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("JUNCTION_TIMEOUT_MS", "150");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const started = Date.now();
      await expect(
        getOrCreateUser("0x5555555555555555555555555555555555555555"),
      ).rejects.toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
