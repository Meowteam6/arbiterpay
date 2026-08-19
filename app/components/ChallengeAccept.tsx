"use client";

// The Accept control on the you've-been-challenged landing.
//
// Accepting a challenge IS joining its pool: this wraps the SAME JoinPool
// primitive the pool page uses, with the entry fee pinned to zero (the
// challenger funded the pot; the target pays nothing). One wallet, one entry is
// enforced on-chain by joinPool exactly as everywhere else. After joining, the
// target is handed off to the pool page, which is where evidence upload and the
// claim rail live - this landing does not reimplement that flow, it routes into
// it.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import JoinPool from "@/components/JoinPool";
import { fetchParticipant } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { TAP_TARGET } from "@/components/ui";

export default function ChallengeAccept({ poolId }: { poolId: string }) {
  const { address } = useEmbeddedWallet();

  let poolIdBig: bigint | null;
  try {
    poolIdBig = BigInt(poolId);
  } catch {
    poolIdBig = null;
  }

  // Reflect an already-accepted challenge so a returning target sees "you are
  // in" and a route onward, instead of tapping accept and hitting an
  // ALREADY_JOINED revert. Owner-scoped and best-effort: an unknown status just
  // shows the accept button, which fails closed on-chain anyway.
  const participantQuery = useQuery({
    queryKey: ["participant", poolId, address],
    queryFn: () => {
      if (poolIdBig === null) throw new Error("Invalid pool id.");
      if (address === null) throw new Error("No wallet connected.");
      return fetchParticipant(poolIdBig, address);
    },
    enabled: poolIdBig !== null && address !== null,
  });

  const joined = participantQuery.data?.joined === true;

  if (poolIdBig === null) return null;

  return (
    <div className="space-y-4">
      <JoinPool poolId={poolIdBig} entryFee={0n} alreadyJoined={joined} />
      <Link
        href={`/pools/${poolId}`}
        className={`w-full rounded-xl border border-accent/40 bg-accent-deep/30 font-semibold text-accent hover:bg-accent-deep/50 ${TAP_TARGET}`}
      >
        {joined ? "Upload your proof and get paid" : "See the full challenge"}
      </Link>
    </div>
  );
}
