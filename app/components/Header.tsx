"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { useEmbeddedWallet } from "@/lib/wallet";
import AgentStrip from "@/components/AgentStrip";

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: "/pools", label: "Pools" },
  { href: "/agent", label: "SPOTTER" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/pools/create", label: "Create pool" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/pools") {
    return pathname === "/pools" || /^\/pools\/(?!create).+/.test(pathname);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded-lg px-2.5 py-2 sm:px-3 ${
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
  const { ready, authenticated, address, login, logout } = useEmbeddedWallet();

  if (!ready) {
    return (
      <div className="h-9 w-24 animate-pulse rounded-lg bg-surface-raised" />
    );
  }

  if (!authenticated) {
    return (
      <button
        type="button"
        onClick={login}
        className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-background hover:bg-accent"
      >
        Sign in
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {address !== null ? (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(address);
          }}
          title={`Click to copy ${address}`}
          className="hidden rounded-lg border border-edge bg-surface-raised px-3 py-2 font-mono text-xs text-muted hover:text-foreground sm:inline"
        >
          {address}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
        className="rounded-lg border border-edge px-3 py-2 text-sm font-medium text-muted hover:text-foreground"
      >
        Sign out
      </button>
    </div>
  );
}

export default function Header() {
  // Mobile (375px) cannot fit wordmark + 4 links + auth on one row. The nav
  // links live in their own horizontally scrollable strip (only the nav
  // scrolls, never the page); wordmark and auth stay pinned at the edges.
  // AgentStrip is already hidden below sm.
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <Link
          href="/"
          className="shrink-0 text-base font-bold tracking-tight sm:text-lg"
        >
          Go<span className="text-accent">Health</span>Me
        </Link>
        <nav className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex w-max items-center gap-1 text-sm font-medium sm:ml-auto sm:gap-2">
            <NavLinks />
          </div>
        </nav>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <AgentStrip />
          {DYNAMIC_CONFIGURED ? (
            <AuthControls />
          ) : (
            <span className="rounded-lg border border-edge px-3 py-2 text-xs text-muted">
              Sign-in unavailable
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
