"use client";

// Wearable verification for wearable-goal pools: connect a provider through
// Junction Link, then hand the claim to SPOTTER with one tap. The run POSTs
// /api/agent/run/[goalId] with evidenceKind "wearable" and no attesterId -
// SPOTTER pulls the health summary server-side, so nothing raw ever passes
// through the browser or the chain. Mirrors the document flow's polling and
// receipt so both evidence paths end in the same terminal states.
//
// Three things it now does that the document flow always did:
//   1. Restore on mount - a returning user's ledger comes back from
//      GET /api/agent/run/[goalId] and renders as the state it encodes. This
//      is the DEFAULT tab for wearable pools, so without it a user with a
//      claim in flight opened the page to an empty box. The read is owner-only
//      (goal ids are public; the ledger's prose is not), so every request
//      carries one wallet signature reused across the session, and a claim
//      that cannot be shown is reported as withheld rather than as absent.
//   2. Say when the payout lands - the recorded state carries the settle
//      moment and a countdown, and schedules the single automatic re-poll that
//      makes the payout appear without anyone touching anything.
//   3. Refuse to loop on a dead provider - when Junction is refusing us, the
//      connect flow can only ever 502, so the CTA is replaced by the reason
//      and a one-tap move to the document proof path.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { displayGoalSpec, fetchGoalId, fetchPool } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import {
  deferredPeriodEndMs,
  failureModeOf,
  runStatusFromLedger,
  settleRepollDelayMs,
  toUsd2,
  type LedgerEntry,
  type RunStatus,
} from "@/lib/agent-receipt";
import {
  fetchProviderState,
  providerAuthReason,
  providerConnected,
  providerDownReason,
  providerQueryKey,
} from "@/lib/wearable-provider";
import { fetchWithWalletAuth } from "@/lib/client-auth";
import { useWalletAuth } from "@/lib/useWalletAuth";
import {
  claimScreenOf,
  claimVisibilityOf,
  emptyClaimScreen,
  nextClaimScreen,
  receiptToKeep,
  type ClaimScreen,
} from "@/lib/claim-restore";
import AgentReceipt from "@/components/AgentReceipt";
import Countdown from "@/components/Countdown";
import PayoutMoment from "@/components/PayoutMoment";
import { ErrorNote, Skeleton, TAP_TARGET } from "@/components/ui";
import SignInGate from "@/components/SignInGate";

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
  /** Present only for a caller who proved control of this claim's wallet. */
  ledger?: LedgerEntry[];
  /** Whether a claim exists at all, regardless of who is asking. */
  hasLedger?: boolean;
  error?: string;
}

type CheckStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "agent";
      runStatus: RunStatus;
      ledger: LedgerEntry[];
      /** Set when the server withheld the receipt rows for this request. */
      lockedReason: string | null;
    }
  /** A claim exists but cannot be shown without a signature from its wallet. */
  | { kind: "locked"; reason: string }
  // ledger carries whatever SPOTTER recorded before the failure - money that
  // moved must stay on screen even when the run dies.
  | { kind: "error"; message: string; ledger?: LedgerEntry[] };

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

