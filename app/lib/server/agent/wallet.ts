// SPOTTER's on-chain identity: a Circle developer-controlled wallet on Arc
// testnet. The CLI-provisioned Agent Wallet cannot run headless (its session
// secrets live in the OS keychain), so this static API-key client is the
// always-on actor that records verdicts and settles pools. Provisioning is a
// one-time operation run from scripts/provision-spotter.ts; the runtime only
// ever reads the wallet back by CIRCLE_WALLET_ID.

import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import { requireEnv } from "@/lib/server/env";

export const SPOTTER_BLOCKCHAIN = "ARC-TESTNET";
export const SPOTTER_WALLET_SET_NAME = "SPOTTER";

export type CircleClient = Pick<
  CircleDeveloperControlledWalletsClient,
  | "createWalletSet"
  | "createWallets"
  | "getWallet"
  | "getWalletTokenBalance"
  | "requestTestnetTokens"
>;

export interface SpotterProvisionRecord {
  walletSetId: string;
  walletId: string;
  address: string;
  blockchain: string;
  accountType: string;
}

export interface SpotterWallet {
  id: string;
  address: string;
  blockchain: string;
}

export interface SpotterUsdcBalance {
  amount: string;
  tokenId: string | null;
}

export function getCircleClient(): CircleClient {
  return initiateDeveloperControlledWalletsClient({
    apiKey: requireEnv("CIRCLE_API_KEY"),
    entitySecret: requireEnv("CIRCLE_ENTITY_SECRET"),
  });
}

export async function provisionSpotterWallet(
  client: CircleClient,
): Promise<SpotterProvisionRecord> {
  const setResponse = await client.createWalletSet({
    name: SPOTTER_WALLET_SET_NAME,
  });
  const walletSetId = setResponse.data?.walletSet?.id;
  if (!walletSetId) {
    throw new Error(
      "Circle returned no wallet set id from createWalletSet; refusing to continue provisioning",
    );
  }

  const walletsResponse = await client.createWallets({
    walletSetId,
    accountType: "EOA",
    blockchains: [SPOTTER_BLOCKCHAIN],
    count: 1,
    metadata: [{ name: SPOTTER_WALLET_SET_NAME }],
  });
  const wallet = walletsResponse.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) {
    throw new Error(
      `Circle returned no wallet for wallet set ${walletSetId}; provisioning failed`,
    );
  }

  return {
    walletSetId,
    walletId: wallet.id,
    address: wallet.address,
    blockchain: wallet.blockchain ?? SPOTTER_BLOCKCHAIN,
    accountType: wallet.accountType ?? "EOA",
  };
}

export async function getSpotterWallet(
  client: CircleClient,
): Promise<SpotterWallet> {
  const walletId = requireEnv("CIRCLE_WALLET_ID");
  const response = await client.getWallet({ id: walletId });
  const wallet = response.data?.wallet;
  if (!wallet?.address) {
    throw new Error(
      `Circle has no wallet for CIRCLE_WALLET_ID=${walletId}; re-run provisioning or fix the env`,
    );
  }
  return {
    id: wallet.id,
    address: wallet.address,
    blockchain: wallet.blockchain ?? SPOTTER_BLOCKCHAIN,
  };
}

export async function fundSpotterFromFaucet(
  client: CircleClient,
  address: string,
): Promise<void> {
  await client.requestTestnetTokens({
    address,
    blockchain: SPOTTER_BLOCKCHAIN,
    usdc: true,
  });
}

export async function getSpotterUsdcBalance(
  client: CircleClient,
): Promise<SpotterUsdcBalance> {
  const walletId = requireEnv("CIRCLE_WALLET_ID");
  const response = await client.getWalletTokenBalance({ id: walletId });
  const balances = response.data?.tokenBalances ?? [];
  const usdc = balances.find((entry) => entry.token?.symbol === "USDC");
  if (!usdc) {
    // An unfunded wallet legitimately has no USDC entry yet.
    return { amount: "0", tokenId: null };
  }
  return { amount: usdc.amount ?? "0", tokenId: usdc.token?.id ?? null };
}
