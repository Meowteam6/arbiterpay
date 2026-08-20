"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DynamicConnectButton } from "@dynamic-labs/sdk-react-core";
import { DEMO_CHROME, DYNAMIC_CONFIGURED } from "@/lib/config";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useDisplayNames } from "@/lib/use-display-names";
import AgentStrip from "@/components/AgentStrip";
import TestUsdcChip from "@/components/TestUsdcChip";
import { CopyAddressButton } from "@/components/FundingHelp";

// "Create pool" is deliberately NOT here. It is the sponsor's action - it
// costs money and a first-time visitor has none - so it lives one level down,
// as the primary button on /pools. The route is unchanged.
const NAV_ITEMS: { href: string; label: string }[] = [
  { href: "/pools", label: "Pools" },
  { href: "/agent", label: "SPOTTER" },
  { href: "/sponsor", label: "Sponsor" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/challenges", label: "Challenges" },
  { href: "/settings", label: "Wallet" },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({
  stacked = false,
  onNavigate,
}: {
  stacked?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`rounded-lg ${
              stacked
                ? "flex min-h-11 items-center px-3"
                : "whitespace-nowrap px-2.5 py-2 sm:px-3"
            } ${
              active
                ? "bg-surface-raised text-foreground"
                : "text-muted hover:bg-surface-raised hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

function AuthControls() {
  const { ready, authenticated, logout } = useEmbeddedWallet();

  if (!ready) {
    return (
      <div className="h-9 w-24 animate-pulse rounded-lg bg-surface-raised" />
    );
  }

  if (!authenticated) {
    // DynamicConnectButton, NOT a bare button calling setShowAuthFlow.
    // setShowAuthFlow only toggles state on the DynamicAuthFlow SDK component,
    // and this app mounts no Dynamic UI component anywhere — so the old custom
    // button flipped a flag nothing was listening to. No modal, no network
    // call, no thrown error: sign-in was silently dead in every build.
    // DynamicConnectButton owns the flow and still takes our own styling.
    return (
      <DynamicConnectButton buttonClassName="min-h-11 rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-background hover:bg-accent">
        Sign in
      </DynamicConnectButton>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        void logout();
      }}
      className="min-h-11 rounded-lg border border-edge px-3 py-2 text-sm font-medium text-muted hover:text-foreground"
    >
      Sign out
    </button>
  );
}

/**
 * Signed out this answers "what is this about to ask me for" before Dynamic's
 * modal takes over the screen. Signed in it carries the wallet address, which
 * is the first thing anyone needs: Arc gas is USDC, so funding the wallet at
 * the faucet starts by copying this.
 */
function WalletNote() {
  const { authenticated, address } = useEmbeddedWallet();
  // Resolve the signed-in wallet to its claimed @handle. The hook is disabled
  // when the array is empty, so it costs nothing before a wallet exists.
  const { handleFor } = useDisplayNames(address !== null ? [address] : []);

  if (!authenticated) {
    // Rendered while the SDK is still loading too - that window is exactly
    // when a first-time visitor is reading the header.
    return (
      <p className="py-2 text-xs leading-relaxed text-muted">
        Sign in with an email address - we create the wallet for you. No seed
        phrase, no extension, nothing to install.
      </p>
    );
  }

  if (address === null) return null;

  const handle = handleFor(address);

  // Claimed: show @handle (linked to the public profile) and keep the copy
  // chip as a secondary control. Unclaimed: keep the copy chip and nudge the
  // wallet toward claiming a name, so a bare 0x8a39...6141 is never the whole
  // identity on the header.
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">
        Your wallet
      </span>
      {handle !== null ? (
        <Link
          href={`/u/${handle}`}
          className="text-xs font-semibold text-foreground hover:text-accent"
        >
          @{handle}
        </Link>
      ) : (
        <Link
          href="/handle"
          className="text-xs font-medium text-accent underline underline-offset-2"
        >
          Claim a name
        </Link>
      )}
      <CopyAddressButton address={address} compact />
    </div>
  );
}

/**
 * The row under the header bar. It exists because the 64px bar cannot hold an
 * address, an explanation, and SPOTTER's balance at 375px without crushing the
 * nav to nothing. AgentStrip lives here rather than in the bar so it can be
 * shown on small screens (another surface owns that decision) without taking
 * space from the nav. Vertical padding sits on the children, so the row
 * collapses to a hairline when every child renders null.
 */
function HeaderNote() {
  return (
    <div className="border-t border-edge bg-surface/60">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-3 px-3 sm:px-4">
        {DYNAMIC_CONFIGURED ? (
          <div className="flex flex-wrap items-center gap-x-3">
            <WalletNote />
            <TestUsdcChip />
          </div>
        ) : null}
        <div className="ml-auto shrink-0">
          <AgentStrip />
        </div>
      </div>
    </div>
  );
}

function AuthOrPill() {
  if (DYNAMIC_CONFIGURED) return <AuthControls />;
  if (DEMO_CHROME) return null;
  // Real unconfigured builds keep the honest pill; DEMO_CHROME is the
  // cosmetic-only recording flag (lib/config.ts) and hiding operator chrome is
  // exactly its charter. The join panel's fail-closed refusal is untouched.
  return (
    <span className="rounded-lg border border-edge px-3 py-2 text-xs text-muted">
      Sign-in unavailable
    </span>
  );
}

export default function Header() {
  // Mobile (375px) cannot fit wordmark + six links + auth on one row. Below
  // `sm` the links collapse into a tap-to-open menu (a hidden horizontal
  // scroll strip is undiscoverable on a phone and left Challenges/Wallet
  // unreachable); at `sm` and up the inline nav returns. The menu closes on
  // navigation (pathname effect) and on any link tap.
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <Link
          href="/"
          className="shrink-0 text-base font-bold tracking-tight sm:text-lg"
        >
          Go<span className="text-accent">Health</span>Me
        </Link>
        {/* Desktop nav: inline, right-aligned, scrolls only if it must. */}
        <nav className="hidden min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] sm:block [&::-webkit-scrollbar]:hidden">
          <div className="flex w-max items-center gap-1 text-sm font-medium sm:ml-auto sm:gap-2">
            <NavLinks />
          </div>
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0 sm:gap-2">
          <AuthOrPill />
          {/* Mobile menu toggle: only below `sm`, where the inline nav hides. */}
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-foreground sm:hidden"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {menuOpen ? (
                <>
                  <path d="M6 6l12 12" />
                  <path d="M18 6L6 18" />
                </>
              ) : (
                <>
                  <path d="M4 7h16" />
                  <path d="M4 12h16" />
                  <path d="M4 17h16" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>
      {menuOpen ? (
        <nav
          id="mobile-nav"
          className="border-t border-edge bg-background sm:hidden"
        >
          <div className="mx-auto flex max-w-5xl flex-col gap-1 px-3 py-2 text-sm font-medium">
            <NavLinks stacked onNavigate={() => setMenuOpen(false)} />
          </div>
        </nav>
      ) : null}
      <HeaderNote />
    </header>
  );
}
