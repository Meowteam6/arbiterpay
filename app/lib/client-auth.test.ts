// The browser half of the ownership proof. What matters here is not that a
// signature is produced - it is that ONE is produced per session (the claim
// loop polls every 800ms and a prompt per poll is unusable), that a refused
// prompt is a state and not an exception, and that the credential goes to this
// app's routes and nowhere else.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { walletAuthMessage } from "@/lib/server/wallet-auth";
import { verifyWalletSignature } from "@/lib/server/wallet-auth";
import {
  CLIENT_WALLET_AUTH_TTL_MS,
  WALLET_AUTH_ADDRESS_HEADER,
  WALLET_AUTH_SIGNATURE_HEADER,
  WALLET_AUTH_TIMESTAMP_HEADER,
  authBlockReason,
  authHeadersOf,
  cachedWalletAuth,
  clearWalletAuth,
  clientWalletAuthMessage,
  credentialUsableAt,
  fetchInputUrl,
  fetchWithWalletAuth,
  getWalletAuth,
  isUserRejection,
  shouldAttachWalletAuth,
  walletAuthFetch,
  type ClientAuth,
} from "@/lib/client-auth";

const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const ADDRESS = OWNER.address;
const NOW = Date.parse("2026-08-04T12:00:00.000Z");

function credential(overrides: Partial<{ address: string; timestamp: string; signature: string }> = {}) {
  return {
    address: ADDRESS,
    timestamp: new Date(NOW).toISOString(),
    signature: `0x${"ab".repeat(65)}`,
    ...overrides,
  };
}

beforeEach(() => {
  clearWalletAuth();
});

describe("clientWalletAuthMessage", () => {
  it("renders the exact string the server verifies", () => {
    // The one test that matters for interop: this module mirrors the server's
    // message rather than importing it (server code stays out of the client
    // bundle), so drift between the two has to fail here.
    const timestamp = new Date(NOW).toISOString();
    expect(clientWalletAuthMessage(ADDRESS, timestamp)).toBe(
      walletAuthMessage(ADDRESS, timestamp),
    );
  });
});

describe("credentialUsableAt", () => {
  it("accepts a fresh credential for the same address in any casing", () => {
    expect(
      credentialUsableAt(credential(), ADDRESS.toLowerCase(), NOW + 1_000),
    ).toBe(true);
  });

  it("refuses another address's credential", () => {
    expect(
      credentialUsableAt(
        credential(),
        "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        NOW,
      ),
    ).toBe(false);
  });

  it("refuses one that has aged past the reuse window", () => {
    expect(
      credentialUsableAt(credential(), ADDRESS, NOW + CLIENT_WALLET_AUTH_TTL_MS),
    ).toBe(false);
  });

  it("stays inside the server's ten minute window with room for clock drift", () => {
    expect(CLIENT_WALLET_AUTH_TTL_MS).toBeLessThan(10 * 60 * 1000);
  });

  it("refuses a credential signed in the future", () => {
    // The clock moved backwards mid-session; a negative age must not read as
    // fresh forever.
    expect(credentialUsableAt(credential(), ADDRESS, NOW - 5_000)).toBe(false);
  });

  it("refuses an unparseable timestamp", () => {
    expect(
      credentialUsableAt(credential({ timestamp: "whenever" }), ADDRESS, NOW),
    ).toBe(false);
  });
});

