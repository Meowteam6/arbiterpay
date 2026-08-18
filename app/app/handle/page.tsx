import type { Metadata } from "next";
import ClaimHandle from "@/components/ClaimHandle";

export const metadata: Metadata = {
  title: "Claim your handle - GoHealthMe",
};

export default function HandlePage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Claim your handle</h1>
        <p className="text-sm text-muted">
          A handle turns your wallet address into a name. It replaces
          0x1234...abcd across the app and gives you a public page at
          /u/your-handle that shows your verified wins and payouts - never the
          health category behind them.
        </p>
      </div>
      <ClaimHandle />
    </div>
  );
}
