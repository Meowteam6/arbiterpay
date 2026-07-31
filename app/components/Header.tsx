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
            className={`rounded-lg px-3 py-2 ${
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
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Go<span className="text-accent">Health</span>Me
        </Link>
        <nav className="flex items-center gap-1 text-sm font-medium sm:gap-2">
          <NavLinks />
          <AgentStrip />
          {DYNAMIC_CONFIGURED ? (
            <AuthControls />
          ) : (
            <span className="rounded-lg border border-edge px-3 py-2 text-xs text-muted">
              Sign-in unavailable
            </span>
          )}
        </nav>
      </div>
    </header>
  );
}
