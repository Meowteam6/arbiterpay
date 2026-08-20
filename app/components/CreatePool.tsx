"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import {
  getHealthPoolsAddress,
  parseUsdc,
  withDocMarker,
  type EvidenceType,
} from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useUsdcDeposit } from "@/lib/useUsdcDeposit";
import { isEconomicallyDeadConfig } from "@/lib/pool-lifecycle";
import { resolveNewPoolId } from "@/lib/resolve-pool-id";
import { ArcTxLink, ErrorNote } from "@/components/ui";
import SignInGate from "@/components/SignInGate";

const DURATION_OPTIONS: { label: string; days: number }[] = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
];

const SECONDS_PER_DAY = 86_400;

interface DocTemplate {
  key: string;
  label: string;
  initiative: string;
  goal: string;
  entryFee: string;
  funding: string;
}

/**
 * One-tap preventive-care templates for document-verified goals, modeled on
 * the UnitedHealthcare rewards catalog (flu shot, biometric screening, lipid
 * panel). Selecting one prefills the form; the goal text is encoded as a
 * document goal at submit time via withDocMarker.
 */
const DOC_TEMPLATES: DocTemplate[] = [
  {
    key: "flu-shot",
    label: "Get your flu shot",
    initiative: "flu-shot",
    goal: "Get your annual flu shot and upload your vaccination record showing the date.",
    entryFee: "0.00",
    funding: "10.00",
  },
  {
    key: "biometric",
    label: "Biometric screening",
    initiative: "biometric",
    goal: "Complete a biometric screening and upload the result document (blood pressure, BMI, glucose).",
    entryFee: "0.00",
    funding: "50.00",
  },
  {
    key: "cholesterol",
    label: "Cholesterol panel under 200",
    initiative: "cholesterol",
    goal: "Upload a lab report showing total cholesterol under 200 mg/dL.",
    entryFee: "0.00",
    funding: "25.00",
  },
];

