import type { ReactNode } from "react";
import { arcTxUrl } from "@/lib/chains";
import type { ProofPolicy } from "@/lib/contract";

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
    accent: "bg-accent/12 text-accent-strong border-accent/30",
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

/**
 * The trust-tier badge(s) for a pool's proof policy. Renders the floor tier and,
 * when a verified-floor pool also opts into self-reported proof, a distinct
 * warning-tone "Self-reported OK" chip. A self-reported FLOOR shows a single
 * warning-tone "Self-reported" badge — it is never dressed up as verified. One
 * source of truth so the pool card and the pool detail always agree.
 */
export function ProofTierBadges({ policy }: { policy: ProofPolicy }) {
  const acceptsSelf = policy.accepted.includes("self-reported");
  if (policy.floor === "self-reported") {
    return <Badge tone="warning">Self-reported</Badge>;
  }
  return (
    <>
      <Badge tone={policy.floor === "document" ? "accent" : "muted"}>
        {policy.floor === "document" ? "Document" : "Wearable"}
      </Badge>
      {acceptsSelf ? <Badge tone="warning">Self-reported OK</Badge> : null}
    </>
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
  tone = "default",
}: {
  /** Whole-USD string with two decimals, exactly as the ledger recorded it. */
  usd: string;
  sign?: "+" | "-";
  size?: "sm" | "md" | "lg" | "xl";
  /** "gold" is reserved for money in motion - a payout landing or the agent's
   *  live spend. Static figures stay "default". No adjective ever lives here;
   *  the tone is the only thing that changes. */
  tone?: "default" | "gold";
}) {
  const sizes: Record<string, string> = {
    sm: "text-sm",
    md: "text-base",
    lg: "text-2xl",
    xl: "text-4xl",
  };
  const tones: Record<string, string> = {
    default: "text-foreground",
    gold: "text-gold-deep",
  };
  return (
    <span
      className={`font-mono font-semibold tabular-nums ${tones[tone]} ${sizes[size]}`}
    >
      {sign !== undefined ? sign : ""}
      {usd} USDC
    </span>
  );
}

export function Verdict({
  verified,
  confidence,
  selfReported = false,
}: {
  verified: boolean;
  confidence?: "low" | "medium" | "high";
  /** The low-trust tier. When true, the badge NEVER reads "Verified": a
   *  self-reported photo/screenshot cannot be confirmed real, recent, or the
   *  participant's, and must be visually and semantically distinct from the
   *  verified (wearable/document) tier. */
  selfReported?: boolean;
}) {
  if (selfReported) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-warning">
          Self-reported
        </span>
        <span className="text-xs uppercase tracking-wide text-muted">
          unverified · low-trust
        </span>
        {confidence !== undefined ? (
          <span className="text-xs uppercase tracking-wide text-muted">
            {confidence} confidence
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
          verified
            ? "border-accent/30 bg-accent/12 text-accent-strong"
            : "border-danger/40 bg-danger/10 text-danger"
        }`}
      >
        {verified ? "✓ Verified" : "Not verified"}
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
  /** "gold" marks money in motion (a landed payout); "accent" is the trust
   *  stamp; "danger" a rejection. */
  tone?: "accent" | "danger" | "gold";
}) {
  const tones: Record<string, string> = {
    accent: "border-accent text-accent",
    danger: "border-danger text-danger",
    gold: "border-gold text-gold-deep",
  };
  return (
    <span
      className={`animate-stamp-in inline-block rounded-md border-2 px-3 py-1 font-mono text-sm font-bold uppercase tracking-widest ${tones[tone]}`}
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