describe("getWalletAuth", () => {
  it("signs once and serves every later call from the cache", async () => {
    const signMessage = vi.fn().mockResolvedValue(`0x${"11".repeat(65)}`);
    const params = { address: ADDRESS, signMessage, now: () => NOW };

    const first = await getWalletAuth(params);
    const second = await getWalletAuth(params);

    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(first.kind).toBe("ok");
    expect(second).toEqual(first);
  });

  it("produces a signature the server accepts", async () => {
    const auth = await getWalletAuth({
      address: ADDRESS,
      signMessage: (message) => OWNER.signMessage({ message }),
      now: () => NOW,
    });
    expect(auth.kind).toBe("ok");
    if (auth.kind !== "ok") return;

    const verified = await verifyWalletSignature({
      address: auth.headers[WALLET_AUTH_ADDRESS_HEADER],
      timestamp: auth.headers[WALLET_AUTH_TIMESTAMP_HEADER],
      signature: auth.headers[WALLET_AUTH_SIGNATURE_HEADER],
      now: NOW,
    });
    expect(verified.ok).toBe(true);
  });

  it("prompts once for concurrent callers", async () => {
    // Three surfaces mount at the same moment; the user must see one prompt.
    let resolve: ((value: string) => void) | undefined;
    const signMessage = vi.fn(
      () => new Promise<string>((r) => (resolve = r)),
    );
    const params = { address: ADDRESS, signMessage, now: () => NOW };

    const all = Promise.all([
      getWalletAuth(params),
      getWalletAuth(params),
      getWalletAuth(params),
    ]);
    resolve?.(`0x${"22".repeat(65)}`);
    const results = await all;

    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.kind === "ok")).toBe(true);
  });

  it("signs again once the cached credential ages out", async () => {
    const signMessage = vi.fn().mockResolvedValue(`0x${"33".repeat(65)}`);
    await getWalletAuth({ address: ADDRESS, signMessage, now: () => NOW });
    await getWalletAuth({
      address: ADDRESS,
      signMessage,
      now: () => NOW + CLIENT_WALLET_AUTH_TTL_MS + 1,
    });
    expect(signMessage).toHaveBeenCalledTimes(2);
  });

  it("re-signs on demand, which is what a 401 against a cached credential needs", async () => {
    const signMessage = vi.fn().mockResolvedValue(`0x${"44".repeat(65)}`);
    await getWalletAuth({ address: ADDRESS, signMessage, now: () => NOW });
    await getWalletAuth({
      address: ADDRESS,
      signMessage,
      refresh: true,
      now: () => NOW,
    });
    expect(signMessage).toHaveBeenCalledTimes(2);
  });

  it("never caches one wallet's credential under another", async () => {
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const signMessage = vi.fn().mockResolvedValue(`0x${"55".repeat(65)}`);
    await getWalletAuth({ address: ADDRESS, signMessage, now: () => NOW });
    const auth = await getWalletAuth({
      address: other,
      signMessage,
      now: () => NOW,
    });
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(auth.kind === "ok" && auth.credential.address).toBe(other);
  });

  it("reports a wallet that is not connected", async () => {
    expect(
      await getWalletAuth({ address: null, signMessage: null }),
    ).toEqual({ kind: "no-wallet" });
  });

  it("reports a refused prompt as a choice, not a failure", async () => {
    const auth = await getWalletAuth({
      address: ADDRESS,
      signMessage: () =>
        Promise.reject(
          Object.assign(new Error("User rejected the request."), { code: 4001 }),
        ),
      now: () => NOW,
    });
    expect(auth).toEqual({ kind: "declined" });
    // A refusal is not remembered as a credential.
    expect(cachedWalletAuth(ADDRESS, NOW)).toBeNull();
  });

  it("reports any other signer failure with its message", async () => {
    const auth = await getWalletAuth({
      address: ADDRESS,
      signMessage: () => Promise.reject(new Error("wallet is on the wrong chain")),
      now: () => NOW,
    });
    expect(auth).toEqual({
      kind: "failed",
      message: "wallet is on the wrong chain",
    });
  });

  it("refuses a signature that is not 0x hex rather than sending it", async () => {
    const auth = await getWalletAuth({
      address: ADDRESS,
      signMessage: () => Promise.resolve("nope"),
      now: () => NOW,
    });
    expect(auth.kind).toBe("failed");
  });

  it("never prompts in cachedOnly mode", async () => {
    const signMessage = vi.fn().mockResolvedValue(`0x${"66".repeat(65)}`);
    const auth = await getWalletAuth({
      address: ADDRESS,
      signMessage,
      cachedOnly: true,
      now: () => NOW,
    });
    expect(signMessage).not.toHaveBeenCalled();
    expect(auth).toEqual({ kind: "unsigned" });
  });

  it("serves cachedOnly readers from a credential another surface collected", async () => {
    const signMessage = vi.fn().mockResolvedValue(`0x${"77".repeat(65)}`);
    await getWalletAuth({ address: ADDRESS, signMessage, now: () => NOW });
    const auth = await getWalletAuth({
      address: ADDRESS,
      signMessage,
      cachedOnly: true,
      now: () => NOW,
    });
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(auth.kind).toBe("ok");
  });
});

