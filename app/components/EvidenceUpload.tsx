"use client";

// Claim client for one (pool, participant) goal. Three jobs beyond a plain
// upload box:
//   1. Restore on mount - a returning user's ledger comes back from
//      GET /api/agent/run/[goalId] and renders as the state it encodes,
//      never as a blank "Prove it." box that hides a claim that already ran.
//      That read is owner-only now (the ledger carries model prose about the
//      uploaded document, and goal ids are public), so every request here
//      carries a wallet signature. One signature covers the whole session -
//      the run loop polls every 800ms and a prompt per poll is unusable. When
//      there is no signature the claim is reported as withheld, with the
//      reason, rather than as absent.
//   2. Resume, do not restart - the POST run loop is idempotent server-side,
//      so a mid-flight claim picks up where it stopped, and a deferred
//      settlement schedules exactly one automatic re-poll for just after the
//      pool period ends, so the payout lands with no human action.
//   3. Honest failure split - unreadable evidence invites a retry; a missed
//      goal or an unreachable verification service does not. A new upload
//      cannot fix either, and each retry buys verification with real money.
// Every branchable decision (status derivation, current-attempt selection,
// re-poll timing) lives in lib/agent-receipt.ts as tested pure functions;
// this component stays thin.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { displayGoalSpec, fetchGoalId, fetchPool } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import {
  currentAttesterIdOf,
  deferredPeriodEndMs,
  failureModeOf,
  runStatusFromLedger,
  settleRepollDelayMs,
  toUsd2,
  type LedgerEntry,
  type RunStatus,
} from "@/lib/agent-receipt";
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
import { ErrorNote, Skeleton } from "@/components/ui";

// text/plain stays accepted so old sample records keep working, but it is
// deliberately not advertised anywhere: a .txt on camera reads as fake.
const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "application/pdf",
  "text/plain",
] as const;
const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB keeps the base64 POST venue-WiFi friendly.

// Poll cadence for the agent run. Each poll resumes SPOTTER's run loop where
// it stopped, so a tight interval makes the receipt rows land as they happen.
// 375 tries * 800ms = five minutes before a stuck run surfaces as an error;
// TEE inference on large documents can legitimately take several minutes.
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

interface SubmitResponse {
  attesterId?: string;
  error?: string;
}

interface RunResponse {
  status?: RunStatus;
  /** Present only for a caller who proved control of this claim's wallet. */
  ledger?: LedgerEntry[];
  /** Whether a claim exists at all, regardless of who is asking. */
  hasLedger?: boolean;
  error?: string;
}

type UploadStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "agent";
      runStatus: RunStatus;
      ledger: LedgerEntry[];
      /** Set when the server withheld the receipt rows for this request. */
      lockedReason: string | null;
    }
  /** A claim exists but cannot be shown without a signature from its wallet. */
  | { kind: "locked"; reason: string }
  // ledger carries whatever was already on screen - a transient failure must
  // not blank a receipt listing money SPOTTER has already spent, because the
  // upload box in its place invites a second paid attempt on the same claim.
  | { kind: "error"; message: string; ledger?: LedgerEntry[] };

interface SelectedFile {
  name: string;
  contentType: string;
  base64: string;
}