/** Human-readable local time for the settlement moment. */
function formatLocalTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function WearableCheckInner({
  poolId,
  goalSpec,
  onSwitchToDocument,
}: {
  poolId: bigint;
  goalSpec: string;
  onSwitchToDocument?: () => void;
}) {
  const { ready, authenticated, address } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CheckStatus>({ kind: "idle" });
  const [connectError, setConnectError] = useState<string | null>(null);
  // Which wallet address the ledger restore last completed for. Until it
  // matches the connected address the UI shows a loading state rather than an
  // idle box (a lie for anyone whose claim already ran) or the previous
  // wallet's claim state (worse: a wrong money screen).
  const [restoredFor, setRestoredFor] = useState<string | null>(null);

  // Claim identity shared across the run, the mount restore, and the deferred
  // settle re-poll. Refs, not state: they identify the in-flight attempt for
  // background work and never drive a render by themselves.
  const goalIdRef = useRef<string | null>(null);
  const repollDoneRef = useRef(false);
  // What the receipt currently shows. A poll loop starts from this rather than
  // from nothing, so a failure on its FIRST request (a resumed claim, or the
  // deferred-settle re-poll firing before the chain is ready) still renders
  // the rows the user already has.
  const screenRef = useRef<ClaimScreen>(emptyClaimScreen());
  // Poll-loop generation counter. Each new loop bumps it; a running loop stops
  // silently the moment it is superseded (fresh run, wallet switch, unmount)
  // so a stale loop can never overwrite a newer claim's screen. It also serves
  // as the re-entry guard a queued second tap would otherwise defeat.
  const runSeqRef = useRef(0);

  const readableGoal = displayGoalSpec(goalSpec);

  // The provider read is shared with the dashboard and the pool list through
  // one query key: same endpoint, same parsed shape, one request per address.
  const providerQuery = useQuery({
    queryKey: providerQueryKey(address),
    queryFn: () => {
      if (address === null) throw new Error("No wallet connected.");
      return fetchProviderState(address, requestAuth);
    },
    enabled: address !== null,
    retry: false,
  });

  // Stop any in-flight poll loop on unmount.
  useEffect(() => {
    const seqRef = runSeqRef;
    return () => {
      seqRef.current++;
    };
  }, []);

  /**
   * Drive SPOTTER's run loop. Every poll resumes it where it stopped and, for
   * the wallet that owns the claim, returns the full ledger (one cached
   * signature covers the session, so this never prompts per tick); the receipt
   * renders it verbatim. No attester id:
   * SPOTTER fetches the wearable summary itself, server-side, and derives the
   * claim's ref from the pool period on the chain.
   */
  const pollRun = useCallback(
    async (goalId: string) => {
      if (address === null) return;
      const seq = ++runSeqRef.current;
      let last: RunStatus = "verifying";
      // Seeded from the screen, never from nothing: a failure on the first
      // request of a resumed run (or of the deferred settle re-poll) must not
      // blank a receipt that already lists money SPOTTER spent.
      let screen = screenRef.current;
      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        let body: RunResponse;
        try {
          const sent = await fetchWithWalletAuth(
            `/api/agent/run/${goalId}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                poolId: poolId.toString(),
                address,
                goalSpec,
                evidenceKind: "wearable",
              }),
            },
            requestAuth,
          );
          body = (await sent.response.json().catch(() => ({}))) as RunResponse;
          if (!sent.response.ok) {
            throw new Error(
              body.error ?? `SPOTTER responded ${sent.response.status}.`,
            );
          }
          screen = nextClaimScreen(screen, body, sent.auth);
          screenRef.current = screen;
        } catch (err) {
          if (runSeqRef.current !== seq) return;
          setStatus({
            kind: "error",
            message:
              err instanceof Error ? err.message : "The agent run failed.",
            ledger: receiptToKeep(screen),
          });
          return;
        }

        if (runSeqRef.current !== seq) return;

        if (body.status === undefined) {
          setStatus({
            kind: "error",
            message: "SPOTTER returned an unexpected response.",
            ledger: receiptToKeep(screen),
          });
          return;
        }

        last = body.status;
        setStatus({
          kind: "agent",
          runStatus: last,
          ledger: screen.ledger,
          lockedReason: screen.lockedReason,
        });

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

      if (runSeqRef.current !== seq) return;
      // Exhausted polls without a terminal status. Keep whatever the ledger
      // already shows - spends that happened must not vanish from the screen.
      setStatus({
        kind: "error",
        message:
          "Verification is taking longer than expected. Nothing is lost - your claim is saved, and this page picks it up where it left off.",
        ledger: receiptToKeep(screen),
      });
    },
    [address, poolId, goalSpec, queryClient, requestAuth],
  );

  // Restore on mount and on wallet change: once the wallet resolves, derive
  // the goal id the same way a run does and fetch any existing ledger, so a
  // returning user sees their receipt and its terminal state instead of the
  // connect box. Keyed to the address so switching wallets restores the new
  // wallet's claim rather than keeping the previous one on screen.
  useEffect(() => {
    if (!ready || address === null || restoredFor === address) return;
    // Supersede any poll loop still running for a previous wallet before this
    // wallet's state loads; pollRun below starts a fresh generation.
    runSeqRef.current++;
    let cancelled = false;
    void (async () => {
      try {
        const goalId = await fetchGoalId(poolId, address);
        const sent = await fetchWithWalletAuth(
          `/api/agent/run/${goalId}?poolId=${poolId.toString()}`,
          undefined,
          requestAuth,
        );
        if (!sent.response.ok) {
          throw new Error(`ledger read responded ${sent.response.status}`);
        }
        const body = (await sent.response.json().catch(() => ({}))) as RunResponse;
        if (cancelled) return;
        const visibility = claimVisibilityOf(body, sent.auth);
        goalIdRef.current = goalId;
        repollDoneRef.current = false;
        setRestoredFor(address);
        if (visibility.kind === "locked") {
          // A claim exists and is being withheld. The connect box here would
          // read as "nothing has happened", which is the opposite of true.
          screenRef.current = emptyClaimScreen();
          setStatus({ kind: "locked", reason: visibility.reason });
          return;
        }
        if (visibility.kind === "none") {
          screenRef.current = emptyClaimScreen();
          setStatus({ kind: "idle" });
          return;
        }
        const ledger = visibility.ledger;
        // The poll loop and every error screen read from here, so the rows
        // survive a failure on the resumed run's very first request.
        screenRef.current = claimScreenOf(ledger);
        const runStatus = runStatusFromLedger(ledger) ?? "verifying";
        setStatus({ kind: "agent", runStatus, ledger, lockedReason: null });
        if (runStatus === "verifying") void pollRun(goalId);
      } catch (err) {
        // Restore is a read-only convenience; a failed read must not block a
        // fresh run. Logged so it is never silent.
        console.error("[claim] could not restore the existing ledger:", err);
        if (!cancelled) {
          setRestoredFor(address);
          setStatus({ kind: "idle" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, address, poolId, restoredFor, pollRun, requestAuth]);

  /** Sign again and re-run the restore. If the prompt is refused a second time
   *  the restore lands back on the withheld state with the reason, so there is
   *  one path and it always tells the truth. */
  const unlockClaim = () => {
    void (async () => {
      await requestAuth({ refresh: true });
      setRestoredFor(null);
    })();
  };

  // Deferred settlement: the settle entry may carry its own periodEndIso;
  // otherwise read periodEnd from the pool itself. The query key matches
  // PoolDetail's, so this is usually served from cache.
  const poolQuery = useQuery({
    queryKey: ["pool", poolId.toString()],
    queryFn: () => fetchPool(poolId),
    enabled: status.kind === "agent" && status.runStatus === "recorded",
  });
  const periodEndMs =
    status.kind === "agent" && status.runStatus === "recorded"
      ? deferredPeriodEndMs(
          status.ledger,
          poolQuery.data !== undefined ? Number(poolQuery.data.periodEnd) : null,
        )
      : null;

  // Schedule exactly one automatic re-poll shortly after the period ends, so
  // the payout appears without any human action. The run route settles in-line
  // on that poll; repollDoneRef keeps this to a single shot even if the chain
  // is not quite ready when it fires. Gated on the restore being current for
  // the connected address: during a wallet switch the cleanup disarms the
  // previous wallet's timer and nothing re-arms until the new wallet loads.
  useEffect(() => {
    if (!ready || address === null || restoredFor !== address) return;
    if (status.kind !== "agent" || status.runStatus !== "recorded") return;
    if (repollDoneRef.current || periodEndMs === null) return;
    const goalId = goalIdRef.current;
    if (goalId === null) return;
    const timer = setTimeout(() => {
      repollDoneRef.current = true;
      void pollRun(goalId);
    }, settleRepollDelayMs(periodEndMs, Date.now()));
    return () => clearTimeout(timer);
  }, [ready, address, restoredFor, status, periodEndMs, pollRun]);

  const run = async () => {
    if (address === null) return;
    // The claim's ledger is keyed by the on-chain goal id. The restore already
    // read it from the contract; only fall back to a fresh read if it did not.
    setStatus({ kind: "starting" });
    let goalId = goalIdRef.current;
    if (goalId === null) {
      try {
        goalId = await fetchGoalId(poolId, address);
        goalIdRef.current = goalId;
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
    }
    repollDoneRef.current = false;
    await pollRun(goalId);
  };

  // Loading gate, derived rather than stored: while the wallet SDK is still
  // booting, or a connected wallet's ledger has not been restored yet, any
  // other render would either flash the connect box over an existing claim or
  // show a previous wallet's money screen. Signed-out visitors have no ledger
  // to restore and fall through to the sign-in prompt.
  if (!ready || (address !== null && restoredFor !== address)) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  if (status.kind === "starting") {
    return (
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Handing it to SPOTTER</h3>
        <p className="text-sm text-muted">
          SPOTTER is reading your synced wearable summary on its server and
          checking it against the goal. Your raw health data stays server-side
          and never goes on-chain - only the pass or fail verdict does.
        </p>
      </div>
    );
  }

  // A run that failed with rows already on screen. The receipt stays and the
  // connect box does not appear above it: this claim already bought its
  // verification, and inviting another run would spend the cap again. The
  // retry re-reads the claim rather than starting a new one.
  if (
    status.kind === "error" &&
    status.ledger !== undefined &&
    status.ledger.length > 0
  ) {
    return (
      <div className="space-y-4">
        <AgentReceipt ledger={status.ledger} evidenceKind="wearable" />
        <ErrorNote
          title="Lost contact with SPOTTER"
          detail={`${status.message} The receipt above is what already happened and nothing in it is lost.`}
          onRetry={() => setRestoredFor(null)}
        />
      </div>
    );
  }

  // A claim exists for this wallet and the server would not hand it over. The
  // connect box here would read as "nothing has happened" over a claim SPOTTER
  // already spent money on.
  if (status.kind === "locked") {
    return (
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">This claim is private</h3>
        <div className="rounded-xl border border-accent/40 bg-accent-deep/20 p-4">
          <p className="text-sm text-foreground/80">{status.reason}</p>
        </div>
        {!authenticated || address === null ? (
          <SignInGate note="Sign in to see this claim.">
            {(openSignIn) => (
              <button
                type="button"
                disabled={!ready}
                onClick={openSignIn}
                className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                Sign in to see this claim
              </button>
            )}
          </SignInGate>
        ) : (
          <button
            type="button"
            onClick={unlockClaim}
            className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent"
          >
            Sign and show my claim
          </button>
        )}
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

        <AgentReceipt ledger={status.ledger} evidenceKind="wearable" />

        {/* The run keeps going without a signature; only the rows are held
         *  back. Saying so beats a receipt that silently stops printing. */}
        {status.lockedReason !== null ? (
          <div className="rounded-xl border border-accent/40 bg-accent-deep/20 p-4">
            <p className="text-base font-semibold">
              The receipt is hidden, not stopped
            </p>
            <p className="mt-1 text-sm text-foreground/80">
              {status.lockedReason} SPOTTER keeps working either way.
            </p>
            <button
              type="button"
              onClick={unlockClaim}
              className="mt-3 w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3 text-sm font-semibold text-accent hover:bg-accent-deep"
            >
              Sign and show the rows
            </button>
          </div>
        ) : null}

        {status.runStatus === "verifying" ? (
          <p className="text-sm text-muted">
            SPOTTER is working. Rows print as they happen.
          </p>
        ) : null}

        {status.runStatus === "recorded" ? (
          <div className="rounded-xl border border-edge bg-surface-raised p-4">
            <p className="text-base font-semibold">
              Verified and recorded on-chain.
            </p>
            {periodEndMs !== null ? (
              <p className="mt-1 text-sm text-foreground/80">
                SPOTTER settles the payout when the pool period ends at{" "}
                {formatLocalTime(periodEndMs)} (
                <Countdown
                  periodStart={0n}
                  periodEnd={BigInt(Math.floor(periodEndMs / 1000))}
                />
                ). Leave this page open and the payout appears here on its own -
                no human involved.
              </p>
            ) : (
              <p className="mt-1 text-sm text-foreground/80">
                SPOTTER settles the payout the moment the pool period ends - no
                human involved. Come back after the period closes and the payout
                appears here.
              </p>
            )}
          </div>
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
            {onSwitchToDocument !== undefined ? (
              <button
                type="button"
                onClick={onSwitchToDocument}
                className="w-full rounded-xl border border-edge px-5 py-3 text-sm font-semibold text-foreground hover:border-accent/50"
              >
                Upload proof instead
              </button>
            ) : null}
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

  const providerState = providerQuery.data;
  const providerDown = providerDownReason(providerState);
  const providerAuth = providerAuthReason(providerState);
  const connected = providerConnected(providerState);

  /** Sign, then re-read the provider. Used when the wearable read came back
   *  401: the device may well be connected, we just cannot look yet. */
  const unlockProvider = () => {
    void (async () => {
      await requestAuth({ refresh: true });
      await providerQuery.refetch();
    })();
  };

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">Verify from your wearable</h3>
      <p className="text-sm text-muted">
        {readableGoal === ""
          ? "SPOTTER reads your synced wearable summary and pays if the data shows the goal."
          : `SPOTTER reads your synced wearable summary and pays if the data shows "${readableGoal}".`}
      </p>

      {/* Privacy line, scoped honestly to the wearable path. The document path
       *  runs inside the confidential enclave (lib/server/judge.ts); the
       *  wearable path does NOT - SPOTTER reads the Junction summary on its
       *  own server (lib/server/junction.ts + lib/server/agent/wearable.ts)
       *  and derives the verdict there. Raw samples never leave that server
       *  boundary and nothing but the pass/fail verdict and its confidence is
       *  written on-chain, but claiming a sealed enclave here would be a lie:
       *  the wearable summary transits the server. Say what is true. */}
      <p className="rounded-xl border border-edge bg-surface-raised p-3 text-xs text-muted">
        Where your wearable data goes: SPOTTER reads your synced summary on its
        server to check the goal. That is the wearable path - not the sealed
        enclave the document path runs in. Your raw health data stays
        server-side, is never written on-chain, and is never shared. Only the
        verdict - pass or fail, with its confidence - is recorded on-chain.
      </p>

      {!authenticated || address === null ? (
        <SignInGate note="Sign in to run the check.">
          {(openSignIn) => (
            <button
              type="button"
              disabled={!ready}
              onClick={openSignIn}
              className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              Sign in to run the check
            </button>
          )}
        </SignInGate>
      ) : providerQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <p className="text-xs text-muted">Checking for a connected wearable</p>
        </div>
      ) : providerDown !== null ? (
        // Dead end removed: while the provider refuses us, connecting a device
        // cannot help and the connect call itself 502s. Say what is wrong and
        // hand over the proof path that still works.
        <div className="space-y-3">
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
            <p className="text-base font-semibold text-warning">
              Wearable verification is down right now
            </p>
            <p className="mt-1 text-sm text-foreground/80">{providerDown}</p>
            <p className="mt-2 text-sm text-foreground/80">
              This is on us, not on your device. Connecting one would not change
              it, so SPOTTER is not going to send you round that loop.
            </p>
          </div>
          {onSwitchToDocument !== undefined ? (
            <button
              type="button"
              onClick={onSwitchToDocument}
              className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent"
            >
              Prove it with a document instead
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void providerQuery.refetch();
            }}
            className="w-full rounded-xl border border-edge px-5 py-3 text-sm font-semibold text-foreground hover:border-accent/50"
          >
            Check the provider again
          </button>
        </div>
      ) : providerAuth !== null ? (
        // Not an outage and not a missing device: the read is this wallet's
        // own health data and it has not been unlocked. Saying "no wearable
        // connected" here would send someone to re-link a device that is
        // already linked.
        <div className="space-y-3">
          <p className="rounded-xl border border-accent/40 bg-accent-deep/20 p-3 text-sm text-foreground/80">
            {providerAuth}
          </p>
          <button
            type="button"
            onClick={unlockProvider}
            className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent"
          >
            Sign and check my wearable
          </button>
        </div>
      ) : !connected ? (
        <div className="space-y-3">
          <p className="rounded-xl border border-dashed border-accent/30 bg-accent-deep/20 p-3 text-sm text-accent">
            No wearable connected yet. Link WHOOP, Oura, Fitbit, or Garmin -
            without one, SPOTTER has nothing to verify and will not pay.
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
              void providerQuery.refetch();
            }}
            className="w-full rounded-xl border border-edge px-5 py-3 text-sm font-semibold text-foreground hover:border-accent/50"
          >
            I connected it, check again
          </button>
          {onSwitchToDocument !== undefined ? (
            <button
              type="button"
              onClick={onSwitchToDocument}
              className={`w-full rounded-xl text-muted hover:text-foreground ${TAP_TARGET}`}
            >
              Or upload a document instead
            </button>
          ) : null}
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
            <AgentReceipt ledger={status.ledger} evidenceKind="wearable" />
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
  onSwitchToDocument,
}: {
  poolId: bigint;
  goalSpec: string;
  /** Switches the pool page to the document proof path. Absent when the pool
   *  has no document tab to switch to. */
  onSwitchToDocument?: () => void;
}) {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable wearable checks with an embedded wallet."
      />
    );
  }
  return (
    <WearableCheckInner
      poolId={poolId}
      goalSpec={goalSpec}
      onSwitchToDocument={onSwitchToDocument}
    />
  );
}
