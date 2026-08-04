import type { ReactNode } from "react";
import { arcTxUrl } from "@/lib/chains";

/**
 * The minimum a thumb can reliably hit: 44px tall with room either side. Small
 * controls (a retry, a tab, a chip) kept drifting to ~33-37px because the
 * padding alone decided the height, so the height is stated here and shared
 * rather than re-derived per component. Sizing only - it carries no colour,
 * border, or radius, so the visual language of each control is untouched.
 */
export const TAP_TARGET =
  "inline-flex min-h-11 items-center justify-center px-4 py-2 text-sm font-medium";

export function ArcTxLink({
  txHash,
  label = "View transaction on Arcscan",
}: {
  txHash: string;
  label?: string;
}) {
  return (
    <a
      href={arcTxUrl(txHash)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block break-all text-sm text-accent underline"
    >
      {label}
    </a>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-surface-raised ${className}`}
    />
  );
}

export function PoolCardSkeleton() {
  return (
    <div className="rounded-2xl border border-edge bg-surface p-5">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="mt-4 h-7 w-3/4" />
      <Skeleton className="mt-3 h-4 w-1/2" />
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    </div>
  );
}

export function ErrorNote({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-danger/40 bg-danger/10 p-4"
    >
      <p className="text-base font-semibold text-danger">{title}</p>
      {detail !== undefined && detail !== "" ? (
        <p className="mt-1 break-words text-sm text-foreground/80">{detail}</p>
      ) : null}
      {onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-3 rounded-lg border border-danger/50 text-danger hover:bg-danger/20 ${TAP_TARGET}`}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-edge bg-surface/50 px-6 py-12 text-center">
      <p className="text-lg font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{detail}</p>
      {action !== undefined ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "muted" | "warning";
}) {
  const tones: Record<string, string> = {
    accent: "bg-accent-deep text-accent border-accent/30",
    muted: "bg-surface-raised text-muted border-edge",
    warning: "bg-warning/10 text-warning border-warning/30",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// Honest-core primitives. Amounts, verdicts, and stamps render through these
// three components with no slot for an adjective: the brand voice is loud
// around the numbers, never inside them. Anything on screen that claims money
// moved or a goal was verified must come through here.

export function Money({
  usd,
  sign,
  size = "md",
}: {
  /** Whole-USD string with two decimals, exactly as the ledger recorded it. */
  usd: string;
  sign?: "+" | "-";
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const sizes: Record<string, string> = {
    sm: "text-sm",
    md: "text-base",
    lg: "text-2xl",
    xl: "text-4xl",
  };
  return (
    <span
      className={`font-mono font-semibold tabular-nums text-foreground ${sizes[size]}`}
    >
      {sign !== undefined ? sign : ""}
      {usd} USDC
    </span>
  );
}

export function Verdict({
  verified,
  confidence,
}: {
  verified: boolean;
  confidence?: "low" | "medium" | "high";
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
          verified
            ? "border-accent/30 bg-accent-deep text-accent"
            : "border-danger/40 bg-danger/10 text-danger"
        }`}
      >
        {verified ? "Verified" : "Not verified"}
      </span>
      {confidence !== undefined ? (
        <span className="text-xs uppercase tracking-wide text-muted">
          {confidence} confidence
        </span>
      ) : null}
    </span>
  );
}

export function Stamp({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "danger";
}) {
  return (
    <span
      className={`animate-stamp-in inline-block rounded-md border-2 px-3 py-1 font-mono text-sm font-bold uppercase tracking-widest ${
        tone === "accent"
          ? "border-accent text-accent"
          : "border-danger text-danger"
      }`}
      style={{ transform: "rotate(-3deg)" }}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-edge bg-surface-raised p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold leading-snug">{value}</p>
    </div>
  );
}
