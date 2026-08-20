"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Address } from "viem";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import {
  fetchParticipants,
  getHealthPoolsAddress,
  parseUsdc,
} from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useUsdcDeposit } from "@/lib/useUsdcDeposit";
import { useDisplayNames } from "@/lib/use-display-names";
import { ArcTxLink, ErrorNote } from "@/components/ui";
import SignInGate from "@/components/SignInGate";

function BackGoalInner({ poolId }: { poolId: bigint }) {
  const { ready, authenticated, address } = useEmbeddedWallet();
  const queryClient = useQueryClient();
  const { status, busy, reset, runUsdcDeposit } = useUsdcDeposit();
  const [participant, setParticipant] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);

  const participantsQuery = useQuery({
    queryKey: ["participants", poolId.toString()],
    queryFn: () => fetchParticipants(poolId),
  });

  const participants = participantsQuery.data ?? [];
  const { displayName } = useDisplayNames(participants);

  const poolsAddress = getHealthPoolsAddress();
  if (poolsAddress === null) {
    return (
      <ErrorNote
        title="Contract not configured"
        detail="Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS to enable backing."
      />
    );
  }

  const submit = async () => {
    setFormError(null);
    let amountUsdc: bigint;
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(participant)) {
        throw new Error("Choose a participant to back.");
      }
      amountUsdc = parseUsdc(amount.trim());
      if (amountUsdc <= 0n) {
        throw new Error("Enter a USDC amount greater than zero.");
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Check the backing details.",
      );
      return;
    }

    try {
      await runUsdcDeposit(amountUsdc, {
        functionName: "backGoal",
        args: [poolId, participant as Address, amountUsdc],
      });
      setAmount("");
      await queryClient.invalidateQueries({ queryKey: ["pool"] });
    } catch {
      // useUsdcDeposit captured the error into status.
    }
  };

  const primaryLabel =
    status.kind === "approving"
      ? "Approving USDC..."
      : status.kind === "depositing"
        ? "Staking behind goal..."
        : authenticated
          ? "Approve and back goal"
          : "Sign in to back";

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">Back this goal</h3>
      <p className="text-sm text-muted">
        Back a participant&apos;s goal with USDC. This is separate from joining;
        you are betting on their success.
      </p>
      <p className="text-sm text-muted">
        Stake USDC behind a participant. If they hit the goal you get your
        stake back plus a bonus from the pool; if they miss, your stake rolls
        into the bounty.
      </p>

      {participantsQuery.isLoading ? (
        <div className="h-12 animate-pulse rounded-xl bg-surface-raised" />
      ) : participantsQuery.isError ? (
        <ErrorNote
          title="Could not load participants"
          detail={
            participantsQuery.error instanceof Error
              ? participantsQuery.error.message
              : undefined
          }
          onRetry={() => {
            void participantsQuery.refetch();
          }}
        />
      ) : participants.length === 0 ? (
        <p className="rounded-xl border border-dashed border-edge p-4 text-sm text-muted">
          No participants have joined yet. Backing opens once the first person
          joins.
        </p>
      ) : (
        <>
          <label className="block text-sm font-medium">
            Participant
            <select
              value={participant}
              onChange={(e) => setParticipant(e.target.value)}
              className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
            >
              <option value="">Select a participant</option>
              {participants.map((p) => (
                <option key={p} value={p}>
                  {address !== null && p.toLowerCase() === address.toLowerCase()
                    ? `${displayName(p)} (you)`
                    : displayName(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Amount (USDC)
            <input
              type="text"
              inputMode="decimal"
              placeholder="10.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
            />
          </label>
          <SignInGate note="Sign in to back this goal.">
            {(openSignIn) => (
              <button
                type="button"
                disabled={!ready || busy}
                onClick={() => {
                  if (!authenticated) {
                    openSignIn();
                    return;
                  }
                  void submit();
                }}
                className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3.5 text-base font-semibold text-accent hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {primaryLabel}
              </button>
            )}
          </SignInGate>
        </>
      )}

      {status.kind === "approving" || status.kind === "depositing" ? (
        <p className="text-xs text-muted">
          Step {status.kind === "approving" ? "1" : "2"} of 2:{" "}
          {status.kind === "approving"
            ? "approving USDC"
            : "placing the stake on Arc"}
          ...
        </p>
      ) : null}

      {status.kind === "done" ? (
        <div className="space-y-1 rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
          <p className="text-sm font-semibold text-accent">
            Stake placed behind the goal.
          </p>
          {status.approveHash ? (
            <>
              <ArcTxLink txHash={status.approveHash} label="View approval tx" />
              <br />
            </>
          ) : null}
          <ArcTxLink txHash={status.depositHash} label="View backGoal tx" />
        </div>
      ) : null}

      {formError !== null ? (
        <ErrorNote
          title="Check the backing details"
          detail={formError}
          onRetry={() => setFormError(null)}
        />
      ) : null}

      {status.kind === "error" ? (
        <ErrorNote
          title="Backing failed"
          detail={status.message}
          onRetry={reset}
        />
      ) : null}
    </div>
  );
}

export default function BackGoal({ poolId }: { poolId: bigint }) {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable backing with an embedded wallet."
      />
    );
  }
  return <BackGoalInner poolId={poolId} />;
}
