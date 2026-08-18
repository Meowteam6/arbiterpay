import type { Metadata } from "next";
import Link from "next/link";
import NamedPayoutFeed from "@/components/NamedPayoutFeed";

export const metadata: Metadata = {
  title: "Payout feed - GoHealthMe",
};

export default function FeedPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 py-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Who got paid</h1>
        <p className="text-sm text-muted">
          Every verified win SPOTTER has settled on Arc, named by handle where
          the wallet has claimed one. The amount and the settlement tx are
          public; the health category behind each goal never is.
        </p>
      </div>

      <NamedPayoutFeed />

      <p className="text-center text-sm text-muted">
        <Link
          href="/handle"
          className="text-accent underline-offset-4 hover:underline"
        >
          Claim your handle
        </Link>{" "}
        to show up here by name.
      </p>
    </div>
  );
}
