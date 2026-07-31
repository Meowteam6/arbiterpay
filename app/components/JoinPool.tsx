"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { arcTxUrl } from "@/lib/chains";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { useEmbeddedWallet } from "@/lib/wallet";
import {
  erc20Abi,
  getArcPublicClient,
  getHealthPoolsAddress,
  healthPoolsAbi,
  USDC_ADDRESS,
} from "@/lib/contract";
import { ErrorNote } from "@/components/ui";

type JoinStatus =
  | { kind: "idle" }
  | { kind: "joining" }
  | { kind: "joined"; txHash: string | null }
  | { kind: "error"; message: string };

function JoinPoolInner({
  poolId,
  entryFee,
  alreadyJoined,
}: {
  poolId: bigint;
  entryFee: bigint;
  alreadyJoined: boolean;
}) {
  const { ready, authenticated, address, login, getArcWalletClient } =
    useEmbeddedWallet();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<JoinStatus>(
    alreadyJoined ? { kind: "joined", txHash: null } : { kind: "idle" },
  );

  // The on-chain participant read resolves async and after refresh. If it
  // confirms we are already a participant, show "You are in" instead of the
  // join button -- never clobber an in-flight join or a fresh success that
  // already carries its tx hash.
  useEffect(() => {
    if (alreadyJoined) {
      setStatus((s) => (s.kind === "idle" ? { kind: "joined", txHash: null } : s));
    }
  }, [alreadyJoined]);

  const startJoin = async () => {
    if (address === null) return;
    setStatus({ kind: "joining" });
    try {
      const poolsAddress = getHealthPoolsAddress();
      if (poolsAddress === null) {
        throw new Error(
          "HealthPools contract address is not configured. Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS.",
        );
      }
      // joinPool's second parameter is a dedupe value the contract stores and
      // rejects on reuse (ALREADY_JOINED). The wallet address IS the entry
      // identity, so it is the value: one wallet, one entry, enforced on-chain.
      const nullifier = BigInt(address);
      const walletClient = await getArcWalletClient();
      const publicClient = getArcPublicClient();

      // Entry-fee pools pull USDC on join; approve that amount first.
      if (entryFee > 0n) {
        const approveHash = await walletClient.writeContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [poolsAddress, entryFee],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      const joinHash = await walletClient.writeContract({
        address: poolsAddress,
        abi: healthPoolsAbi,
        functionName: "joinPool",
        args: [poolId, nullifier],
      });
      await publicClient.waitForTransactionReceipt({ hash: joinHash });

      setStatus({ kind: "joined", txHash: joinHash });
      await queryClient.invalidateQueries({ queryKey: ["pool"] });
      await queryClient.invalidateQueries({ queryKey: ["participants"] });
      // Also refetch the SINGULAR participant query (["participant", id, address]):
      // it drives hasJoined, which gates the document upload + private-claim
      // sections. Without this they only appear after a manual page reload.
      await queryClient.invalidateQueries({ queryKey: ["participant"] });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Joining the pool failed.",
      });
    }
  };

  if (status.kind === "joined") {
    return (
      <div className="rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
        <p className="text-base font-semibold text-accent">
          You are in. One wallet, one entry.
        </p>
        {status.txHash !== null ? (
          <a
            href={arcTxUrl(status.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block break-all text-sm text-accent underline"
          >
            View join transaction on Arcscan
          </a>
        ) : null}
      </div>
    );
  }

  const busy = status.kind === "joining";

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => {
          if (!authenticated) {
            login();
            return;
          }
          void startJoin();
        }}
        className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status.kind === "joining"
          ? "Joining on-chain..."
          : authenticated
            ? "I'm in"
            : "Sign in to join"}
      </button>
      <p className="text-xs text-muted">
        One wallet, one entry. No sign-ups, no extra apps.
      </p>
      {status.kind === "error" ? (
        <ErrorNote
          title="Could not join the pool"
          detail={status.message}
          onRetry={() => setStatus({ kind: "idle" })}
        />
      ) : null}
    </div>
  );
}

export default function JoinPool({
  poolId,
  entryFee,
  alreadyJoined = false,
}: {
  poolId: bigint;
  entryFee: bigint;
  alreadyJoined?: boolean;
}) {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable joining with an embedded wallet."
      />
    );
  }
  return (
    <JoinPoolInner
      poolId={poolId}
      entryFee={entryFee}
      alreadyJoined={alreadyJoined}
    />
  );
}
