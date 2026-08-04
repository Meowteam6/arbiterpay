"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { arcTxUrl } from "@/lib/chains";
import { formatUsdc } from "@/lib/contract";
import {
  FAUCET_GRANT_UUSDC,
  WITHDRAW_DAILY_CAP_UUSDC,
} from "@/lib/money-guards";
import { ErrorNote } from "@/components/ui";

/**
 * GoHealthMe balance card.
 *
 * Two actions, and the copy has to be exact about which is which because they
 * are not the same kind of thing:
 *
 *   1. The faucet GRANTS in-app balance. It is a testnet convenience so a new
 *      visitor can try a pool without sourcing testnet USDC first. No payment
 *      happens, nothing is pulled from the visitor's wallet, and nothing
 *      settles on Base Sepolia. This card used to say "Blink pulls USDC from
 *      your wallet on Base Sepolia in one tap", which never happened: the
 *      route only ever credited a number. Claiming a payment that did not
 *      occur is the one thing this product cannot do.
 *
 *   2. Moving to the Arc wallet is real: the treasury sends actual Arc USDC to
 *      the signed-in address, which the join/fund/back flows then spend.
 *
 * Both routes enforce caps server-side. The client mirrors the withdrawal cap
 * only so the button can state the amount it will actually move; the server
 * remains the authority and refuses anything over it.
 */

interface BalanceResponse {
  balanceUusdc?: string;
}

async function fetchBalanceUusdc(address: string): Promise<bigint> {
  const res = await fetch(`/api/balance?address=${address}`);
  if (!res.ok) {
    throw new Error(`Balance feed responded ${res.status}.`);
  }
  const body = (await res.json()) as BalanceResponse;
  return BigInt(body.balanceUusdc ?? "0");
}

type MoveStatus =
  | { kind: "idle" }
  | { kind: "moving" }
  | { kind: "done"; txHash: string }
  // A cap, cooldown, or treasury floor. Expected, not a fault.
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string };

type FaucetStatus =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "granted" }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string };

/** Server refusals that are policy, not failure: show them plainly. */
const REFUSAL_STATUSES = new Set([429, 503]);

function LimitNote({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="mt-2 rounded-xl border border-warning/40 bg-warning/10 p-4"
    >
      <p className="text-sm text-foreground/80">{message}</p>
    </div>
  );
}