/** Read a File into a bare base64 string (no data: prefix) in the browser. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected file reader output."));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pick a content type the API accepts, defaulting plain/empty types to text/plain. */
function normalizeContentType(file: File): string {
  if (
    (ACCEPTED_TYPES as readonly string[]).includes(file.type) &&
    file.type !== ""
  ) {
    return file.type;
  }
  // Browsers sometimes report .txt as "" — treat as plain text.
  if (file.name.toLowerCase().endsWith(".txt")) return "text/plain";
  return file.type;
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

function EvidenceUploadInner({
  poolId,
  goalSpec,
}: {
  poolId: bigint;
  goalSpec: string;
}) {
  const { ready, authenticated, address, login } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [status, setStatus] = useState<UploadStatus>({ kind: "idle" });
  const [formError, setFormError] = useState<string | null>(null);
  // Which wallet address the ledger restore last completed for. Until it
  // matches the connected address, the UI shows a loading state instead of
  // the idle upload box (which would be a lie for anyone whose claim already
  // ran) or another wallet's claim state (worse: a wrong money screen).
  const [restoredFor, setRestoredFor] = useState<string | null>(null);

  // Claim identity shared across the submit flow, the mount restore, and the
  // deferred-settle re-poll. Refs, not state: they identify the in-flight
  // attempt for background work and never drive a render by themselves.
  const goalIdRef = useRef<string | null>(null);
  const attesterIdRef = useRef<string | null>(null);
  const repollDoneRef = useRef(false);
  // What the receipt currently shows. A poll loop starts from this rather than
  // from nothing, so a failure on its FIRST request (a resumed claim, or the
  // deferred-settle re-poll firing before the chain is ready) still renders the
  // rows the user already has.
  const screenRef = useRef<ClaimScreen>(emptyClaimScreen());
  // Poll-loop generation counter. Each new loop bumps it; a running loop
  // stops silently the moment it is superseded (fresh submit, wallet switch,
  // unmount) so a stale loop can never overwrite a newer claim's screen.
  const runSeqRef = useRef(0);

  const readableGoal = displayGoalSpec(goalSpec);

  // Stop any in-flight poll loop on unmount.
  useEffect(() => {
    const seqRef = runSeqRef;
    return () => {
      seqRef.current++;
    };
  }, []);

  /**
   * Drive SPOTTER's run loop. Every POST resumes it where it stopped and,
   * for the wallet that owns the claim, returns the full ledger; the receipt
   * renders it verbatim. Server-side dedupe (by attester job id) makes
   * resuming safe: nothing is bought or recorded twice no matter how often
   * this runs. The signature rides along on every poll from the session cache,
   * so this prompts once, not once per 800ms tick.
   */
  const pollRun = useCallback(
    async (goalId: string, attesterId: string) => {
      if (address === null) return;
      const seq = ++runSeqRef.current;
      let last: RunStatus = "verifying";
      // Seeded from the screen, never from nothing: rows already shown survive
      // both a poll that comes back withheld and a poll that fails outright.
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
                attesterId,
                poolId: poolId.toString(),
                address,
                goalSpec,
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
          if (last === "paid" || last === "recorded") {
            await queryClient.invalidateQueries({ queryKey: ["pool"] });
            await queryClient.invalidateQueries({ queryKey: ["participant"] });
          }
          return;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      if (runSeqRef.current !== seq) return;
      // Exhausted polls without a terminal status. Honest and true: the
      // claim's ledger is durable and this page restores it on next visit.
      setStatus({
        kind: "error",
        message:
          "Verification is taking longer than usual. Nothing is lost — your " +
          "claim is saved. Come back in a few minutes and this page will " +
          "pick up where it left off.",
        ledger: receiptToKeep(screen),
      });
    },
    [address, poolId, goalSpec, queryClient, requestAuth],
  );

  // Restore on mount and on wallet change (defect M5): once the wallet
  // resolves, derive the goal id the same way submissions do and fetch any
  // existing ledger. A returning user sees the receipt and its terminal
  // state, not an empty upload box; a mid-flight run resumes polling
  // automatically. Keyed to the address so switching wallets restores the
  // new wallet's claim instead of keeping the previous one on screen.
  useEffect(() => {
    if (!ready || address === null || restoredFor === address) return;
    // Supersede any poll loop still running for a previous wallet before
    // this wallet's state loads; pollRun below starts a fresh generation.
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
          // A claim exists and is being withheld. Saying "Prove it." here
          // would invite a second upload of evidence already paid for.
          attesterIdRef.current = null;
          screenRef.current = emptyClaimScreen();
          setStatus({ kind: "locked", reason: visibility.reason });
          return;
        }
        if (visibility.kind === "none") {
          attesterIdRef.current = null;
          screenRef.current = emptyClaimScreen();
          setStatus({ kind: "idle" });
          return;
        }
        const ledger = visibility.ledger;
        attesterIdRef.current = currentAttesterIdOf(ledger);
        // The poll loop and every error screen read from here, so the rows
        // survive a failure on the resumed run's very first request.
        screenRef.current = claimScreenOf(ledger);
        const runStatus = runStatusFromLedger(ledger) ?? "verifying";
        setStatus({ kind: "agent", runStatus, ledger, lockedReason: null });
        if (runStatus === "verifying" && attesterIdRef.current !== null) {
          void pollRun(goalId, attesterIdRef.current);
        }
      } catch (err) {
        // Restore is a read-only convenience; a failed read must not block a
        // fresh submission. Logged so it is never silent.
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

  /** Sign again and re-run the restore. Used from the withheld state: if the
   *  prompt is refused a second time the restore lands back here with the
   *  reason, so there is exactly one path and it always tells the truth. */
  const unlockClaim = () => {
    void (async () => {
      await requestAuth({ refresh: true });
      setRestoredFor(null);
    })();
  };

  // Deferred settlement (defect B2): the settle entry may carry its own
  // periodEndIso; otherwise read periodEnd from the pool itself. The query
  // key matches PoolDetail's, so this is usually served from cache.
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
  // the payout appears without any human action. The run route settles
  // in-line on that poll; repollDoneRef keeps this to a single shot even if
  // the chain is not quite ready when it fires. Gated on the restore being
  // current for the connected address: during a wallet switch the cleanup
  // disarms the previous wallet's timer and nothing re-arms until the new
  // wallet's own state has loaded.
  useEffect(() => {
    if (!ready || address === null || restoredFor !== address) return;
    if (status.kind !== "agent" || status.runStatus !== "recorded") return;
    if (repollDoneRef.current || periodEndMs === null) return;
    const goalId = goalIdRef.current;
    const attesterId =
      attesterIdRef.current ?? currentAttesterIdOf(status.ledger);
    if (goalId === null || attesterId === null) return;
    const timer = setTimeout(() => {
      repollDoneRef.current = true;
      void pollRun(goalId, attesterId);
    }, settleRepollDelayMs(periodEndMs, Date.now()));
    return () => clearTimeout(timer);
  }, [ready, address, restoredFor, status, periodEndMs, pollRun]);

  const onPickFile = async (file: File | null) => {
    setFormError(null);
    setStatus({ kind: "idle" });
    if (file === null) {
      setSelected(null);
      return;
    }
    const contentType = normalizeContentType(file);
    if (!(ACCEPTED_TYPES as readonly string[]).includes(contentType)) {
      setSelected(null);
      setFormError("Upload a PNG, JPG, or PDF record.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setSelected(null);
      setFormError("File is too large. Use a file under 8 MB.");
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setSelected({ name: file.name, contentType, base64 });
    } catch (err) {
      setSelected(null);
      setFormError(
        err instanceof Error ? err.message : "Could not read the file.",
      );
    }
  };

  const submit = async () => {
    if (selected === null || address === null) return;

    // Step 1 — submit the document to the attester and get a job id. Only
    // this request ever carries the document; everything after it works on
    // the derived verdict.
    setStatus({ kind: "submitting" });
    let attesterId: string;
    try {
      const res = await fetch("/api/evidence/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poolId: poolId.toString(),
          address,
          goalSpec,
          fileBase64: selected.base64,
          fileName: selected.name,
          contentType: selected.contentType,
        }),
      });

      if (res.status === 404) {
        throw new Error(
          "Document verification is not available right now. Nothing was " +
            "submitted. Please try again in a few minutes.",
        );
      }

      const body = (await res.json().catch(() => ({}))) as SubmitResponse;
      if (!res.ok || typeof body.attesterId !== "string") {
        throw new Error(
          body.error ?? `Verification service responded ${res.status}.`,
        );
      }
      attesterId = body.attesterId;
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Could not submit the record.",
      });
      return;
    }

    // Step 2 — the claim's ledger is keyed by the on-chain goal id, so read
    // it from the contract; the run route re-derives and enforces the match.
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

    // Step 3 — drive SPOTTER's run loop for this fresh attempt. A new
    // attempt gets its own single settle re-poll if it ends up deferred.
    goalIdRef.current = goalId;
    attesterIdRef.current = attesterId;
    repollDoneRef.current = false;
    await pollRun(goalId, attesterId);
  };

  const resetUpload = () => {
    setSelected(null);
    setStatus({ kind: "idle" });
    setFormError(null);
    if (inputRef.current !== null) inputRef.current.value = "";
  };

  const busy = status.kind === "submitting" || status.kind === "agent";

  // Loading gate, derived rather than stored: while the wallet SDK is still
  // booting, or a connected wallet's ledger has not been restored yet, any
  // other render would either flash the idle box over an existing claim or
  // show a previous wallet's money screen. Signed-out visitors have no
  // ledger to restore and fall through to the upload box.
  if (!ready || (address !== null && restoredFor !== address)) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  if (status.kind === "submitting") {
    return (
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Handing it to SPOTTER</h3>
        <p className="text-sm text-muted">
          Your document is going into the confidential enclave. Only the
          verdict comes back out.
        </p>
      </div>
    );
  }

  // A run that failed with rows already on screen. The receipt stays: it is
  // the user's only record that SPOTTER bought verification for this claim,
  // and the upload box in its place would sell them a second one. The retry
  // re-reads the claim rather than offering a fresh upload, because the claim
  // is still there - it was the request that failed, not the run.
  if (
    status.kind === "error" &&
    status.ledger !== undefined &&
    status.ledger.length > 0
  ) {
    return (
      <div className="space-y-4">
        <AgentReceipt ledger={status.ledger} />
        <ErrorNote
          title="Lost contact with SPOTTER"
          detail={`${status.message} The receipt above is what already happened and nothing in it is lost.`}
          onRetry={() => setRestoredFor(null)}
        />
      </div>
    );
  }

  // A claim exists for this wallet and the server would not hand it over. The
  // upload box is the one thing this must never be: it reads as "nothing has
  // happened" and invites a second upload of evidence already paid for.
  if (status.kind === "locked") {
    return (
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">This claim is private</h3>
        <div className="rounded-xl border border-accent/40 bg-accent-deep/20 p-4">
          <p className="text-sm text-foreground/80">{status.reason}</p>
        </div>
        {!authenticated || address === null ? (
          <button
            type="button"
            disabled={!ready}
            onClick={login}
            className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            Sign in to see this claim
          </button>
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
    // The current attempt's attester id is recovered from the ledger itself
    // (the attester-read purchase always lands before any verdict, decision,
    // or error the failure split consults), keeping render free of refs.
    const attemptAttesterId = currentAttesterIdOf(status.ledger);
    // "no-pay" needs the full three-way split; "error" only needs to know
    // whether the verification service itself was the failure, so its copy
    // stops blaming the document (defect B4).
    const failureMode =
      status.runStatus === "no-pay" || status.runStatus === "error"
        ? failureModeOf(status.ledger, attemptAttesterId)
        : null;
    const attesterOffline = failureMode === "attester-offline";
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
                ). Leave this page open and the payout appears here on its
                own — no human involved.
              </p>
            ) : (
              <p className="mt-1 text-sm text-foreground/80">
                SPOTTER settles the payout the moment the pool period ends —
                no human involved. Come back after the period closes and the
                payout appears here.
              </p>
            )}
          </div>
        ) : null}

        {attesterOffline ? (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
            <p className="text-base font-semibold text-warning">
              The verification service is unreachable
            </p>
            <p className="mt-1 text-sm text-foreground/80">
              Your document is fine — this is not about your file. Nothing was
              recorded and SPOTTER did not pay out. Try again later, once the
              service is back.
            </p>
          </div>
        ) : null}

        {status.runStatus === "no-pay" && failureMode === "evidence" ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
              <p className="text-base font-semibold text-warning">
                SPOTTER could not read that
              </p>
              <p className="mt-1 text-sm text-foreground/80">
                It spent real money trying. The photo is the problem, not you —
                shoot it again in actual light and run it back.
              </p>
            </div>
            <button
              type="button"
              onClick={resetUpload}
              className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3 text-sm font-semibold text-accent hover:bg-accent-deep"
            >
              Upload a different file
            </button>
          </div>
        ) : null}

        {status.runStatus === "no-pay" && failureMode === "goal-missed" ? (
          <div className="rounded-xl border border-edge bg-surface-raised p-4">
            <p className="text-base font-semibold">Not paid.</p>
            <p className="mt-1 text-sm text-foreground/80">
              The document was read fine. It does not show the goal being met.
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
                nothing can be recorded for it. Join the pool, then submit
                again.
              </p>
            </div>
            <button
              type="button"
              onClick={resetUpload}
              className="w-full rounded-xl border border-accent/50 bg-surface-raised px-5 py-3 text-sm font-semibold text-accent hover:bg-accent-deep"
            >
              Try again
            </button>
          </div>
        ) : null}

        {status.runStatus === "error" && !attesterOffline ? (
          <ErrorNote
            title="The run hit an error"
            detail="The receipt above shows exactly where it stopped. Nothing was paid that the ledger does not show."
            onRetry={() => setStatus({ kind: "idle" })}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold">Prove it.</h3>
      <p className="text-sm text-muted">
        {readableGoal === ""
          ? "Scale photo, gym selfie, lab PDF, screenshot of your watch at 2am."
          : `Proof for "${readableGoal}": scale photo, gym selfie, lab PDF, screenshot of your watch at 2am.`}{" "}
        SPOTTER works out what it is looking at and buys what it needs. Messy
        is fine. Fake is not.
      </p>

      {/* Disclosure at the point of upload, not after it. Every clause here is
       *  backed by code: the document is sent only to the attester for
       *  inference (lib/server/judge.ts), it is never written to disk or chain
       *  and never logged, and the self-hosted attester journals ids,
       *  timestamps and the verdict only - never document bytes
       *  (services/confidential-shim/src/jobs.ts). Deliberately claims no
       *  encryption and no certification we cannot evidence. It also does not
       *  promise a bare yes/no: the verdict is {verified, confidence, reason}
       *  and AgentReceipt renders that reason to this same user moments later,
       *  so the copy must account for the note or it contradicts the next
       *  screen. The load-bearing claim is that the document itself never
       *  comes back and is never kept. */}
      <p className="rounded-xl border border-edge bg-surface-raised p-3 text-xs text-muted">
        Where this file goes: straight to the confidential enclave that runs
        the check. We do not store it. What comes back is the verdict — pass or
        fail, with a short note on why — never the document itself.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        disabled={busy}
        onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        className="hidden"
      />

      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center justify-center rounded-xl border border-dashed border-accent/40 bg-accent-deep/10 px-5 py-6 text-center text-sm font-medium text-accent hover:bg-accent-deep/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {selected !== null
          ? `Selected: ${selected.name}`
          : "Tap to choose a file (PNG, JPG, or PDF)"}
      </button>

      {selected !== null ? (
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
          className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {authenticated
            ? "Verify record and claim bounty"
            : "Sign in to submit"}
        </button>
      ) : null}

      {formError !== null ? (
        <ErrorNote
          title="Check the file"
          detail={formError}
          onRetry={() => setFormError(null)}
        />
      ) : null}

      {status.kind === "error" ? (
        <ErrorNote
          title="Could not verify the record"
          detail={status.message}
          onRetry={() => setStatus({ kind: "idle" })}
        />
      ) : null}
    </div>
  );
}

export default function EvidenceUpload({
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
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable submitting records with an embedded wallet."
      />
    );
  }
  return <EvidenceUploadInner poolId={poolId} goalSpec={goalSpec} />;
}
