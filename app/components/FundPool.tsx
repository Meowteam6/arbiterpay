"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { getHealthPoolsAddress, parseUsdc } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useUsdcDeposit } from "@/lib/useUsdcDeposit";
import { ArcTxLink, ErrorNote } from "@/components/ui";

interface FundPoolCopy {
  /** Section heading. Defaults to the sponsor top-up wording. */
  heading: string;
  /** One-line description under the heading. */
  description: string;
  /** The primary-button verb when signed in and idle. */
  ctaLabel: string;
}

function FundPoolInner({
  poolId,
  heading,
  description,
  ctaLabel,
}: { poolId: bigint } & FundPoolCopy) {
  const queryClient = useQueryClient();
  const { ready, authenticated, login } = useEmbeddedWallet();
  const { status, busy, reset, runUsdcDeposit } = useUsdcDeposit();
  const [amount, setAmount] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);

  const poolsAddress = getHealthPoolsAddress();
  if (poolsAddress === null) {
    return (
      <ErrorNote
        title="Contract not configured"
        detail="Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS to enable funding."
      />
    );
  }

  const submit = async () => {
    setFormError(null);
    let amountUsdc: bigint;
    try {
      amountUsdc = parseUsdc(amount.trim());
      if (amountUsdc <= 0n) {
        throw new Error("Enter a USDC amount greater than zero.");
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Enter a valid USDC amount.",
      );
      return;
    }

    try {
      await runUsdcDeposit(amountUsdc, {
        functionName: "fundPool",
        args: [poolId, amountUsdc],
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
        ? "Topping up pool..."
        : authenticated
          ? ctaLabel
          : "Sign in to top up";

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">{heading}</h3>
      <p className="text-sm text-muted">{description}</p>

      <label className="block text-sm font-medium">
        Amount (USDC)
        <input
          type="text"
          inputMode="decimal"
          placeholder="25.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
        />
      </label>

      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => {
          if (!authenticated) {
            login();
            return;
          }
          void submit();
        }}
        className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3.5 text-base font-semibold text-accent hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-60"
      >
        {primaryLabel}
      </button>

      {status.kind === "approving" || status.kind === "depositing" ? (
        <p className="text-xs text-muted">
          Step {status.kind === "approving" ? "1" : "2"} of 2:{" "}
          {status.kind === "approving"
            ? "approving USDC"
            : "funding the pool on Arc"}
          ...
        </p>
      ) : null}

      {status.kind === "done" ? (
        <div className="space-y-1 rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
          <p className="text-sm font-semibold text-accent">
            Pool topped up.
          </p>
          {status.approveHash ? (
            <>
              <ArcTxLink txHash={status.approveHash} label="View approval tx" />
              <br />
            </>
          ) : null}
          <ArcTxLink txHash={status.depositHash} label="View fundPool tx" />
        </div>
      ) : null}

      {formError !== null ? (
        <ErrorNote
          title="Check the amount"
          detail={formError}
          onRetry={() => setFormError(null)}
        />
      ) : null}

      {status.kind === "error" ? (
        <ErrorNote
          title="Funding failed"
          detail={status.message}
          onRetry={reset}
        />
      ) : null}
    </div>
  );
}

export default function FundPool({
  poolId,
  heading = "Top up this pool",
  description = "Add USDC to the bounty so more participants can be paid when they hit the goal.",
  ctaLabel = "Approve and top up",
}: {
  poolId: bigint;
} & Partial<FundPoolCopy>) {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable funding with an embedded wallet."
      />
    );
  }
  return (
    <FundPoolInner
      poolId={poolId}
      heading={heading}
      description={description}
      ctaLabel={ctaLabel}
    />
  );
}
