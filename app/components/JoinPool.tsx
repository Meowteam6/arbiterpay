"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { arcTxUrl } from "@/lib/chains";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { useEmbeddedWallet } from "@/lib/wallet";
import {
  erc20Abi,
  formatUsdc,
  getArcPublicClient,
  getHealthPoolsAddress,
  healthPoolsAbi,
  USDC_ADDRESS,
} from "@/lib/contract";
import {
  canCoverJoinCosts,
  humanizeTxError,
  type HumanTxError,
} from "@/lib/tx-errors";
import { ErrorNote } from "@/components/ui";

type JoinStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "joining" }
  | { kind: "joined"; txHash: string | null }
  | { kind: "needs-funds"; balance: bigint }
  | { kind: "error"; error: HumanTxError };

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

  // Re-entrancy guard. The main join button disables while busy, but the
  // funding card's check-again button renders in a non-busy state, so a
  // double-click could start two joins: the second would revert with
  // ALREADY_JOINED and clobber the first one's success UI. State updates are
  // async, so a ref is the reliable same-tick guard.
  const joinInFlight = useRef(false);

  const startJoin = async () => {
    if (address === null || joinInFlight.current) return;
    joinInFlight.current = true;
    setStatus({ kind: "checking" });
    try {
      const poolsAddress = getHealthPoolsAddress();
      if (poolsAddress === null) {
        throw new Error(
          "HealthPools contract address is not configured. Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS.",
        );
      }
      const publicClient = getArcPublicClient();

      // Preflight: Arc pays gas in USDC, so a wallet with no USDC cannot send
      // ANY transaction - viem would dump a raw insufficient-funds stack. Read
      // the balance first and show a funding card instead of attempting the
      // approve or join. A failed read falls through: the preflight is
      // best-effort and the catch below humanizes whatever the wallet throws.
      let balance: bigint | null = null;
      try {
        balance = await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
      } catch {
        balance = null;
      }
      if (balance !== null && !canCoverJoinCosts(balance, entryFee)) {
        setStatus({ kind: "needs-funds", balance });
        return;
      }

      // joinPool's second parameter is a dedupe value the contract stores and
      // rejects on reuse (ALREADY_JOINED). The wallet address IS the entry
      // identity, so it is the value: one wallet, one entry, enforced on-chain.
      const nullifier = BigInt(address);
      const walletClient = await getArcWalletClient();
      setStatus({ kind: "joining" });

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
      setStatus({ kind: "error", error: humanizeTxError(err) });
    } finally {
      joinInFlight.current = false;
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

  if (status.kind === "needs-funds") {
    return (
      <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
        <p className="text-base font-semibold text-warning">
          Your wallet needs USDC before it can join
        </p>
        <p className="mt-1 text-sm text-foreground/80">
          Arc testnet pays gas in USDC, so even a free pool needs a small
          balance to cover the transaction.
          {entryFee > 0n
            ? ` This pool also pulls a ${formatUsdc(entryFee)} USDC entry fee when you join.`
            : ""}
          {` Current balance: ${formatUsdc(status.balance)} USDC.`}
        </p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">
          Your wallet address
        </p>
        <p className="mt-1 break-all font-mono text-xs text-foreground/80">
          {address}
        </p>
        <div className="mt-3 space-y-1 text-sm text-foreground/80">
          <p>
            <a
              href="https://faucet.circle.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              Get test USDC from the Circle faucet
            </a>{" "}
            and send it to the address above.
          </p>
          <p>
            Or top up in-app from the balance card on{" "}
            <Link href="/dashboard" className="text-accent underline">
              your dashboard
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={() => void startJoin()}
          className="mt-4 w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:opacity-60"
        >
          I added USDC, check again
        </button>
      </div>
    );
  }

  const busy = status.kind === "checking" || status.kind === "joining";

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
        {status.kind === "checking"
          ? "Checking your balance..."
          : status.kind === "joining"
            ? "Joining on-chain..."
            : authenticated
              ? "I'm in"
              : "Sign in to join"}
      </button>
      <p className="text-xs text-muted">
        One wallet, one entry. No sign-ups, no extra apps.
      </p>
      {status.kind === "error" ? (
        <div className="space-y-2">
          <ErrorNote
            title={status.error.title}
            detail={status.error.detail}
            onRetry={() => setStatus({ kind: "idle" })}
          />
          {status.error.raw !== "" &&
          status.error.raw !== status.error.detail ? (
            <details className="rounded-xl border border-edge bg-surface/50 px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium text-muted">
                Technical details
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
                {status.error.raw}
              </pre>
            </details>
          ) : null}
        </div>
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