describe("authBlockReason", () => {
  it("says nothing for a successful attempt", () => {
    expect(
      authBlockReason({
        kind: "ok",
        credential: credential(),
        headers: authHeadersOf(credential()),
      }),
    ).toBeNull();
  });

  it("gives every refusal something the person can act on", () => {
    const states: ClientAuth[] = [
      { kind: "no-wallet" },
      { kind: "unsigned" },
      { kind: "declined" },
      { kind: "failed", message: "boom" },
    ];
    for (const state of states) {
      const reason = authBlockReason(state);
      expect(reason).not.toBeNull();
      expect((reason ?? "").length).toBeGreaterThan(20);
    }
  });

  it("promises no charge where a wallet prompt is being asked for", () => {
    expect(authBlockReason({ kind: "declined" })).toMatch(/nothing is charged/i);
  });
});

describe("isUserRejection", () => {
  it("recognises the shapes wallets actually throw", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ name: "UserRejectedRequestError" })).toBe(true);
    expect(isUserRejection(new Error("User denied message signature"))).toBe(
      true,
    );
  });

  it("does not mistake a transport failure for a refusal", () => {
    expect(isUserRejection(new Error("fetch failed"))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});

describe("fetchWithWalletAuth", () => {
  const okAuth = async (): Promise<ClientAuth> => ({
    kind: "ok",
    credential: credential(),
    headers: authHeadersOf(credential()),
  });

  it("attaches the three headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    await fetchWithWalletAuth("/api/agent/run/0x1", undefined, okAuth, fetchImpl);

    const init = fetchImpl.mock.calls[0][1] as { headers: Headers };
    expect(init.headers.get(WALLET_AUTH_ADDRESS_HEADER)).toBe(ADDRESS);
    expect(init.headers.get(WALLET_AUTH_SIGNATURE_HEADER)).not.toBeNull();
  });

  it("keeps the caller's own headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    await fetchWithWalletAuth(
      "/api/agent/run/0x1",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      okAuth,
      fetchImpl,
    );
    const init = fetchImpl.mock.calls[0][1] as { headers: Headers };
    expect(init.headers.get("Content-Type")).toBe("application/json");
  });

  it("still sends the request unsigned, because the redacted answer is useful", async () => {
    // The unsigned answer is what tells the UI a claim EXISTS and is being
    // withheld; refusing to ask would leave a blank upload box instead.
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    const result = await fetchWithWalletAuth(
      "/api/agent/run/0x1",
      undefined,
      async () => ({ kind: "declined" }),
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as { headers: Headers };
    expect(init.headers.get(WALLET_AUTH_ADDRESS_HEADER)).toBeNull();
    expect(result.auth.kind).toBe("declined");
  });

  it("re-signs once when a cached credential is refused", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const requestAuth = vi.fn(okAuth);

    const result = await fetchWithWalletAuth(
      "/api/agent/run/0x1",
      undefined,
      requestAuth,
      fetchImpl,
    );

    expect(requestAuth).toHaveBeenNthCalledWith(2, { refresh: true });
    expect(result.response.status).toBe(200);
  });

  it("does not loop when the retry is refused too", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const requestAuth = vi
      .fn<() => Promise<ClientAuth>>()
      .mockResolvedValueOnce(await okAuth())
      .mockResolvedValueOnce({ kind: "declined" });

    const result = await fetchWithWalletAuth(
      "/api/agent/run/0x1",
      undefined,
      requestAuth,
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.auth.kind).toBe("declined");
  });

  it("does not re-sign a 401 that was already unsigned", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const requestAuth = vi.fn(async (): Promise<ClientAuth> => ({ kind: "unsigned" }));
    await fetchWithWalletAuth("/api/x", undefined, requestAuth, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestAuth).toHaveBeenCalledTimes(1);
  });
});

