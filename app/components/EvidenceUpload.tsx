"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { ErrorNote } from "@/components/ui";

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
// 75 tries * 800ms = one minute before a stuck run surfaces as an error.
const POLL_INTERVAL_MS = 800;
const MAX_POLLS = 75;

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
  ledger?: LedgerEntry[];
  error?: string;
}

type UploadStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "agent"; runStatus: RunStatus; ledger: LedgerEntry[] }
  | { kind: "error"; message: string };

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

function EvidenceUploadInner({
  poolId,
  goalSpec,
}: {
  poolId: bigint;
  goalSpec: string;
}) {
  const { ready, authenticated, address, login } = useEmbeddedWallet();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [status, setStatus] = useState<UploadStatus>({ kind: "idle" });
  const [formError, setFormError] = useState<string | null>(null);

  const readableGoal = displayGoalSpec(goalSpec);

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
          "Document verification is not live yet. The /api/evidence/submit route is still being deployed.",
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

    // Step 3 — drive SPOTTER's run loop. Every poll resumes it where it
    // stopped and returns the full ledger; the receipt renders it verbatim.
    let last: RunStatus = "verifying";
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      let body: RunResponse;
      try {
        const res = await fetch(`/api/agent/run/${goalId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attesterId,
            poolId: poolId.toString(),
            address,
            goalSpec,
          }),
        });
        body = (await res.json().catch(() => ({}))) as RunResponse;
        if (!res.ok) {
          throw new Error(body.error ?? `SPOTTER responded ${res.status}.`);
        }
      } catch (err) {
        setStatus({
          kind: "error",
          message:
            err instanceof Error ? err.message : "The agent run failed.",
        });
        return;
      }

      if (body.status === undefined || body.ledger === undefined) {
        setStatus({
          kind: "error",
          message: "SPOTTER returned an unexpected response.",
        });
        return;
      }

      last = body.status;
      setStatus({ kind: "agent", runStatus: last, ledger: body.ledger });

      if (TERMINAL.includes(last)) {
        if (last === "paid" || last === "recorded") {
          await queryClient.invalidateQueries({ queryKey: ["pool"] });
          await queryClient.invalidateQueries({ queryKey: ["participant"] });
        }
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // Exhausted polls without a terminal status.
    setStatus({
      kind: "error",
      message:
        "Verification is taking longer than expected. The secure enclave did not return a verdict in time — please try again.",
    });
  };

  const resetUpload = () => {
    setSelected(null);
    setStatus({ kind: "idle" });
    setFormError(null);
    if (inputRef.current !== null) inputRef.current.value = "";
  };

  const busy = status.kind === "submitting" || status.kind === "agent";

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
            moment the pool period ends — no human involved.
          </p>
        ) : null}

        {failureMode === "evidence" ? (
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

        {failureMode === "goal-missed" ? (
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
