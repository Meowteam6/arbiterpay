"use client";

// Wearable verification for wearable-goal pools: connect a provider through
// Junction Link, then hand the claim to SPOTTER with one tap. The run POSTs
// /api/agent/run/[goalId] with evidenceKind "wearable" and no attesterId -
// SPOTTER pulls the health summary server-side, so nothing raw ever passes
// through the browser or the chain. Mirrors the document flow's polling and
// receipt so both evidence paths end in the same terminal states.

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { displayGoalSpec, fetchGoalId } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import {
  failureModeOf,
  toUsd2,
  type LedgerEntry,
  type RunStatus,
} from "@/lib/agent-receipt";
import AgentReceipt from "@/components/AgentReceipt";
import PayoutMoment from "@/components/PayoutMoment";
import { ErrorNote, Skeleton } from "@/components/ui";

// Same cadence as the document flow, but wearable runs wait on provider data
// pulls, so the cap allows five minutes before a stuck run surfaces.
const POLL_INTERVAL_MS = 800;
const MAX_POLLS = 375;

/** Run statuses that end the polling loop. "recorded" also stops it: the pool
 *  period has not ended, and SPOTTER settles the moment it does. */
const TERMINAL: RunStatus[] = [
  "paid",
  "no-pay",
  "cap-exceeded",
  "blocked",
  "recorded",
  "error",
];

interface RunResponse {
  status?: RunStatus;
  ledger?: LedgerEntry[];
  error?: string;
}

type CheckStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "agent"; runStatus: RunStatus; ledger: LedgerEntry[] }
  // ledger carries whatever SPOTTER recorded before the failure - money that
  // moved must stay on screen even when the run dies.
  | { kind: "error"; message: string; ledger?: LedgerEntry[] };

type ConnectionState =
  | { kind: "connected" }
  | { kind: "not-connected" }
  | { kind: "unavailable"; reason: string };

async function fetchConnectionState(
  address: `0x${string}`,
): Promise<ConnectionState> {
  try {
    const res = await fetch(`/api/junction/progress?address=${address}`);
    if (!res.ok) {
      return {
        kind: "unavailable",
        reason: `Wearable connection check responded ${res.status}.`,
      };
    }
    const body = (await res.json()) as { connected?: boolean };
    return body.connected === true
      ? { kind: "connected" }
      : { kind: "not-connected" };
  } catch {
    return {
      kind: "unavailable",
      reason: "Could not reach the wearable connection check.",
    };
  }
}

