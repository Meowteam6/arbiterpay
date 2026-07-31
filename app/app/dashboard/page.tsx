"use client";

import Link from "next/link";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import DashboardContent from "@/components/DashboardContent";
import { EmptyState } from "@/components/ui";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          My goals
        </h1>
        <p className="mt-1 text-sm text-muted">
          What you said you would do, and what SPOTTER has paid you for it.
        </p>
      </div>
      {DYNAMIC_CONFIGURED ? (
        <DashboardContent />
      ) : (
        <EmptyState
          title="Sign-in is not configured"
          detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable embedded wallets and personal dashboards."
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
  );
}
