// Public "paid wall" for a claimed handle. Renders a wallet's wins and USDC
// payouts WITHOUT ever revealing the health category behind any goal.
//
// THE REDACTION RULE IS STRUCTURAL HERE: ProfileData has no field that can
// carry an initiative, a goalSpec, or any health label - only a handle, an
// avatar glyph, an address, counts, USDC amounts, backer handles, and
// settlement tx hashes. A win row shows a role and its trust tier ("Verified
// win" / "Self-reported win" / "Backed a winner"), never what the goal was.
//
// THE HONESTY RULE: a self-reported win (a photo/screenshot we cannot confirm
// is real, recent, or theirs) is a real win paid at 1x, but it must NEVER carry
// a check/shield or read "Verified". The trust tier comes from the on-chain
// HealthVerdict facet bitmap, resolved upstream in lib/server/social-stats.

import { arcTxUrl } from "@/lib/chains";
import { profileWinPresentation, type ProofTier } from "@/lib/proof-tier";

export interface Win {
  id: string;
  at: string; // ISO timestamp
  amountUsd: string; // "40.00" - two decimals, exactly as the ledger recorded it
  txHash: string; // settlement tx hash -> Arcscan link
  role: "achiever" | "backer";
  /** Trust tier of an achiever win; null for a backer win. A "self-reported"
   *  win never renders as verified. */
  tier: ProofTier | null;
}

export interface Peer {
  handle: string;
  emoji: string; // avatar glyph, rendered as data
}

export interface ProfileData {
  handle: string;
  emoji: string; // avatar glyph (render as-is, it is user data)
  address: string;
  verifiedWins: number; // verified-tier only; excludes self-reported
  selfReportedWins: number; // real wins, counted separately, never "verified"
  usdcEarned: string; // "1240.00"
  winStreak: number;
  backers: Peer[];
  backing: Peer[];
  wins: Win[]; // most recent first
}

const PRIVACY_COPY = "Verified privately. The health category is never shown.";

/* ---------- inline SVG icons (no icon library, no emoji) ---------- */

function ShieldLockIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <rect x="9.25" y="11" width="5.5" height="4.5" rx="1" />
      <path d="M10.5 11V9.75a1.5 1.5 0 013 0V11" />
    </svg>
  );
}

function CheckBadgeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2.5l2.2 1.6 2.7-.2 1 2.5 2.3 1.4-.7 2.6.7 2.6-2.3 1.4-1 2.5-2.7-.2L12 21.5l-2.2-1.6-2.7.2-1-2.5-2.3-1.4.7-2.6-.7-2.6 2.3-1.4 1-2.5 2.7.2L12 2.5z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function FlameIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3c.5 3-1.5 4.5-3 6.5C7.4 11.7 7 13.3 7 15a5 5 0 0010 0c0-2-1-3.8-2.5-5 .3 1.4-.4 2.4-1.3 2.8.6-2.6-.6-5-1.2-6.3-.3-.7-.7-1.6 0-3.5z" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M14 5h5v5" />
      <path d="M19 5l-7 7" />
      <path d="M19 13v4a2 2 0 01-2 2H7a2 2 0 01-2-2V7a2 2 0 012-2h4" />
    </svg>
  );
}

/* ---------- money primitive ---------- */
// Warm gold, monospace, tabular-nums, " USDC" suffix, NO adjective. The value
// string is rendered exactly as the ledger recorded it.

function Money({
  amount,
  className = "",
}: {
  amount: string;
  className?: string;
}) {
  return (
    <span className={`font-mono tabular-nums text-gold ${className}`}>
      {amount}
      <span className="text-gold/80"> USDC</span>
    </span>
  );
}

/* ---------- privacy line ---------- */

function PrivacyLine({ className = "" }: { className?: string }) {
  return (
    <p className={`flex items-center gap-1.5 text-xs text-accent ${className}`}>
      <ShieldLockIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="text-pretty">{PRIVACY_COPY}</span>
    </p>
  );
}

/* ---------- helpers ---------- */

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const sec = Math.max(0, Math.floor(diff / 1000));
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const wk = Math.floor(day / 7);
  if (sec < 60) return "just now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 7) return `${day}d ago`;
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

/* ---------- peer chip ---------- */

function PeerChip({ peer }: { peer: Peer }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-raised py-1 pl-1 pr-2.5 text-sm">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 items-center justify-center rounded-full bg-background text-sm leading-none"
      >
        {peer.emoji}
      </span>
      <span className="text-foreground">@{peer.handle}</span>
    </span>
  );
}

