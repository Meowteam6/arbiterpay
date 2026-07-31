"use client";

import { useState, type ReactNode } from "react";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, fallback, http } from "wagmi";
import { arcTestnet } from "@/lib/chains";
import { arcEvmNetwork } from "@/lib/dynamic";

// Arc-only. Sepolia was removed with the dropped ENS work — its unreachable
// default RPC was timing out in the wallet connector (UnknownRpcError).
const wagmiConfig = createConfig({
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: fallback([
      http("https://rpc.testnet.arc.network"),
      http("https://rpc.blockdaemon.testnet.arc.network"),
      http("https://rpc.drpc.testnet.arc.network"),
    ]),
  },
  connectors: [],
  ssr: true,
});

function DynamicMissingBanner() {
  return (
    <div className="bg-amber-950 border-b border-amber-700 px-4 py-2 text-sm text-amber-200">
      Dynamic is not configured. Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to
      enable sign-in and embedded wallets.
    </div>
  );
}

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 2, refetchOnWindowFocus: false },
        },
      }),
  );

  const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? "";
  if (environmentId === "") {
    // No Dynamic env id: skip the Dynamic providers but ALWAYS render the app.
    // Wallet-dependent components each fall back via DYNAMIC_CONFIGURED, and
    // none of them mounts a Dynamic hook when it is false, so wagmi + react-query
    // are all the context the rest of the site needs. Returning only the banner
    // here used to blank the whole site and make every fallback dead code.
    return (
      <>
        <DynamicMissingBanner />
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </WagmiProvider>
      </>
    );
  }

  return (
    <DynamicContextProvider
      settings={{
        environmentId,
        // connect-only skips the SIWE ownership signature on login (the wallet
        // sign step that threw UserRejectedRequestError 4001 in prod). The app
        // only gates on useIsLoggedIn()/primaryWallet and Unlink derives its
        // own signature separately, so no login signature is needed.
        initialAuthenticationMode: "connect-only",
        walletConnectors: [EthereumWalletConnectors],
        // Dynamic's default (useMetamaskSdk: true) routes MetaMask through its
        // new multichain "connect" SDK, which establishes a MetaMask connection
        // but does NOT bind the wallet into Dynamic state in connect-only mode —
        // primaryWallet/userWallets stay empty, so the app never sees the wallet
        // and sign-in never flips. Forcing the classic injected/EIP-6963
        // connector makes primaryWallet populate reliably.
        useMetamaskSdk: false,
        overrides: { evmNetworks: [arcEvmNetwork] },
        // Don't show Dynamic's per-transaction confirmation modal for the
        // embedded (email) wallet — email-login users sign without an extra
        // popup each time. (External wallets like MetaMask still show their
        // own native prompt, which Dynamic can't suppress.)
        transactionConfirmation: { required: false },
      }}
    >
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  );
}
