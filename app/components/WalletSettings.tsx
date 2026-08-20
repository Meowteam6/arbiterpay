"use client";

// The signed-in user's wallet home. It answers the questions an email user has
// no other place to ask: what is my address, which network am I on, how much
// spendable USDC do I hold, is this the wallet the app made for me or one I
// connected, and - for the provisioned wallet - how do I back it up.
//
// Everything here is a read except the export action, which hands off to
// Dynamic's own secure reveal UI (a sandboxed iframe rendered by the existing
// DynamicContextProvider). The private key and recovery phrase never pass
// through this component or the app; the SDK shows them in isolation.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEmbeddedReveal } from "@dynamic-labs/sdk-react-core";
import { useState } from "react";
import { arcAddressUrl, arcTestnet } from "@/lib/chains";
import { formatUsdc } from "@/lib/contract";
import { fetchWalletUsdc } from "@/lib/faucet-funding";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useDisplayNames } from "@/lib/use-display-names";
import { Badge, Skeleton } from "@/components/ui";
import { CopyAddressButton } from "@/components/FundingHelp";
import SignInPanel from "@/components/SignInPanel";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge py-3 first:border-t-0">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className="text-sm text-foreground">{children}</span>
    </div>
  );
}

type ExportMode = "phrase" | "key";

function BackupSection() {
  const { initExportProcess } = useEmbeddedReveal();
  const [busy, setBusy] = useState<ExportMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runExport = async (mode: ExportMode) => {
    setBusy(mode);
    setError(null);
    try {
      // recoveryPhrase=true reveals the seed phrase (HD wallets only); false
      // reveals the raw private key. Dynamic renders the value in its own
      // sandboxed iframe and resolves when the reveal view closes.
      await initExportProcess(mode === "phrase");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The wallet export could not be started.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-6 rounded-2xl border border-edge bg-surface p-5">
      <h2 className="text-lg font-semibold">Back up this wallet</h2>
      <p className="mt-2 text-sm text-muted">
        This wallet was created for you, so only you can save its keys. Reveal
        them in Dynamic&apos;s secure view and store them somewhere safe -
        anyone with them controls the wallet, and no one can recover them for
        you.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            void runExport("phrase");
          }}
          className="min-h-11 rounded-xl bg-accent-strong px-5 py-3 text-sm font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "phrase" ? "Opening..." : "Reveal recovery phrase"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            void runExport("key");
          }}
          className="min-h-11 rounded-xl border border-edge px-5 py-3 text-sm font-semibold text-foreground hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "key" ? "Opening..." : "Export private key"}
        </button>
      </div>
      {error !== null ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-foreground/80"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

function WalletDetail({ address }: { address: `0x${string}` }) {
  const { isEmbedded, connectorName, logout } = useEmbeddedWallet();
  const { handleFor } = useDisplayNames([address]);
  const handle = handleFor(address);

  const balanceQuery = useQuery({
    queryKey: ["wallet-usdc", address],
    queryFn: () => fetchWalletUsdc(address),
    staleTime: 15_000,
    retry: false,
  });

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-edge bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Your wallet</h2>
          {isEmbedded === null ? (
            <Skeleton className="h-6 w-28" />
          ) : isEmbedded ? (
            <Badge tone="accent">Provisioned wallet</Badge>
          ) : (
            <Badge tone="muted">Connected wallet</Badge>
          )}
        </div>
        <p className="mt-2 text-sm text-muted">
          {isEmbedded === false
            ? `An external wallet you connected${
                connectorName !== null ? ` (${connectorName})` : ""
              }. Its keys live in that wallet, not here.`
            : "We created this wallet for you from your email. No seed phrase or extension needed to use it - back it up below when you want the keys."}
        </p>

        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Address
          </p>
          <CopyAddressButton address={address} />
        </div>

        <div className="mt-2">
          <Row label="Handle">
            {handle !== null ? (
              <Link
                href={`/u/${handle}`}
                className="font-semibold text-foreground hover:text-accent"
              >
                @{handle}
              </Link>
            ) : (
              <Link
                href="/handle"
                className="font-medium text-accent underline underline-offset-2"
              >
                Claim a name
              </Link>
            )}
          </Row>
          <Row label="Network">
            {arcTestnet.name}
            <span className="ml-1 text-muted">(chain {arcTestnet.id})</span>
          </Row>
          <Row label="Balance">
            {balanceQuery.isLoading ? (
              <span className="text-muted">Reading...</span>
            ) : balanceQuery.isError ? (
              <button
                type="button"
                onClick={() => {
                  void balanceQuery.refetch();
                }}
                className="text-accent underline underline-offset-2"
              >
                Could not read - retry
              </button>
            ) : (
              <span className="font-mono tabular-nums">
                {formatUsdc(balanceQuery.data ?? 0n)} USDC
              </span>
            )}
          </Row>
          <Row label="Explorer">
            <a
              href={arcAddressUrl(address)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2"
            >
              View on Arcscan
            </a>
          </Row>
        </div>
      </section>

      {isEmbedded === true ? <BackupSection /> : null}

      <button
        type="button"
        onClick={() => {
          void logout();
        }}
        className="min-h-11 w-full rounded-xl border border-edge px-5 py-3 text-sm font-medium text-muted hover:text-foreground"
      >
        Sign out
      </button>
    </div>
  );
}

/**
 * Wallet settings. Mounted only under a configured DynamicContextProvider (the
 * settings page gates on DYNAMIC_CONFIGURED), so the Dynamic hooks here are
 * always safe.
 */
export default function WalletSettings() {
  const { ready, authenticated, address } = useEmbeddedWallet();

  if (!ready) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (!authenticated || address === null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Sign in to see your wallet address, balance, and backup options.
        </p>
        <SignInPanel />
      </div>
    );
  }

  return <WalletDetail address={address} />;
}
