import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getCircleClient,
  provisionSpotterWallet,
  getSpotterWallet,
  getSpotterUsdcBalance,
  fundSpotterFromFaucet,
  SPOTTER_BLOCKCHAIN,
  type CircleClient,
} from "@/lib/server/agent/wallet";

// SPOTTER's identity is a Circle developer-controlled wallet on ARC-TESTNET.
// These tests pin three contracts: provisioning creates exactly one EOA wallet
// in a wallet set named SPOTTER, every env failure names the missing variable,
// and balance reads distinguish "unfunded" (a real zero) from "no USDC token"
// parsing mistakes. Money-path code never fails silently.

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeClient(overrides: Partial<Record<keyof CircleClient, unknown>>) {
  return {
    createWalletSet: vi.fn(),
    createWallets: vi.fn(),
    getWallet: vi.fn(),
    getWalletTokenBalance: vi.fn(),
    requestTestnetTokens: vi.fn(),
    ...overrides,
  } as unknown as CircleClient;
}

describe("getCircleClient", () => {
  it("fails loudly when CIRCLE_API_KEY is missing", () => {
    vi.stubEnv("CIRCLE_API_KEY", "");
    vi.stubEnv("CIRCLE_ENTITY_SECRET", "shh");
    expect(() => getCircleClient()).toThrow(/CIRCLE_API_KEY/);
  });

  it("fails loudly when CIRCLE_ENTITY_SECRET is missing", () => {
    vi.stubEnv("CIRCLE_API_KEY", "key");
    vi.stubEnv("CIRCLE_ENTITY_SECRET", "");
    expect(() => getCircleClient()).toThrow(/CIRCLE_ENTITY_SECRET/);
  });
});

describe("provisionSpotterWallet", () => {
  it("creates a SPOTTER wallet set and one ARC-TESTNET EOA wallet", async () => {
    const createWalletSet = vi.fn().mockResolvedValue({
      data: { walletSet: { id: "ws-1", name: "SPOTTER" } },
    });
    const createWallets = vi.fn().mockResolvedValue({
      data: {
        wallets: [
          {
            id: "w-1",
            address: "0xabc0000000000000000000000000000000000001",
            blockchain: SPOTTER_BLOCKCHAIN,
            accountType: "EOA",
          },
        ],
      },
    });
    const client = fakeClient({ createWalletSet, createWallets });

    const spotter = await provisionSpotterWallet(client);

    expect(createWalletSet).toHaveBeenCalledWith({ name: "SPOTTER" });
    expect(createWallets).toHaveBeenCalledWith({
      walletSetId: "ws-1",
      accountType: "EOA",
      blockchains: [SPOTTER_BLOCKCHAIN],
      count: 1,
      metadata: [{ name: "SPOTTER" }],
    });
    expect(spotter).toEqual({
      walletSetId: "ws-1",
      walletId: "w-1",
      address: "0xabc0000000000000000000000000000000000001",
      blockchain: SPOTTER_BLOCKCHAIN,
      accountType: "EOA",
    });
  });

  it("throws when Circle returns no wallet set id", async () => {
    const client = fakeClient({
      createWalletSet: vi.fn().mockResolvedValue({ data: {} }),
    });
    await expect(provisionSpotterWallet(client)).rejects.toThrow(
      /wallet set/i,
    );
  });

  it("throws when Circle returns no wallet", async () => {
    const client = fakeClient({
      createWalletSet: vi
        .fn()
        .mockResolvedValue({ data: { walletSet: { id: "ws-1" } } }),
      createWallets: vi.fn().mockResolvedValue({ data: { wallets: [] } }),
    });
    await expect(provisionSpotterWallet(client)).rejects.toThrow(/wallet/i);
  });
});

describe("getSpotterWallet", () => {
  it("fails loudly when CIRCLE_WALLET_ID is missing", async () => {
    vi.stubEnv("CIRCLE_WALLET_ID", "");
    const client = fakeClient({});
    await expect(getSpotterWallet(client)).rejects.toThrow(
      /CIRCLE_WALLET_ID/,
    );
  });

  it("returns id, address and blockchain for the configured wallet", async () => {
    vi.stubEnv("CIRCLE_WALLET_ID", "w-1");
    const getWallet = vi.fn().mockResolvedValue({
      data: {
        wallet: {
          id: "w-1",
          address: "0xabc0000000000000000000000000000000000001",
          blockchain: SPOTTER_BLOCKCHAIN,
        },
      },
    });
    const client = fakeClient({ getWallet });

    const wallet = await getSpotterWallet(client);

    expect(getWallet).toHaveBeenCalledWith({ id: "w-1" });
    expect(wallet).toEqual({
      id: "w-1",
      address: "0xabc0000000000000000000000000000000000001",
      blockchain: SPOTTER_BLOCKCHAIN,
    });
  });

  it("throws when Circle has no wallet for the configured id", async () => {
    vi.stubEnv("CIRCLE_WALLET_ID", "w-gone");
    const client = fakeClient({
      getWallet: vi.fn().mockResolvedValue({ data: {} }),
    });
    await expect(getSpotterWallet(client)).rejects.toThrow(/w-gone/);
  });
});

describe("getSpotterUsdcBalance", () => {
  it("returns the USDC amount and token id", async () => {
    vi.stubEnv("CIRCLE_WALLET_ID", "w-1");
    const client = fakeClient({
      getWalletTokenBalance: vi.fn().mockResolvedValue({
        data: {
          tokenBalances: [
            {
              token: { id: "tok-other", symbol: "WETH", decimals: 18 },
              amount: "5",
            },
            {
              // Arc's gas token is native USDC, so the entry can be isNative.
              token: {
                id: "tok-usdc",
                symbol: "USDC",
                decimals: 6,
                isNative: true,
              },
              amount: "12.5",
            },
          ],
        },
      }),
    });

    const balance = await getSpotterUsdcBalance(client);

    expect(balance).toEqual({ amount: "12.5", tokenId: "tok-usdc" });
  });

  it("requests testnet USDC for the wallet address on Arc", async () => {
    const requestTestnetTokens = vi.fn().mockResolvedValue({ status: 204 });
    const client = fakeClient({ requestTestnetTokens });

    await fundSpotterFromFaucet(
      client,
      "0xabc0000000000000000000000000000000000001",
    );

    expect(requestTestnetTokens).toHaveBeenCalledWith({
      address: "0xabc0000000000000000000000000000000000001",
      blockchain: SPOTTER_BLOCKCHAIN,
      usdc: true,
    });
  });

  it("returns a real zero for an unfunded wallet", async () => {
    vi.stubEnv("CIRCLE_WALLET_ID", "w-1");
    const client = fakeClient({
      getWalletTokenBalance: vi
        .fn()
        .mockResolvedValue({ data: { tokenBalances: [] } }),
    });

    const balance = await getSpotterUsdcBalance(client);

    expect(balance).toEqual({ amount: "0", tokenId: null });
  });
});
