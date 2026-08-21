"use client";

import Link from "next/link";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import DashboardContent from "@/components/DashboardContent";
import SceneHeader from "@/components/SceneHeader";
import { EmptyState } from "@/components/ui";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <SceneHeader
        title="My goals"
        subtitle="What you said you would do, and what SPOTTER has paid you for it."
        pose="spotter-lounging.png"
        poseAlt="SPOTTER the otter lounging with a gold coin, payday"
      />
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