export default function BalanceCard({ address }: { address: `0x${string}` }) {
  const queryClient = useQueryClient();
  const [move, setMove] = useState<MoveStatus>({ kind: "idle" });
  const [faucet, setFaucet] = useState<FaucetStatus>({ kind: "idle" });

  const balanceQuery = useQuery({
    queryKey: ["balance", address],
    queryFn: () => fetchBalanceUusdc(address),
    retry: false,
  });

  const balance = balanceQuery.data ?? 0n;

  // The server caps a single address per day, so asking for more than the cap
  // can only ever be refused. Move what is actually movable and say so.
  const moveAmount =
    balance > WITHDRAW_DAILY_CAP_UUSDC ? WITHDRAW_DAILY_CAP_UUSDC : balance;

  const refreshBalance = async () => {
    await queryClient.invalidateQueries({ queryKey: ["balance", address] });
  };

  // Claim the testnet faucet grant. The server derives its own idempotency key
  // from the address, so there is deliberately nothing to send but the address.
  const claimFaucet = async () => {
    setFaucet({ kind: "claiming" });
    try {
      const res = await fetch("/api/blink/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        balanceUusdc?: string;
        applied?: boolean;
        error?: string;
      };

      if (REFUSAL_STATUSES.has(res.status)) {
        setFaucet({
          kind: "refused",
          message: body.error ?? "The faucet is not available right now.",
        });
        return;
      }
      if (!res.ok || typeof body.balanceUusdc !== "string") {
        throw new Error(
          body.error ?? `The faucet responded with status ${res.status}.`,
        );
      }
      // applied === false means this address already claimed in this window
      // and the ledger correctly refused to credit it twice.
      setFaucet(
        body.applied === true
          ? { kind: "granted" }
          : {
              kind: "refused",
              message:
                "This address already claimed in the current faucet window. Nothing was granted.",
            },
      );
      await refreshBalance();
    } catch (err) {
      setFaucet({
        kind: "error",
        message:
          err instanceof Error ? err.message : "The faucet request failed.",
      });
    }
  };

  const moveToArc = async () => {
    if (moveAmount <= 0n) return;
    setMove({ kind: "moving" });
    try {
      const ref = crypto.randomUUID();
      const res = await fetch("/api/balance/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          amountUusdc: moveAmount.toString(),
          ref,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        txHash?: string;
        error?: string;
      };

      if (REFUSAL_STATUSES.has(res.status)) {
        setMove({
          kind: "refused",
          message:
            body.error ?? "This transfer cannot be made right now. Nothing moved.",
        });
        await refreshBalance();
        return;
      }
      if (!res.ok || typeof body.txHash !== "string") {
        throw new Error(body.error ?? `Move failed with status ${res.status}.`);
      }
      setMove({ kind: "done", txHash: body.txHash });
      await refreshBalance();
    } catch (err) {
      setMove({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Move to Arc wallet failed.",
      });
    }
  };

  const moving = move.kind === "moving";
  const claiming = faucet.kind === "claiming";

  return (
    <section className="rounded-2xl border border-edge bg-surface p-5">
      <h2 className="text-lg font-semibold">GoHealthMe balance</h2>
      <p className="mt-3 text-3xl font-bold text-accent">
        {formatUsdc(balance)}
        <span className="ml-1 text-lg font-semibold text-foreground">USDC</span>
      </p>
      <p className="mt-1 text-sm text-muted">
        Test balance you can move to your Arc wallet to back goals and fund
        pools.
      </p>

      <button
        type="button"
        disabled={claiming}
        onClick={() => {
          void claimFaucet();
        }}
        className="mt-4 w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {claiming
          ? "Claiming from the faucet..."
          : `Claim ${formatUsdc(FAUCET_GRANT_UUSDC)} test USDC from the faucet`}
      </button>
      <p className="mt-2 text-xs text-muted">
        Testnet faucet: GoHealthMe grants {formatUsdc(FAUCET_GRANT_UUSDC)} test
        USDC to this address once every 24 hours so you can try a pool. Nothing
        is charged and nothing leaves your wallet.
      </p>
      {faucet.kind === "granted" ? (
        <div className="mt-2 rounded-xl border border-accent/40 bg-accent-deep/40 p-3">
          <p className="text-sm font-semibold text-accent">
            Granted {formatUsdc(FAUCET_GRANT_UUSDC)} test USDC to your balance.
          </p>
        </div>
      ) : null}
      {faucet.kind === "refused" ? <LimitNote message={faucet.message} /> : null}
      {faucet.kind === "error" ? (
        <ErrorNote
          title="Could not reach the faucet"
          detail={faucet.message}
          onRetry={() => setFaucet({ kind: "idle" })}
        />
      ) : null}

      <button
        type="button"
        disabled={moveAmount <= 0n || moving}
        onClick={() => {
          void moveToArc();
        }}
        className="mt-3 w-full rounded-xl bg-accent-strong px-5 py-3 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {moving
          ? "Moving to Arc wallet..."
          : `Move ${formatUsdc(moveAmount)} USDC to Arc wallet`}
      </button>
      <p className="mt-2 text-xs text-muted">
        This one is a real transfer: the treasury sends Arc USDC to your wallet.
        Up to {formatUsdc(WITHDRAW_DAILY_CAP_UUSDC)} USDC per address per day.
      </p>

      {move.kind === "done" ? (
        <div className="mt-2 rounded-xl border border-accent/40 bg-accent-deep/40 p-3">
          <p className="text-sm font-semibold text-accent">
            Moved to your Arc wallet. It is now spendable on goals and pools.
          </p>
          <a
            href={arcTxUrl(move.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block break-all text-sm text-accent underline"
          >
            View transfer on Arcscan
          </a>
        </div>
      ) : null}
      {move.kind === "refused" ? <LimitNote message={move.message} /> : null}
      {move.kind === "error" ? (
        <ErrorNote
          title="Could not move your balance"
          detail={move.message}
          onRetry={() => setMove({ kind: "idle" })}
        />
      ) : null}
    </section>
  );
}
