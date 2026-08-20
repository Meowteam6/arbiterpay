"use client";

// Hero screen 1: create a peer challenge.
//
// "I bet you can't lose 5 lbs this month" -> "send me a challenge then" ->
// this form. Sending the challenge CREATES the pool: it is the same createPool
// the sponsor flow ships, funded by the challenger, with entryFee 0 and the
// split-pot model (bountyModel 1), routed through the SAME useUsdcDeposit
// funnel so the F-1 dead-pool guard and the Blink swap point both still apply.
//
// COMPLIANCE LANE (do not deviate): the challenger FUNDS the pot; the target
// WINS by hitting their OWN goal; the challenger never profits from the target
// failing. This is the DietBet / parent-pays-kid / commitment lane, not a
// peer-wager, so the on-chain backing mechanic is deliberately untouched here.
//
// PRIVACY: the goal ("lose 10 lbs") is health-adjacent. It lives on-chain in
// the pool goalSpec and is visible only on the token-gated landing - you cannot
// accept a dare without knowing it. It is NEVER copied into the challenges row
// and NEVER reaches the public feed. The row stores only the challenger's
// framing message and an optional target label.

import { useState } from "react";
import Link from "next/link";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import { parseUsdc, withDocMarker } from "@/lib/contract";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useDisplayNames } from "@/lib/use-display-names";
import { useUsdcDeposit } from "@/lib/useUsdcDeposit";
import ShareChallenge from "@/components/ShareChallenge";
import SignInGate from "@/components/SignInGate";
import { resolveNewPoolId } from "@/lib/resolve-pool-id";
import { useWalletAuth } from "@/lib/useWalletAuth";
import { authBlockReason, fetchWithWalletAuth } from "@/lib/client-auth";
import {
  challengeShareUrl,
  checkMessage,
  checkTargetHandle,
  MESSAGE_MAX,
  TARGET_HANDLE_MAX,
} from "@/lib/challenges";
import { ArcTxLink, ErrorNote, Money } from "@/components/ui";

const DURATION_OPTIONS: { label: string; days: number }[] = [
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
  { label: "30 days", days: 30 },
];

const SECONDS_PER_DAY = 86_400;

// A challenge is always a challenger-funded, split-pot pool the target joins for
// free. These are fixed, not form fields: entryFee 0 keeps the target paying
// nothing, and the split-pot model is the only one that pays at a zero fee
// (fixed bounty at fee 0 is the F-1 dead pool).
const CHALLENGE_ENTRY_FEE = 0n;
const CHALLENGE_BOUNTY_MODEL = 1;
const CHALLENGE_INITIATIVE = "challenge";

type LinkPhase =
  | { kind: "idle" }
  | { kind: "linking" }
  | { kind: "done"; url: string; poolId: string }
  | { kind: "error"; message: string };

/** Tap-to-copy for the finished challenge link. A share link is not a wallet
 *  address, so it wears its own control rather than borrowing CopyAddressButton's
 *  address-specific labels. Mirrors CopyAddressButton's failure handling: some
 *  mobile in-app browsers and non-secure contexts expose no clipboard API, so a
 *  silent no-op would strand the challenger with an unshareable link. On failure
 *  it says so and points at the full link, which is shown here to select by hand. */
function CopyLink({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setState("failed");
      return;
    }
    clipboard.writeText(url).then(
      () => {
        setState("copied");
        setTimeout(() => setState("idle"), 2500);
      },
      () => setState("failed"),
    );
  };
  return (
    <>
      <button
        type="button"
        onClick={copy}
        title="Tap to copy the challenge link"
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-edge bg-surface-raised px-3 py-3 text-left font-mono text-xs text-foreground/80 hover:border-accent/50 hover:text-foreground"
      >
        <span className="break-all">{url}</span>
        <span
          aria-live="polite"
          className="shrink-0 font-sans text-xs font-semibold uppercase tracking-wide text-accent"
        >
          {state === "copied"
            ? "Copied"
            : state === "failed"
              ? "Copy failed"
              : "Tap to copy"}
        </span>
      </button>
      {state === "failed" ? (
        <p aria-live="polite" className="text-xs text-muted">
          Copying is blocked in this browser - select the link above by hand.
        </p>
      ) : null}
    </>
  );
}

