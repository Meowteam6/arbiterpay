"use client";

// The first-run wall. Arc testnet pays gas in USDC, so a brand new wallet
// holds nothing and cannot send ANY transaction - not a join, not a top-up,
// not a stake. Every USDC-pulling surface needs the same explanation and the
// same escape hatch, so it lives here rather than inside JoinPool.
//
// The instructions matter: at faucet.circle.com you PASTE an address and pick
// a network from a long dropdown, you do not "send" anything, and Arc Testnet
// is easy to miss. A 42-character address is also impossible to select by
// hand on a phone, so copying is a button, never a long-press drag.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatUsdc, shortAddress } from "@/lib/contract";
import { FAUCET_URL, FUNDING_STEPS } from "@/lib/tx-errors";

type CopyState = { kind: "idle" } | { kind: "copied" } | { kind: "failed" };

/**
 * Tap-to-copy wallet address. `compact` truncates for the header row; the
 * full address is always what lands on the clipboard.
 */
export function CopyAddressButton({
  address,
  compact = false,
}: {
  address: string;
  compact?: boolean;
}) {
  const [copy, setCopy] = useState<CopyState>({ kind: "idle" });

  useEffect(() => {
    if (copy.kind === "idle") return;
    const timer = setTimeout(() => setCopy({ kind: "idle" }), 2500);
    return () => clearTimeout(timer);
  }, [copy]);

  const run = useCallback(() => {
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setCopy({ kind: "failed" });
      return;
    }
    clipboard.writeText(address).then(
      () => setCopy({ kind: "copied" }),
      () => setCopy({ kind: "failed" }),
    );
  }, [address]);

  // Compact lives in the fixed-height header row, so it carries its feedback
  // in the label - a status line underneath would shift the whole bar.
  if (compact) {
    return (
      <button
        type="button"
        onClick={run}
        title={`Tap to copy ${address}`}
        aria-label={`Copy wallet address ${address}`}
        className="inline-flex min-h-11 items-center rounded-lg border border-edge bg-surface-raised px-3 py-2 font-mono text-xs text-muted hover:text-foreground"
      >
        <span aria-live="polite">
          {copy.kind === "copied"
            ? "Copied"
            : copy.kind === "failed"
              ? "Copy failed"
              : shortAddress(address)}
        </span>
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={run}
        title={`Tap to copy ${address}`}
        aria-label={`Copy wallet address ${address}`}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-edge bg-surface-raised px-3 py-3 text-left font-mono text-xs text-foreground/80 hover:border-accent/50 hover:text-foreground"
      >
        <span className="break-all">{address}</span>
        <span className="shrink-0 font-sans text-xs font-semibold uppercase tracking-wide text-accent">
          {copy.kind === "copied" ? "Copied" : "Tap to copy"}
        </span>
      </button>
      <p aria-live="polite" className="text-xs text-muted">
        {copy.kind === "failed"
          ? "Copying is blocked in this browser - select the address by hand."
          : copy.kind === "copied"
            ? "Address copied."
            : ""}
      </p>
    </div>
  );
}

export default function FundingHelp({
  address,
  balance,
  needed = 0n,
  headline = "Your wallet needs test USDC first",
  note,
  onRecheck,
  recheckLabel = "I added USDC, check again",
}: {
  /** The signed-in wallet, or null while it is still resolving. */
  address: string | null;
  /** Current USDC balance in 6-decimal base units, or null if unread. */
  balance: bigint | null;
  /** USDC the pending action pulls on top of gas, in base units. */
  needed?: bigint;
  headline?: string;
  /** Extra context for the specific action, for example an entry fee. */
  note?: string;
  onRecheck?: () => void;
  recheckLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
      <p className="text-base font-semibold text-warning">{headline}</p>
      <p className="mt-1 text-sm text-foreground/80">
        Arc testnet pays gas in USDC, so a wallet with a zero balance cannot
        send any transaction - even a free pool needs a little to cover the
        gas. The USDC is test USDC and has no real value.
        {note !== undefined && note !== "" ? ` ${note}` : ""}
        {balance !== null
          ? ` Current balance: ${formatUsdc(balance)} USDC.`
          : ""}
        {needed > 0n ? ` This action pulls ${formatUsdc(needed)} USDC.` : ""}
      </p>

      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
        Your wallet address
      </p>
      {address === null ? (
        <p className="mt-1 text-sm text-muted">
          Sign in to see the address to fund.
        </p>
      ) : (
        <div className="mt-1">
          <CopyAddressButton address={address} />
        </div>
      )}

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">
        Getting test USDC
      </p>
      <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-foreground/80">
        {FUNDING_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <a
        href={FAUCET_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 flex min-h-11 w-full items-center justify-center rounded-xl border border-accent/50 bg-surface-raised px-5 py-3 text-base font-semibold text-accent hover:bg-accent-deep"
      >
        Open the Circle faucet
      </a>

      <p className="mt-3 text-sm text-foreground/80">
        Or top up in-app from the balance card on{" "}
        <Link href="/dashboard" className="text-accent underline">
          your dashboard
        </Link>
        .
      </p>

      {onRecheck !== undefined ? (
        <button
          type="button"
          onClick={onRecheck}
          className="mt-4 min-h-11 w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:opacity-60"
        >
          {recheckLabel}
        </button>
      ) : null}
    </div>
  );
}