describe("shouldAttachWalletAuth", () => {
  const origin = "https://gohealthme.example";

  it("attaches to this app's own routes", () => {
    expect(shouldAttachWalletAuth("/api/unlink/register", origin)).toBe(true);
    expect(
      shouldAttachWalletAuth(`${origin}/api/unlink/register`, origin),
    ).toBe(true);
  });

  it("never hands the credential to a third party", () => {
    // The Unlink SDK uses ONE customFetch for our routes and the Engine's
    // host. A wallet-control proof is a bearer credential; the Engine is not
    // the party it was issued to.
    expect(
      shouldAttachWalletAuth(
        "https://arc-testnet-production-api.unlink.xyz/v1/accounts",
        origin,
      ),
    ).toBe(false);
    expect(shouldAttachWalletAuth("//evil.example/api", origin)).toBe(false);
    expect(shouldAttachWalletAuth("http://gohealthme.example/api", origin)).toBe(
      false,
    );
  });
});

describe("walletAuthFetch", () => {
  const origin = "https://gohealthme.example";
  const requestAuth = async (): Promise<ClientAuth> => ({
    kind: "ok",
    credential: credential(),
    headers: authHeadersOf(credential()),
  });

  it("signs a same-origin string request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    const wrapped = walletAuthFetch(requestAuth, origin, fetchImpl);
    await wrapped("/api/unlink/register", { method: "POST" });

    const init = fetchImpl.mock.calls[0][1] as { headers: Headers };
    expect(init.headers.get(WALLET_AUTH_ADDRESS_HEADER)).toBe(ADDRESS);
  });

  it("leaves an Engine request untouched", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    const asked = vi.fn(requestAuth);
    const wrapped = walletAuthFetch(asked, origin, fetchImpl);
    await wrapped("https://engine.unlink.xyz/v1/balances");

    expect(fetchImpl.mock.calls[0][1]).toBeUndefined();
    // Not even read for a foreign host: the credential never goes near it.
    expect(asked).not.toHaveBeenCalled();
  });

  it("merges into a Request's own headers rather than replacing them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    const wrapped = walletAuthFetch(requestAuth, origin, fetchImpl);
    await wrapped(
      new Request(`${origin}/api/unlink/authorization-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );

    const sent = fetchImpl.mock.calls[0][0] as Request;
    expect(sent.headers.get("Content-Type")).toBe("application/json");
    expect(sent.headers.get(WALLET_AUTH_ADDRESS_HEADER)).toBe(ADDRESS);
  });

  it("re-reads the credential per request, so a long-lived client keeps working", async () => {
    // The Unlink client outlives one signature's window and mints tokens on
    // its own schedule; a credential captured at construction would 401 later.
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    const asked = vi.fn(requestAuth);
    const wrapped = walletAuthFetch(asked, origin, fetchImpl);

    await wrapped("/api/unlink/authorization-token", { method: "POST" });
    await wrapped("/api/unlink/authorization-token", { method: "POST" });

    expect(asked).toHaveBeenCalledTimes(2);
  });

  it("sends unsigned rather than hanging when the credential is gone", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const wrapped = walletAuthFetch(
      async () => ({ kind: "declined" }),
      origin,
      fetchImpl,
    );

    const res = await wrapped("/api/unlink/register", { method: "POST" });

    // 401 is the loud answer the SDK surfaces; a swallowed call would read as
    // a hung payout.
    expect(res.status).toBe(401);
    const init = fetchImpl.mock.calls[0][1] as { headers: Headers };
    expect(init.headers.get(WALLET_AUTH_ADDRESS_HEADER)).toBeNull();
  });
});

describe("fetchInputUrl", () => {
  it("reads the url out of every fetch argument shape", () => {
    expect(fetchInputUrl("/api/x")).toBe("/api/x");
    expect(fetchInputUrl(new URL("https://x.example/api"))).toBe(
      "https://x.example/api",
    );
    expect(fetchInputUrl(new Request("https://x.example/api"))).toBe(
      "https://x.example/api",
    );
  });
});
