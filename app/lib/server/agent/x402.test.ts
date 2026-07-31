import { describe, it, expect, vi, beforeEach } from "vitest";

// The buy side must be honest about how a purchase settled: with no spend key
// or service URL configured, everything quotes and settles "prepaid" with the
// static estimate and no payment reference is ever invented.

vi.mock("@circle-fin/x402-batching/client", () => ({
  GatewayClient: vi.fn(),
}));

async function load() {
  vi.resetModules();
  return import("@/lib/server/agent/x402");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("usdCents", () => {
  it("parses two-decimal USD strings and rejects everything else", async () => {
    const { usdCents } = await load();
    expect(usdCents("0.02")).toBe(2);
    expect(usdCents("1.00")).toBe(100);
    expect(usdCents("12.35")).toBe(1235);
    expect(() => usdCents("0.5")).toThrow();
    expect(() => usdCents("1")).toThrow();
    expect(() => usdCents("-1.00")).toThrow();
  });
});

describe("liveBuyDeps without x402 env", () => {
  it("quotes all three services prepaid at their static estimates", async () => {
    const { liveBuyDeps } = await load();
    const deps = liveBuyDeps();

    expect(await deps.quoteAttesterRead()).toEqual({
      service: "attester-read",
      label: "document read (TEE attester)",
      estUsd: "0.02",
      url: null,
    });
    expect(await deps.quoteVisionJudge()).toEqual({
      service: "vision-judge",
      label: "vision judge (Gemini)",
      estUsd: "0.35",
      url: null,
    });
    expect(await deps.quoteChainRead()).toEqual({
      service: "chain-read",
      label: "chain verification read (QuickNode, x402)",
      estUsd: "0.01",
      url: null,
    });
  });

  it("settles a prepaid quote without inventing a gateway reference", async () => {
    const { liveBuyDeps } = await load();
    const deps = liveBuyDeps();

    const purchase = await deps.buy(await deps.quoteVisionJudge(), {
      attesterId: "job-1",
    });

    expect(purchase).toEqual({
      amountUsd: "0.35",
      settlement: "prepaid",
      gatewayTx: null,
      data: null,
    });
  });
});

describe("quoteChainRead with a spend key", () => {
  it("defaults to QuickNode's Arc-testnet x402 endpoint and prices from the 402 offer", async () => {
    vi.stubEnv("X402_PRIVATE_KEY", "ab".repeat(32));
    const { liveBuyDeps } = await load();
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    const supports = vi.fn().mockResolvedValue({
      supported: true,
      // QuickNode's live offer: $0.0001/request in USDC atomic units,
      // rounded up to the whole cent the ledger requires.
      requirements: { amount: "100" },
    });
    vi.mocked(GatewayClient).mockImplementation(function (this: unknown) {
      return { supports } as unknown as InstanceType<typeof GatewayClient>;
    });

    const quote = await liveBuyDeps().quoteChainRead();

    expect(supports).toHaveBeenCalledWith(
      "https://x402.quicknode.com/arc-testnet/",
    );
    expect(quote).toEqual({
      service: "chain-read",
      label: "chain verification read (QuickNode, x402)",
      estUsd: "0.01",
      url: "https://x402.quicknode.com/arc-testnet/",
    });
  });

  it("lets X402_CHAIN_READ_URL override the default endpoint", async () => {
    vi.stubEnv("X402_PRIVATE_KEY", "ab".repeat(32));
    vi.stubEnv("X402_CHAIN_READ_URL", "https://example.com/paid-rpc");
    const { liveBuyDeps } = await load();
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    const supports = vi.fn().mockResolvedValue({
      supported: true,
      requirements: { amount: "100" },
    });
    vi.mocked(GatewayClient).mockImplementation(function (this: unknown) {
      return { supports } as unknown as InstanceType<typeof GatewayClient>;
    });

    const quote = await liveBuyDeps().quoteChainRead();

    expect(supports).toHaveBeenCalledWith("https://example.com/paid-rpc");
    expect(quote.url).toBe("https://example.com/paid-rpc");
  });

  it("degrades to prepaid when the endpoint preflight fails", async () => {
    vi.stubEnv("X402_PRIVATE_KEY", "ab".repeat(32));
    const { liveBuyDeps } = await load();
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    vi.mocked(GatewayClient).mockImplementation(function (this: unknown) {
      return {
        supports: vi.fn().mockRejectedValue(new Error("endpoint down")),
      } as unknown as InstanceType<typeof GatewayClient>;
    });

    const quote = await liveBuyDeps().quoteChainRead();

    expect(quote).toEqual({
      service: "chain-read",
      label: "chain verification read (QuickNode, x402)",
      estUsd: "0.01",
      url: null,
    });
  });
});
