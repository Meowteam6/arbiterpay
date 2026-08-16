"use client";

import { useCallback } from "react";
import {
  useDynamicContext,
  useIsLoggedIn,
  useUserWallets,
} from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";
import {
  type Account,
  type Address,
  type Chain,
  type Transport,
  type WalletClient,
} from "viem";
import { arcTestnet } from "@/lib/chains";
import { DYNAMIC_CONFIGURED } from "@/lib/config";

export type ArcWalletClient = WalletClient<Transport, Chain, Account>;

export interface EmbeddedWalletState {
  ready: boolean;
  authenticated: boolean;
  address: Address | null;
  login: () => void;
  logout: () => Promise<void>;
  getArcWalletClient: () => Promise<ArcWalletClient>;
}

/**
 * Inert wallet state for builds with no Dynamic environment id. Providers
 * renders the app WITHOUT DynamicContextProvider in that case, so Dynamic
 * hooks would throw; components that call useEmbeddedWallet unguarded
 * (PoolDetail) still need a safe answer: signed out, no address.
 */
function useStubWallet(): EmbeddedWalletState {
  return {
    ready: true,
    authenticated: false,
    address: null,
    login: () => {
      console.warn(
        "Dynamic is not configured (NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID unset); sign-in is unavailable.",
      );
    },
    logout: async () => {},
    getArcWalletClient: async () => {
      throw new Error(
        "Dynamic is not configured. Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable wallets.",
      );
    },
  };
}

/**
 * Dynamic-backed wallet access. Prefers the primary wallet, switches it to
 * Arc testnet, and returns a viem wallet client.
 *
 * Public interface is identical to the previous wallet hook so all
 * consumers (JoinPool, FundPool, BackGoal, CreatePool, Header, useUsdcDeposit)
 * are untouched. The `wallet` field from the old interface was confirmed
 * unused by consumers (grep -rn ".wallet" app/components app/lib returned 0 hits).
 */
function useDynamicWallet(): EmbeddedWalletState {
  const { sdkHasLoaded, primaryWallet, setShowAuthFlow, handleLogOut } =
    useDynamicContext();
  const isLoggedIn = useIsLoggedIn();
  const userWallets = useUserWallets();

  // Email sign-in populates primaryWallet (the turnkey embedded wallet), but an
  // EXTERNAL wallet connected under initialAuthenticationMode "connect-only"
  // lands in userWallets while primaryWallet stays null — there is no
  // authenticated session to promote one. Reading primaryWallet alone meant a
  // MetaMask user connected successfully and the header never left "Sign in".
  // Fall back to the first connected wallet so both paths resolve identically.
  const activeWallet = primaryWallet ?? userWallets[0] ?? null;

  const address =
    activeWallet != null && /^0x[0-9a-fA-F]{40}$/.test(activeWallet.address)
      ? (activeWallet.address as Address)
      : null;

  const getArcWalletClient = useCallback(async (): Promise<ArcWalletClient> => {
    if (activeWallet == null || !isEthereumWallet(activeWallet)) {
      throw new Error("No EVM wallet connected. Sign in first.");
    }
    await activeWallet.switchNetwork(arcTestnet.id);
    const walletClient = await activeWallet.getWalletClient();
    return walletClient as ArcWalletClient;
  }, [activeWallet]);

  return {
    ready: sdkHasLoaded,
    // connect-only mode never sets isLoggedIn (no SIWE), but the app only needs
    // a connected wallet address — so treat a connected wallet as authenticated.
    authenticated: isLoggedIn || address !== null,
    address,
    login: () => setShowAuthFlow(true),
    logout: handleLogOut,
    getArcWalletClient,
  };
}

// Selected once at module load: DYNAMIC_CONFIGURED is a build-time constant,
// so the hook identity never changes at runtime and the rules of hooks hold.
export const useEmbeddedWallet: () => EmbeddedWalletState = DYNAMIC_CONFIGURED
  ? useDynamicWallet
  : useStubWallet;
