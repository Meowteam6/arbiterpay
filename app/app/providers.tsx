"use client";

import { useState, type ReactNode } from "react";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, fallback, http } from "wagmi";
import { arcTestnet } from "@/lib/chains";
import { DEMO_CHROME, GUARD_INJECTED_WALLET } from "@/lib/config";
import { arcEvmNetwork } from "@/lib/dynamic";
import { externalConnectIntended } from "@/lib/wallet-connect-intent";

// Optional guard against a browser wallet silently hijacking the session.
// walletsFilter hides MetaMask from the modal LIST but does not stop Dynamic
// from auto-reconnecting an already-approved injected wallet on page load; that
// reconnect lands in userWallets and becomes the session. handleConnectedWallet
// fires on both an explicit connect and a load-time reconnect (returning false
// disconnects), so this vetoes a non-embedded connection unless the embedded
// wallet is connecting or the user deliberately tapped "Connect your own wallet"
// (see lib/wallet-connect-intent.ts). The embedded email wallet always passes.
//
// Spread in ONLY when GUARD_INJECTED_WALLET is set, so the default build's
// settings object is unchanged and sign-in cannot regress from this.
const injectedWalletGuard = GUARD_INJECTED_WALLET
  ? {
      handlers: {
        handleConnectedWallet: async (wallet: {
          connector?: { isEmbeddedWallet?: boolean };
        }): Promise<boolean> =>
          Boolean(wallet.connector?.isEmbeddedWallet) ||
          externalConnectIntended(),
      },
    }
  : {};

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
    // DEMO_CHROME hides the banner (an operator's checklist item, not product)
    // from recorded demo runs; every in-page fallback still renders.
    return (
      <>
        {DEMO_CHROME ? null : <DynamicMissingBanner />}
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
        // connect-only skips the SIWE ownership signature on login — the step
        // that surfaces as "Message signature denied" in the modal when a
        // MetaMask user does not sign. The app never needs that signature:
        // it gates on primaryWallet (see lib/wallet.ts, which treats a
        // connected wallet as authenticated precisely because connect-only
        // never sets isLoggedIn), and Unlink derives its own signature.
        //
        // This setting was NOT the reason sign-in was dead. Nor was the old
        // hand-rolled button: DynamicContextProvider renders DynamicAuthFlow
        // itself, and DynamicConnectButton's onClick is just
        // setSelectedWalletConnectorKey(null) + setShowAuthFlow(true) — so the
        // flag always had a listener. What was actually broken is in
        // lib/wallet.ts: connect-only never promotes a primaryWallet for an
        // external wallet, and the app read primaryWallet alone. Keep
        // connect-only; it keeps the flow signature-free.
        initialAuthenticationMode: "connect-only",
        walletConnectors: [EthereumWalletConnectors],
        // Drop MetaMask from the login modal. It is the one connector that
        // reliably fails sign-in here, and it is the only one we special-case
        // (see useMetamaskSdk below). Email and the other external wallets
        // stay. Matching on the key prefix rather than the exact "metamask"
        // string because the SDK also ships a "metamaskevm" key, and an exact
        // RemoveWallets(["metamask"]) would leave that one showing.
        walletsFilter: (wallets) =>
          wallets.filter((w) => !w.key.toLowerCase().startsWith("metamask")),
        // useMetamaskSdk: true routes MetaMask through its multichain "connect"
        // SDK, which does NOT bind the wallet into Dynamic state under
        // connect-only — primaryWallet/userWallets stay empty for MetaMask. That
        // is exactly what we want now: MetaMask is filtered out of the login
        // modal, and the intended path is email -> embedded (or Coinbase /
        // WalletConnect for bring-your-own). The prior value (false) forced the
        // classic injected/EIP-6963 connector, whose silent getConnectedAccounts
        // reconnect let an already-approved MetaMask auto-bind and hijack the
        // session on page load, before the email screen ever showed — bypassing
        // walletsFilter entirely (the filter governs the modal list, not the
        // injected auto-reconnect). true stops MetaMask from becoming the
        // session; email and the non-MetaMask external wallets are unaffected.
        useMetamaskSdk: true,
        overrides: { evmNetworks: [arcEvmNetwork] },
        // Don't show Dynamic's per-transaction confirmation modal for the
        // embedded (email) wallet — email-login users sign without an extra
        // popup each time. (External wallets like MetaMask still show their
        // own native prompt, which Dynamic can't suppress.)
        transactionConfirmation: { required: false },
        // Inert unless NEXT_PUBLIC_GUARD_INJECTED_WALLET is set (see above).
        ...injectedWalletGuard,
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