function CreateChallengeInner() {
  const { ready, authenticated, address } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();
  const { status, busy, reset, runUsdcDeposit } = useUsdcDeposit();
  // The challenger's own name, for the "from @you" line on the done screen.
  const { displayName } = useDisplayNames(address !== null ? [address] : []);

  const [goal, setGoal] = useState("");
  const [reward, setReward] = useState("");
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState("");
  const [durationDays, setDurationDays] = useState(30);
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhase] = useState<LinkPhase>({ kind: "idle" });

  const submit = async () => {
    setFormError(null);
    setPhase({ kind: "idle" });

    let rewardUsdc: bigint;
    try {
      if (goal.trim() === "") {
        throw new Error("Say what they have to do, for example \"lose 10 lbs\".");
      }
      rewardUsdc = parseUsdc(reward.trim() === "" ? "0" : reward.trim());
      if (rewardUsdc <= 0n) {
        throw new Error("Put up a reward above zero. This is the money on the line.");
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Check the form values.");
      return;
    }

    const messageCheck = checkMessage(message);
    if (!messageCheck.ok) {
      setFormError(messageCheck.reason);
      return;
    }
    const targetCheck = checkTargetHandle(target);
    if (!targetCheck.ok) {
      setFormError(targetCheck.reason);
      return;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const periodStart = now;
    const periodEnd = now + BigInt(durationDays * SECONDS_PER_DAY);
    // Challenges are proven by an uploaded record, so the goal is a document
    // goal. The marker routes the right verifier + badge; no contract change.
    const encodedGoalSpec = withDocMarker(goal.trim());

    try {
      const depositHash = await runUsdcDeposit(rewardUsdc, {
        functionName: "createPool",
        args: [
          CHALLENGE_INITIATIVE,
          encodedGoalSpec,
          CHALLENGE_ENTRY_FEE,
          periodStart,
          periodEnd,
          CHALLENGE_BOUNTY_MODEL,
          rewardUsdc,
        ],
      });

      // The pool is funded on-chain. Now mint the shareable, person-aimed link.
      setPhase({ kind: "linking" });
      const poolId = await resolveNewPoolId(depositHash);

      if (address === null) {
        setPhase({
          kind: "error",
          message: "Your wallet disconnected before the link could be signed.",
        });
        return;
      }

      const sent = await fetchWithWalletAuth(
        "/api/challenges",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address,
            poolId: poolId.toString(),
            targetHandle: targetCheck.targetHandle,
            message: messageCheck.message,
          }),
        },
        requestAuth,
      );

      if (!sent.response.ok) {
        if (sent.auth.kind !== "ok") {
          setPhase({
            kind: "error",
            message:
              authBlockReason(sent.auth) ??
              "Sign with your wallet to send this challenge.",
          });
          return;
        }
        const body = (await sent.response.json().catch(() => ({}))) as {
          error?: string;
        };
        // The pool is already funded and live; the link write is what failed.
        // Point the challenger at their pool so the money is never stranded.
        setPhase({
          kind: "error",
          message:
            (body.error ?? "Could not create the challenge link.") +
            ` Your pool is live at /pools/${poolId.toString()} - you can still share that.`,
        });
        return;
      }

      const body = (await sent.response.json()) as {
        challenge?: { inviteToken?: string };
        sharePath?: string;
      };
      const token = body.challenge?.inviteToken;
      if (typeof token !== "string" || token === "") {
        setPhase({
          kind: "error",
          message: "The challenge was created but its link came back empty.",
        });
        return;
      }
      const origin =
        typeof window === "undefined" ? "" : window.location.origin;
      setPhase({
        kind: "done",
        url: challengeShareUrl(origin, token),
        poolId: poolId.toString(),
      });
    } catch {
      // useUsdcDeposit already captured any deposit error into status; surface
      // there. A post-deposit throw lands as a generic link error.
      if (status.kind !== "error") {
        setPhase({
          kind: "error",
          message: "Could not finish creating the challenge. Try again.",
        });
      }
    }
  };

  if (phase.kind === "done") {
    return (
      <div className="space-y-5">
        <div className="space-y-2 rounded-2xl border border-accent/40 bg-accent-deep/40 p-5">
          <p className="text-base font-semibold text-accent">
            Challenge sent. The money is on the line.
          </p>
          {address !== null ? (
            <p className="text-xs font-medium text-foreground/70">
              From {displayName(address)}
            </p>
          ) : null}
          <p className="text-sm text-foreground/80">
            Send this link to the one person it is for. Whoever opens it can
            accept and go for the goal - they pay nothing, and the reward pays
            out the moment they prove they hit it.
          </p>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Send it to them
          </p>
          {/* Web Share / Text / Email, prefilled with the dare, reward and
              link. CopyLink stays below as the desktop fallback. */}
          <ShareChallenge
            url={phase.url}
            title="You've been challenged on GoHealthMe"
            message={`I'm daring you: ${goal.trim()}. Hit it and I pay you ${reward.trim()} USDC.`}
            emailSubject="I'm daring you - GoHealthMe"
            includeCopy={false}
            shareLabel="Share the dare"
          />
          <CopyLink url={phase.url} />
          <p className="text-xs text-muted">
            Anyone with this link can see the dare and accept it, so send it
            straight to them. It is not listed anywhere and cannot be guessed.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href={`/pools/${phase.poolId}`}
            className="rounded-xl border border-edge px-5 py-3 text-sm font-medium text-muted hover:text-foreground"
          >
            View the pool
          </Link>
          <button
            type="button"
            onClick={() => {
              reset();
              setPhase({ kind: "idle" });
              setGoal("");
              setReward("");
              setMessage("");
              setTarget("");
            }}
            className="rounded-xl border border-edge px-5 py-3 text-sm font-medium text-muted hover:text-foreground"
          >
            Send another
          </button>
        </div>
      </div>
    );
  }

  const linking = phase.kind === "linking";
  const primaryLabel =
    status.kind === "approving"
      ? "Approving USDC..."
      : status.kind === "depositing"
        ? "Putting up the reward..."
        : linking
          ? "Minting the link..."
          : authenticated
            ? "Send the challenge"
            : "Sign in to challenge";

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-accent">
          Dare a friend. Back it with real USDC.
        </p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          Challenge someone. You put up the money.
        </h1>
        <p className="mt-2 text-sm text-muted">
          You fund the reward. They hit the goal, they get paid the second it is
          verified. They flake, the money comes back to you. Nobody ever sees
          their health data - only the verdict.
        </p>
      </div>

      <div className="space-y-4 rounded-2xl border border-edge bg-surface p-5">
        <label className="block text-sm font-medium">
          The dare
          <textarea
            placeholder="lose 10 lbs this month"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
          />
          <span className="mt-1 block text-xs text-muted">
            What they have to do. Proven by an uploaded record - the reward pays
            the moment it is verified in a confidential enclave.
          </span>
        </label>

        <label className="block text-sm font-medium">
          The reward (USDC)
          <input
            type="text"
            inputMode="decimal"
            placeholder="50.00"
            value={reward}
            onChange={(e) => setReward(e.target.value)}
            className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
          />
          <span className="mt-1 block text-xs text-muted">
            Pulled from your wallet now and held in the pool. They pay nothing to
            accept. If they never hit the goal, you reclaim it.
          </span>
        </label>

        <label className="block text-sm font-medium">
          Who is it for (optional)
          <input
            type="text"
            placeholder="my brother"
            value={target}
            maxLength={TARGET_HANDLE_MAX}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
          />
          <span className="mt-1 block text-xs text-muted">
            Just a label so you remember who you sent it to. Only shown on the
            link, never made public.
          </span>
        </label>

        <label className="block text-sm font-medium">
          A message (optional)
          <textarea
            placeholder="bet you can't. proving me wrong pays."
            value={message}
            maxLength={MESSAGE_MAX}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-xl border border-edge bg-surface-raised px-3 py-3 text-base"
          />
          <span className="mt-1 block text-xs text-muted">
            Trash talk, encouragement, whatever lands. Shown on the challenge
            link only.
          </span>
        </label>

        <div className="block text-sm font-medium">
          How long they have
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
            Starts the moment you send it.
          </span>
        </div>

        <SignInGate note="Sign in to send this challenge.">
          {(openSignIn) => (
            <button
              type="button"
              disabled={!ready || busy || linking}
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
                ? "approving USDC for the reward"
                : "putting the reward into the pool on Arc"}
            </p>
          </div>
        ) : null}

        {linking ? (
          <div className="rounded-xl border border-edge bg-surface-raised p-4 text-sm">
            <p className="font-medium">
              Reward is in. Signing to mint your challenge link...
            </p>
          </div>
        ) : null}

        {status.kind === "done" ? (
          <div className="space-y-1 rounded-xl border border-accent/40 bg-accent-deep/40 p-4">
            <p className="text-sm font-semibold text-accent">
              Reward of <Money usd={reward.trim()} /> is in the pool.
            </p>
            <ArcTxLink
              txHash={status.depositHash}
              label="View the funding tx"
            />
          </div>
        ) : null}

        {formError !== null ? (
          <ErrorNote
            title="Check the challenge"
            detail={formError}
            onRetry={() => setFormError(null)}
          />
        ) : null}

        {status.kind === "error" ? (
          <ErrorNote
            title="Could not put up the reward"
            detail={status.message}
            onRetry={reset}
          />
        ) : null}

        {phase.kind === "error" ? (
          <ErrorNote
            title="The reward is up, but the link did not send"
            detail={phase.message}
            onRetry={() => setPhase({ kind: "idle" })}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function CreateChallenge() {
  if (!DYNAMIC_CONFIGURED) {
    return (
      <ErrorNote
        title="Sign-in is not configured"
        detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable challenges with an embedded wallet."
      />
    );
  }
  return <CreateChallengeInner />;
}
