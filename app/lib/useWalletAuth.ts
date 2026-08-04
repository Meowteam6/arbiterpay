"use client";

// The one place a React component gets a wallet-auth requester.
//
// Kept apart from lib/client-auth.ts on purpose: that module is framework-free
// so every decision in it (caching, expiry, rejection classification,
// same-origin attachment) is unit-testable under vitest's node environment.
// This file is the thin binding to Dynamic's wallet, and holds no decisions of
// its own.
//
// The returned requester never throws and never prompts more than once per
// freshness window, so a polling component can call it on every iteration.

import { useCallback } from "react";
import { getWalletAuth, type ClientAuth, type WalletAuthRequester } from "@/lib/client-auth";
import { useEmbeddedWallet } from "@/lib/wallet";

export type { ClientAuth, WalletAuthRequester };

export function useWalletAuth(): WalletAuthRequester {
  const { address, getArcWalletClient } = useEmbeddedWallet();

  return useCallback(
    async (options?: {
      refresh?: boolean;
      cachedOnly?: boolean;
    }): Promise<ClientAuth> =>
      getWalletAuth({
        address,
        refresh: options?.refresh,
        cachedOnly: options?.cachedOnly,
        signMessage:
          address === null
            ? null
            : async (message: string) => {
                const client = await getArcWalletClient();
                return client.signMessage({
                  account: client.account,
                  message,
                });
              },
      }),
    [address, getArcWalletClient],
  );
}