function CreatePoolInner() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { ready, authenticated } = useEmbeddedWallet();
  const { status, busy, reset, runUsdcDeposit } = useUsdcDeposit();

  const [evidenceType, setEvidenceType] = useState<EvidenceType>("wearable");
  const [initiative, setInitiative] = useState<string>("");
  const [goalSpec, setGoalSpec] = useState<string>("");
  const [entryFee, setEntryFee] = useState<string>("");
  const [durationDays, setDurationDays] = useState<number>(7);
  const [bountyModel, setBountyModel] = useState<number>(0);
  const [initialFunding, setInitialFunding] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState<boolean>(false);

  const poolsAddress = getHealthPoolsAddress();
  if (poolsAddress === null) {
    return (
      <ErrorNote
        title="Contract not configured"
        detail="Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS to enable pool creation."
      />
    );
  }

  const applyTemplate = (template: DocTemplate) => {
    setEvidenceType("document");
    setInitiative(template.initiative);
    setGoalSpec(template.goal);
    setEntryFee(template.entryFee);
    // Every doc template has a zero entry fee, and a fixed bounty is a
    // multiple of the entry fee -- model 0 at fee 0 creates a pool that
    // settles to zero for everyone. Templates therefore always split the pot.
    setBountyModel(1);
    setInitialFunding(template.funding);
    setFormError(null);
  };

  // Fixed bounty pays entryFee * multiplier, so at a zero fee it pays nothing:
  // the transaction succeeds and AchieverPaid never fires. Guard both in the
  // UI (radio disabled below) and at submit time (derived model), so no pool
  // that structurally cannot pay can be created from this form.
  const feeIsZero = (() => {
    try {
      return parseUsdc(entryFee.trim() === "" ? "0" : entryFee.trim()) === 0n;
    } catch {
      return false;
    }
  })();

  const submit = async () => {
    setFormError(null);
    let entryFeeUsdc: bigint;
    let fundingUsdc: bigint;

    try {
      if (initiative.trim() === "") {
        throw new Error("Enter an initiative name, for example \"sleep\".");
      }
      if (goalSpec.trim() === "") {
        throw new Error("Describe the goal participants must hit.");
      }
      entryFeeUsdc = parseUsdc(entryFee.trim() === "" ? "0" : entryFee.trim());
      if (entryFeeUsdc < 0n) {
        throw new Error("Entry fee cannot be negative.");
      }
      fundingUsdc = parseUsdc(
        initialFunding.trim() === "" ? "0" : initialFunding.trim(),
      );
      if (fundingUsdc <= 0n) {
        throw new Error("Seed the bounty with an initial funding above zero.");
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Check the form values.",
      );
      return;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const periodStart = now;
    const periodEnd = now + BigInt(durationDays * SECONDS_PER_DAY);

    const encodedGoalSpec =
      evidenceType === "document"
        ? withDocMarker(goalSpec.trim())
        : goalSpec.trim();

    // A fixed bounty pays entryFee * multiplier, so at a zero fee it settles to
    // zero for everyone: force the split-pot model when the fee is zero, then
    // hard-block on the shared F-1 predicate as a backstop. The UI already
    // disables the model-0 radio at a zero fee, but the assertion is what makes
    // it airtight if that derivation ever regresses.
    const bountyModelToUse = entryFeeUsdc === 0n ? 1 : bountyModel;
    if (isEconomicallyDeadConfig(bountyModelToUse, entryFeeUsdc)) {
      setFormError(
        "A fixed-bounty pool needs an entry fee above zero, or switch to split the pot. This config would pay every achiever zero.",
      );
      return;
    }

    try {
      const depositHash = await runUsdcDeposit(fundingUsdc, {
        functionName: "createPool",
        args: [
          initiative.trim(),
          encodedGoalSpec,
          entryFeeUsdc,
          periodStart,
          periodEnd,
          bountyModelToUse,
          fundingUsdc,
        ],
      });

      setRedirecting(true);
      await queryClient.invalidateQueries({ queryKey: ["pools"] });
      const newId = await resolveNewPoolId(depositHash);
      router.push(`/pools/${newId.toString()}`);
    } catch {
      // useUsdcDeposit already captured the error into status; surface there.
      setRedirecting(false);
    }
  };

  const primaryLabel =
    status.kind === "approving"
      ? "Approving USDC..."
      : status.kind === "depositing"
        ? "Creating pool..."
        : redirecting
          ? "Opening your pool..."
          : authenticated
            ? "Approve funding and create pool"
            : "Sign in to create";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Create a bounty pool
        </h1>
        <p className="mt-1 text-sm text-muted">
          Fund a USDC bounty on Arc testnet. Participants join, hit your goal,
          and get paid the moment their result is verified.
        </p>
      </div>

      <div className="space-y-4 rounded-2xl border border-edge bg-surface p-5">
        <fieldset className="block text-sm font-medium">
          <legend>How is the goal verified</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setEvidenceType("wearable")}
              className={`rounded-xl border p-3 text-left ${
                evidenceType === "wearable"
                  ? "border-accent/50 bg-accent-deep text-accent"
                  : "border-edge bg-surface-raised text-muted hover:text-foreground"
              }`}
            >
              <span className="block font-semibold">Wearable data</span>
              <span className="block text-xs font-normal">
                Verified from connected device metrics like sleep or steps.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setEvidenceType("document")}
              className={`rounded-xl border p-3 text-left ${
                evidenceType === "document"
                  ? "border-accent/50 bg-accent-deep text-accent"
                  : "border-edge bg-surface-raised text-muted hover:text-foreground"
              }`}
            >
              <span className="block font-semibold">Document upload</span>
              <span className="block text-xs font-normal">
                Verified from an uploaded record like a flu shot or lab result.
              </span>
            </button>
          </div>
        </fieldset>

        {evidenceType === "document" ? (
          <div className="block text-sm font-medium">
            Preventive-care templates
            <div className="mt-2 flex flex-wrap gap-2">
              {DOC_TEMPLATES.map((template) => (
                <button
                  key={template.key}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className="rounded-xl border border-accent/40 bg-accent-deep/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent-deep/30"
                >
                  {template.label}
                </button>
              ))}
            </div>
            <span className="mt-1 block text-xs font-normal text-muted">
              One tap prefills the goal, entry fee, and a suggested bounty. You
              can edit anything before creating.
            </span>
          </div>
        ) : null}

        <label className="block text-sm font-medium">
          Initiative
          <input
            type="text"
            placeholder="sleep"
            value={initiative}
            onChange={(e) => setInitiative(e.target.value)}
            className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
          />
          <span className="mt-1 block text-xs text-muted">
            Short tag shown on the pool, for example sleep, workouts, steps.
          </span>
        </label>

        <label className="block text-sm font-medium">
          Goal
          <textarea
            placeholder={
              evidenceType === "document"
                ? "Get your annual flu shot and upload your vaccination record."
                : "Sleep at least 7 hours every night for the period."
            }
            value={goalSpec}
            onChange={(e) => setGoalSpec(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
          />
          <span className="mt-1 block text-xs text-muted">
            {evidenceType === "document"
              ? "Describe what participants must upload. Saved as a document goal so the right verifier and badge are used."
              : "The human-readable goal participants commit to."}
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Entry fee (USDC)
            <input
              type="text"
              inputMode="decimal"
              placeholder="5.00"
              value={entryFee}
              onChange={(e) => setEntryFee(e.target.value)}
              className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
            />
            <span className="mt-1 block text-xs text-muted">
              What each participant pays to join. Use 0 for a free pool.
            </span>
          </label>

          <label className="block text-sm font-medium">
            Initial funding (USDC)
            <input
              type="text"
              inputMode="decimal"
              placeholder="100.00"
              value={initialFunding}
              onChange={(e) => setInitialFunding(e.target.value)}
              className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
            />
            <span className="mt-1 block text-xs text-muted">
              USDC you seed the bounty with now. Pulled from your wallet.
            </span>
          </label>
        </div>

        <div className="block text-sm font-medium">
          Duration
          <div className="mt-2 flex flex-wrap gap-2">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                onClick={() => setDurationDays(opt.days)}
                className={`rounded-xl border px-4 py-2 text-sm font-medium ${
                  durationDays === opt.days
                    ? "border-accent/50 bg-accent-deep text-accent"
                    : "border-edge bg-surface-raised text-muted hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="mt-1 block text-xs text-muted">
            Starts now, ends after the selected duration.
          </span>
        </div>

        <fieldset className="block text-sm font-medium">
          <legend>Payout model</legend>
          <div className="mt-2 space-y-2">
            <label
              className={`flex items-start gap-3 rounded-xl border border-edge bg-surface-raised p-3 ${
                feeIsZero ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              }`}
            >
              <input
                type="radio"
                name="bountyModel"
                checked={bountyModel === 0 && !feeIsZero}
                disabled={feeIsZero}
                onChange={() => setBountyModel(0)}
                className="mt-1"
              />
              <span>
                <span className="block font-semibold">
                  Fixed bounty per achiever
                </span>
                <span className="block text-xs font-normal text-muted">
                  Each verified achiever receives the same fixed payout, a
                  multiple of the entry fee.
                </span>
                {feeIsZero ? (
                  <span className="mt-1 block text-xs font-normal text-warning">
                    Enter an entry fee above 0 to use a fixed bounty. At a zero
                    fee it would pay every achiever nothing, so the pool splits
                    the pot instead.
                  </span>
                ) : null}
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-edge bg-surface-raised p-3">
              <input
                type="radio"
                name="bountyModel"
                checked={bountyModel === 1 || feeIsZero}
                onChange={() => setBountyModel(1)}
                className="mt-1"
              />
              <span>
                <span className="block font-semibold">Split the pot pro-rata</span>
                <span className="block text-xs font-normal text-muted">
                  The whole pot is shared across achievers in proportion to
                  their results.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <SignInGate note="Sign in to create this pool.">
          {(openSignIn) => (
            <button
              type="button"
              disabled={!ready || busy || redirecting}
              onClick={() => {
                if (!authenticated) {
                  openSignIn();
                  return;
                }
                void submit();
              }}
              className="w-full rounded-xl bg-accent-strong px-5 py-3.5 text-base font-semibold text-background hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              {primaryLabel}
            </button>
          )}
        </SignInGate>

        {status.kind === "approving" || status.kind === "depositing" ? (
          <div className="rounded-xl border border-edge bg-surface-raised p-4 text-sm">
            <p className="font-medium">
              Step {status.kind === "approving" ? "1" : "2"} of 2:{" "}
              {status.kind === "approving"
                ? "approving USDC for the pool"
                : "creating the pool on Arc"}
            </p>
          </div>
        ) : null}

        {status.kind === "done" ? (
          <div className="space-y-1 rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
            <p className="text-sm font-semibold text-accent">
              Pool created on Arc.
            </p>
            {status.approveHash ? (
              <>
                <ArcTxLink
                  txHash={status.approveHash}
                  label="View approval tx"
                />
                <br />
              </>
            ) : null}
            <ArcTxLink
              txHash={status.depositHash}
              label="View createPool tx"
            />
          </div>
        ) : null}

        {formError !== null ? (
          <ErrorNote
            title="Check the form"
            detail={formError}
            onRetry={() => setFormError(null)}
          />
        ) : null}

        {status.kind === "error" ? (
          <ErrorNote
            title="Could not create the pool"
            detail={status.message}
            onRetry={reset}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function CreatePool() {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable pool creation with an embedded wallet."
      />
    );
  }
  return <CreatePoolInner />;
}
