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
  it("quotes both services prepaid at their static estimates", async () => {
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
