import type { Metadata } from "next";
import Link from "next/link";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import SponsorConsole from "@/components/SponsorConsole";
import { EmptyState } from "@/components/ui";

export const metadata: Metadata = {
  title: "Sponsor console — GoHealthMe",
  description:
    "Create and fund USDC health-goal pools and see privacy-safe aggregate outcomes. No participant health data is ever shown.",
};

// Server component that mirrors the dashboard: it only gates on whether sign-in
// is configured and hands off to the client console. When Dynamic is unset the
// console cannot pull USDC from a wallet, so the page says so honestly rather
// than rendering a create form that can never submit.
export default function SponsorPage() {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Sponsor console
          </h1>
          <p className="mt-1 text-sm text-muted">
            Create and fund USDC health-goal pools, and see privacy-safe
            aggregate outcomes.
          </p>
        </div>
        <EmptyState
          title="Sign-in is not configured"
          detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable embedded wallets and the sponsor console."
          action={
            <Link
              href="/pools"
              className="inline-block rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
            >
              Browse pools instead
            </Link>
          }
        />
      </div>
    );
  }
  return <SponsorConsole />;
}