function PeerColumn({
  title,
  peers,
  emptyLabel,
}: {
  title: string;
  peers: Peer[];
  emptyLabel: string;
}) {
  return (
    <div className="flex-1 rounded-2xl border border-edge bg-surface p-5">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
        {title}
      </h3>
      {peers.length === 0 ? (
        <p className="text-sm text-muted">{emptyLabel}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {peers.map((peer) => (
            <PeerChip key={peer.handle} peer={peer} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- win row ---------- */

// Icon container tones per trust tier. Self-reported and unknown wins carry NO
// check badge — a self-reported photo cannot be presented as verified.
const WIN_ICON_TONE: Record<"accent" | "warning" | "muted", string> = {
  accent: "bg-accent-deep text-accent",
  warning: "bg-warning/10 text-warning",
  muted: "bg-surface-raised text-muted",
};

function WinRow({ win, index }: { win: Win; index: number }) {
  const { label, tone, showCheck, sublabel } = profileWinPresentation(
    win.role,
    win.tier,
  );
  return (
    <li
      className="ghm-rise-in flex items-center gap-3 rounded-2xl border border-edge bg-surface p-4"
      style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${WIN_ICON_TONE[tone]}`}
      >
        {showCheck ? (
          <CheckBadgeIcon className="h-5 w-5" />
        ) : tone === "warning" ? (
          <AlertIcon className="h-5 w-5" />
        ) : (
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
        )}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {sublabel !== null ? (
            <span className="text-xs uppercase tracking-wide text-warning">
              {sublabel}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span>{relativeTime(win.at)}</span>
          <span aria-hidden="true">&middot;</span>
          <a
            href={arcTxUrl(win.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:text-accent-strong"
          >
            Arcscan
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        </span>
      </div>

      <Money amount={win.amountUsd} className="shrink-0 text-right text-base" />
    </li>
  );
}

/* ---------- main component ---------- */

export function ProfilePaidWall({ profile }: { profile: ProfileData }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 text-foreground">
      {/* 1. Identity header */}
        <header className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-edge bg-surface-raised text-3xl leading-none"
          >
            {profile.emoji}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="truncate text-2xl font-bold tracking-tight text-foreground">
              @{profile.handle}
            </h1>
            <p
              className="truncate font-mono text-sm text-muted"
              title={profile.address}
            >
              {truncateAddress(profile.address)}
            </p>
            <span className="mt-0.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-deep px-2.5 py-0.5 text-xs font-medium text-accent">
              <CheckBadgeIcon className="h-3.5 w-3.5" />
              verified on GoHealthMe
            </span>
          </div>
        </header>

        {/* 2. Hero stat rail */}
        <section className="rounded-2xl border border-edge bg-surface p-5">
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-3 flex flex-col gap-1 sm:col-span-1 sm:border-r sm:border-edge sm:pr-4">
              <span className="text-xs uppercase tracking-wider text-muted">
                USDC earned
              </span>
              <Money
                amount={profile.usdcEarned}
                className="text-2xl font-semibold sm:text-3xl"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-muted">
                Verified wins
              </span>
              <span className="flex items-center gap-1.5 text-2xl font-semibold text-accent">
                <CheckBadgeIcon className="h-5 w-5" />
                {profile.verifiedWins}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-muted">
                Win streak
              </span>
              <span className="flex items-center gap-1.5 text-2xl font-semibold text-accent">
                <FlameIcon className="h-5 w-5" />
                {profile.winStreak}
              </span>
            </div>
          </div>
          {/* Self-reported wins are counted separately and never folded into
              the "Verified wins" figure above. */}
          {profile.selfReportedWins > 0 ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-warning">
              <AlertIcon className="h-3.5 w-3.5 shrink-0" />
              <span>
                + {profile.selfReportedWins} self-reported{" "}
                {profile.selfReportedWins === 1 ? "win" : "wins"} &mdash; not
                verified
              </span>
            </p>
          ) : null}
          <PrivacyLine className="mt-4" />
        </section>

        {/* 3. Backing block */}
        <section className="flex flex-col gap-3 sm:flex-row">
          <PeerColumn
            title="Backed by"
            peers={profile.backers}
            emptyLabel="No backers yet"
          />
          <PeerColumn
            title="Backing"
            peers={profile.backing}
            emptyLabel="Not backing anyone yet"
          />
        </section>

        {/* 4. Wins feed - each row carries its own trust tier, so a
            self-reported win reads as self-reported, never verified. */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted">
              Wins
            </h2>
            <PrivacyLine />
          </div>
          {profile.wins.length === 0 ? (
            <p className="rounded-2xl border border-edge bg-surface p-5 text-sm text-muted">
              No wins yet
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {profile.wins.map((win, index) => (
                <WinRow key={win.id} win={win} index={index} />
              ))}
            </ul>
          )}
        </section>

        {/* 5. Footer */}
      <footer className="pt-2 text-center text-xs text-muted">
        GoHealthMe &mdash; get paid the instant you hit a verified goal.
      </footer>
    </div>
  );
}

export default ProfilePaidWall;