/** Open Junction Link in a new tab to connect WHOOP, Oura, Fitbit, Garmin. */
async function openConnectFlow(address: `0x${string}`): Promise<void> {
  const res = await fetch("/api/junction/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!res.ok) throw new Error(`Link token request failed (${res.status}).`);
  const { linkUrl } = (await res.json()) as { linkUrl?: string };
  if (typeof linkUrl !== "string") {
    throw new Error("The connect flow did not return a link URL.");
  }
  window.open(linkUrl, "_blank", "noopener");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function WearableCheckInner({
  poolId,
  goalSpec,
}: {
  poolId: bigint;
  goalSpec: string;
}) {
  const { ready, authenticated, address, login } = useEmbeddedWallet();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CheckStatus>({ kind: "idle" });
  const [connectError, setConnectError] = useState<string | null>(null);
  // A queued second click must not start a second poll loop against the same
  // goal; state updates flush too late to be the guard.
  const runningRef = useRef(false);

  const readableGoal = displayGoalSpec(goalSpec);

  const connectionQuery = useQuery({
    // Key is distinct from the dashboard's junction queries: this one caches
    // a ConnectionState, and sharing a key would serve the wrong shape.
    queryKey: ["junction-connection-state", address],
    queryFn: () => {
      if (address === null) throw new Error("No wallet connected.");
      return fetchConnectionState(address);
    },
    enabled: address !== null,
    retry: false,
  });

  const run = async () => {
    if (address === null) return;
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      await runInner(address);
    } finally {
      runningRef.current = false;
    }
  };

  const runInner = async (address: `0x${string}`) => {
    // The claim's ledger is keyed by the on-chain goal id, so read it from
    // the contract; the run route re-derives and enforces the match.
    setStatus({ kind: "starting" });
    let goalId: string;
    try {
      goalId = await fetchGoalId(poolId, address);
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Could not derive the goal id from the contract.",
      });
      return;
    }

    // Drive SPOTTER's run loop. Every poll resumes it where it stopped and
    // returns the full ledger; the receipt renders it verbatim. No attester
    // id: SPOTTER fetches the wearable summary itself, server-side.
    let last: RunStatus = "verifying";
    let lastLedger: LedgerEntry[] | undefined;
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      let body: RunResponse;
      try {
        const res = await fetch(`/api/agent/run/${goalId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            poolId: poolId.toString(),
            address,
            goalSpec,
            evidenceKind: "wearable",
          }),
        });
        body = (await res.json().catch(() => ({}))) as RunResponse;
        if (!res.ok) {
          throw new Error(body.error ?? `SPOTTER responded ${res.status}.`);
        }
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "The agent run failed.",
          ledger: lastLedger,
        });
        return;
      }

      if (body.status === undefined || body.ledger === undefined) {
        setStatus({
          kind: "error",
          message: "SPOTTER returned an unexpected response.",
          ledger: lastLedger,
        });
        return;
      }

      last = body.status;
      lastLedger = body.ledger;
      setStatus({ kind: "agent", runStatus: last, ledger: body.ledger });

      if (TERMINAL.includes(last)) {
        if (last === "recorded") {
          await queryClient.invalidateQueries({ queryKey: ["pool"] });
          await queryClient.invalidateQueries({ queryKey: ["participant"] });
        }
        if (last === "paid") {
          // Refresh the participant only. Refetching the pool here flips it
          // to settled and unmounts this component mid-payout-moment; the
          // pool page's polling interval reconciles the phase shortly after.
          await queryClient.invalidateQueries({ queryKey: ["participant"] });
        }
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // Exhausted polls without a terminal status. Keep whatever the ledger
    // already shows - spends that happened must not vanish from the screen.
    setStatus({
      kind: "error",
      message:
        "Verification is taking longer than expected. SPOTTER did not reach a verdict in time - run the check again.",
      ledger: lastLedger,
    });
  };

  if (status.kind === "starting") {
    return (
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Handing it to SPOTTER</h3>
        <p className="text-sm text-muted">
          SPOTTER is pulling your wearable summary inside the confidential
          enclave. Only the verdict comes back out.
        </p>
      </div>
    );
  }

  if (status.kind === "agent") {
    const failureMode =
      status.runStatus === "no-pay" ? failureModeOf(status.ledger) : null;
    const paid = status.ledger.find(
      (e) => e.kind === "settle" && e.status === "settled",
    );

    return (
      <div className="space-y-4">
        {status.runStatus === "paid" &&
        paid !== undefined &&
        paid.kind === "settle" &&
        paid.paidUsd !== undefined ? (
          <PayoutMoment
            paidUsd={toUsd2(paid.paidUsd)}
            txHash={paid.txHash ?? null}
          />
        ) : null}

        <AgentReceipt ledger={status.ledger} />

        {status.runStatus === "verifying" ? (
          <p className="text-sm text-muted">
            SPOTTER is working. Rows print as they happen.
          </p>
        ) : null}

        {status.runStatus === "recorded" ? (
          <p className="text-sm text-muted">
            Verified and recorded on-chain. SPOTTER settles the payout the
            moment the pool period ends - no human involved.
          </p>
        ) : null}

        {failureMode === "evidence" ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
              <p className="text-base font-semibold text-warning">
                SPOTTER could not get a clean read
              </p>
              <p className="mt-1 text-sm text-foreground/80">
                It spent real money trying. The data is the problem, not you -
                make sure your wearable is connected and has synced the period,
                then run it back.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setStatus({ kind: "idle" })}
              className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3 text-sm font-semibold text-accent hover:bg-accent-deep"
            >
              Check again
            </button>
          </div>
        ) : null}

        {failureMode === "goal-missed" ? (
          <div className="rounded-xl border border-edge bg-surface-raised p-4">
            <p className="text-base font-semibold">Not paid.</p>
            <p className="mt-1 text-sm text-foreground/80">
              The wearable data was read fine. It does not show the goal being
              met.
            </p>
          </div>
        ) : null}

        {status.runStatus === "cap-exceeded" ? (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
            <p className="text-base font-semibold text-warning">
              SPOTTER hit its spending cap and stopped
            </p>
            <p className="mt-1 text-sm text-foreground/80">
              Every claim runs under a hard per-claim budget. This one reached
              it before a verdict landed, so no more money moves.
            </p>
          </div>
        ) : null}

        {status.runStatus === "blocked" ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
              <p className="text-base font-semibold text-warning">
                Join the pool first
              </p>
              <p className="mt-1 text-sm text-foreground/80">
                This wallet is not a participant in the pool on-chain, so
                nothing can be recorded for it. Join the pool, then run the
                check again.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setStatus({ kind: "idle" })}
              className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3 text-sm font-semibold text-accent hover:bg-accent-deep"
            >
              Try again
            </button>
          </div>
        ) : null}

        {status.runStatus === "error" ? (
          <ErrorNote
            title="The run hit an error"
            detail="The receipt above shows exactly where it stopped. Nothing was paid that the ledger does not show."
            onRetry={() => setStatus({ kind: "idle" })}
          />
        ) : null}
      </div>
    );
  }

  const connection = connectionQuery.data;

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">Verify from your wearable</h3>
      <p className="text-sm text-muted">
        {readableGoal === ""
          ? "SPOTTER reads your synced wearable summary and pays if the data shows the goal."
          : `SPOTTER reads your synced wearable summary and pays if the data shows "${readableGoal}".`}{" "}
        The check runs in a confidential enclave - your raw health data never
        touches the chain or SPOTTER itself, only the verdict does.
      </p>

      {!authenticated || address === null ? (
        <button
          type="button"
          disabled={!ready}
          onClick={login}
          className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          Sign in to run the check
        </button>
      ) : connectionQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <p className="text-xs text-muted">Checking for a connected wearable</p>
        </div>
      ) : connection === undefined || connection.kind !== "connected" ? (
        <div className="space-y-3">
          <p className="rounded-xl border border-dashed border-accent/30 bg-accent-deep/20 p-3 text-sm text-accent">
            {connection?.kind === "unavailable"
              ? `${connection.reason} You can still connect a provider and retry.`
              : "No wearable connected yet. Link WHOOP, Oura, Fitbit, or Garmin - without one, SPOTTER has nothing to verify and will not pay."}
          </p>
          <button
            type="button"
            onClick={() => {
              setConnectError(null);
              void openConnectFlow(address).catch((err: unknown) => {
                setConnectError(
                  err instanceof Error
                    ? err.message
                    : "Could not open the connect flow.",
                );
              });
            }}
            className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent"
          >
            Connect a wearable
          </button>
          <button
            type="button"
            onClick={() => {
              void connectionQuery.refetch();
            }}
            className="w-full rounded-xl border border-edge px-5 py-3 text-sm font-semibold text-foreground hover:border-accent/50"
          >
            I connected it, check again
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            void run();
          }}
          className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          Have SPOTTER check my wearable
        </button>
      )}

      {connectError !== null ? (
        <ErrorNote
          title="Could not start the connect flow"
          detail={connectError}
          onRetry={() => setConnectError(null)}
        />
      ) : null}

      {status.kind === "error" ? (
        <div className="space-y-3">
          {status.ledger !== undefined && status.ledger.length > 0 ? (
            <AgentReceipt ledger={status.ledger} />
          ) : null}
          <ErrorNote
            title="Could not run the check"
            detail={status.message}
            onRetry={() => setStatus({ kind: "idle" })}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function WearableCheck({
  poolId,
  goalSpec,
}: {
  poolId: bigint;
  goalSpec: string;
}) {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable wearable checks with an embedded wallet."
      />
    );
  }
  return <WearableCheckInner poolId={poolId} goalSpec={goalSpec} />;
}
