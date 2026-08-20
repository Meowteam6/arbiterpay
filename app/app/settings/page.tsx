import type { Metadata } from "next";
import Link from "next/link";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import WalletSettings from "@/components/WalletSettings";
import { EmptyState } from "@/components/ui";

export const metadata: Metadata = {
  title: "Wallet - GoHealthMe",
  description:
    "Your GoHealthMe wallet: address, Arc testnet balance, whether it is the wallet we made for you or one you connected, and how to back it up.",
};

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl py-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Wallet</h1>
        <p className="text-sm text-muted">
          Where your USDC lives and how to look after it.
        </p>
      </header>

      <div className="mt-6">
        {DYNAMIC_CONFIGURED ? (
          <WalletSettings />
        ) : (
          <EmptyState
            title="Sign-in is not configured"
            detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable embedded wallets and this page."
            action={
              <Link
                href="/pools"
                className="inline-block rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
              >
                Browse pools instead
              </Link>
            }
          />
        )}
      </div>
    </div>
  );
}
