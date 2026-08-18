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
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUsdc, shortAddress } from "@/lib/contract";
import { FAUCET_GRANT_UUSDC } from "@/lib/money-guards";
import { FAUCET_URL, FUNDING_STEPS } from "@/lib/tx-errors";
import { type FundingResult, useTestUsdcFunding } from "@/lib/faucet-funding";

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

// Auto-attempt bookkeeping, module-scoped so it survives the remount the join
// flow does on every needs-funds -> checking -> needs-funds cycle. A first
// block auto-funds once per address per session; every later block needs a
// deliberate tap, so an entry-fee pool a single grant cannot cover does not
// loop fund -> recheck -> fund.
const autoAttempted = new Set<string>();

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
  const { phase, funding, fund } = useTestUsdcFunding();
  const [outcome, setOutcome] = useState<FundingResult | null>(null);

  // onRecheck's closure identity changes on every parent render, so hold it in
  // a ref and keep the one-shot auto-attempt effect depending only on address.
  const onRecheckRef = useRef(onRecheck);
  useEffect(() => {
    onRecheckRef.current = onRecheck;
  }, [onRecheck]);

  // Manual path (the primary button). Event-handler context, so clearing the
  // prior outcome before funding is fine here.
  const runFunding = useCallback(async () => {
    if (address === null) return;
    setOutcome(null);
    const result = await fund(address);
    setOutcome(result);
    // Only continue the original action when real USDC actually landed on Arc.
    if (result.kind === "funded") onRecheckRef.current?.();
  }, [address, fund]);

  // Auto-attempt ONCE per address per session on the first block. Safe by
  // construction: the faucet dedupes per address/day and the delivery is
  // bounded by the withdraw cap and treasury floor, so a single automatic
  // attempt cannot overspend. The work is deferred past an await so the effect
  // never sets state synchronously.
  useEffect(() => {
    if (address === null) return;
    const key = address.toLowerCase();
    if (autoAttempted.has(key)) return;
    autoAttempted.add(key);
    let cancelled = false;
    void (async () => {
      // auto: draws the lower faucet reserve so incidental first blocks cannot
      // exhaust the budget a deliberate tap (the manual button below, and the
      // demo) needs.
      const result = await fund(address, { auto: true });
      if (cancelled) return;
      setOutcome(result);
      if (result.kind === "funded") onRecheckRef.current?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [address, fund]);

  const primaryLabel = funding
    ? phase === "moving"
      ? "Delivering to your wallet..."
      : "Getting test USDC..."
    : "Get test USDC";

  // The external Circle faucet is the fallback now: shown only when the in-app
  // grant could not fund the wallet (budget spent, nothing to move, an error),
  // or when there is no signed-in address to grant to.
  const showFallback =
    address === null || (outcome !== null && outcome.kind !== "funded");

  const fallbackReason =
    outcome === null
      ? null
      : outcome.kind === "budget-exhausted" || outcome.kind === "error"
        ? outcome.message
        : outcome.kind === "empty"
          ? "The in-app faucet had nothing to grant right now."
          : null;

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

      {address !== null ? (
        <>
          <button
            type="button"
            disabled={funding}
            onClick={() => {
              void runFunding();
            }}
            className="mt-4 min-h-11 w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {primaryLabel}
          </button>
          <p className="mt-2 text-xs text-muted">
            One tap grants you {formatUsdc(FAUCET_GRANT_UUSDC)} test USDC and
            delivers it to your Arc wallet. Testnet only, no real value.
          </p>
          {outcome !== null && outcome.kind === "funded" ? (
            <p
              className="mt-2 text-sm font-semibold text-accent"
              aria-live="polite"
            >
              Test USDC delivered to your wallet. Continuing...
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">
          Sign in to grant yourself test USDC.
        </p>
      )}

      {showFallback ? (
        <div className="mt-4 border-t border-warning/30 pt-4">
          <p className="text-sm text-foreground/80" role="status">
            {fallbackReason !== null
              ? `In-app funding did not go through: ${fallbackReason} You can still get test USDC directly.`
              : "Prefer to fund the wallet yourself? Get test USDC directly from the Circle faucet."}
          </p>

          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">
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
              className="mt-4 min-h-11 w-full rounded-xl border border-edge bg-surface-raised px-5 py-3 text-base font-semibold text-foreground hover:border-accent/50 disabled:opacity-60"
            >
              {recheckLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
