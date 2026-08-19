import type { Metadata } from "next";
import Link from "next/link";
import Countdown from "@/components/Countdown";
import ChallengeAccept from "@/components/ChallengeAccept";
import { Badge, Money, Stat, TAP_TARGET } from "@/components/ui";
import { displayGoalSpec, fetchPool, formatUsdc } from "@/lib/contract";
import { poolCanPay, poolPhase } from "@/lib/pool-lifecycle";
import { getChallengeByToken } from "@/lib/server/challenges";
import { getProfileByAddress } from "@/lib/server/social-profile";
import { displayNameFor } from "@/lib/social";

// The token is a bearer capability and the row is looked up live per request,
// so the page is always dynamic and never cached at the edge.
export const dynamic = "force-dynamic";

// Reading the request-time clock is legitimate in a dynamic server component,
// but it must not sit inline in the component body (React's purity rule treats
// Date.now as impure in render). This module-scope helper keeps the impure read
// out of the render path while still evaluating per request.
function nowUnixSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

// This is a private, person-aimed link. It must never be indexed, and its
// title/description must never leak the goal (which is health-adjacent) into a
// search result or a link-preview card. The goal is visible ON the page only,
// behind the unguessable token. Title stays deliberately neutral.
export const metadata: Metadata = {
  title: "You've been challenged - GoHealthMe",
  robots: { index: false, follow: false },
};

/** A friendly dead-end for a bad or expired-from-existence link, with no leak
 *  of whether any given token exists beyond "this one does not resolve". */
function InvalidLink() {
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <h1 className="text-2xl font-bold tracking-tight">
        This challenge link is not valid
      </h1>
      <p className="mt-3 text-sm text-muted">
        It may have been mistyped, or the challenge may no longer exist. Ask
        whoever sent it for a fresh link.
      </p>
      <Link
        href="/pools"
        className={`mt-6 rounded-xl bg-accent-strong font-semibold text-background hover:bg-accent ${TAP_TARGET}`}
      >
        Browse open pools instead
      </Link>
    </div>
  );
}

export default async function ChallengeLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const challenge = await getChallengeByToken(token);
  if (challenge === null) return <InvalidLink />;

  let poolIdBig: bigint;
  try {
    poolIdBig = BigInt(challenge.poolId);
  } catch {
    return <InvalidLink />;
  }

  // The goal and the reward are read LIVE from the chain, never from the
  // challenges row. If the pool cannot be read, treat the link as unresolvable
  // rather than rendering a challenge with no goal or reward.
  let goalTitle: string;
  let rewardUsd: string;
  let phase: ReturnType<typeof poolPhase>;
  let canPay: boolean;
  let periodStart: bigint;
  let periodEnd: bigint;
  try {
    const pool = await fetchPool(poolIdBig);
    goalTitle = displayGoalSpec(pool.goalSpec);
    rewardUsd = formatUsdc(pool.balance);
    canPay = poolCanPay(pool);
    periodStart = pool.periodStart;
    periodEnd = pool.periodEnd;
    phase = poolPhase(pool, nowUnixSeconds());
  } catch {
    return <InvalidLink />;
  }

  // Resolve the challenger to a handle when they have claimed one; otherwise
  // show the truncated address. This is public identity, never a health label.
  const challengerProfile = await getProfileByAddress(challenge.challengerAddress);
  const challengerName = displayNameFor(
    challenge.challengerAddress,
    challengerProfile?.handle ?? null,
  );

  const accept =
    phase === "live" && canPay ? (
      <ChallengeAccept poolId={challenge.poolId} />
    ) : phase === "live" && !canPay ? (
      <div className="rounded-2xl border border-warning/40 bg-warning/10 p-5">
        <p className="text-base font-semibold text-warning">
          This challenge cannot pay out
        </p>
        <p className="mt-1 text-sm text-foreground/80">
          The pool behind it was set up so a verified result still settles to
          zero, so there is nothing to accept here.
        </p>
      </div>
    ) : phase === "expired" ? (
      <div className="rounded-2xl border border-edge bg-surface p-5">
        <p className="text-base font-semibold">This challenge has closed</p>
        <p className="mt-1 text-sm text-muted">
          The window for it ended. If you were already in, your proof can still
          settle from the pool page.
        </p>
        <Link
          href={`/pools/${challenge.poolId}`}
          className={`mt-4 rounded-xl border border-edge font-medium text-muted hover:text-foreground ${TAP_TARGET}`}
        >
          Go to the pool
        </Link>
      </div>
    ) : (
      <div className="rounded-2xl border border-edge bg-surface p-5">
        <p className="text-base font-semibold">This challenge is settled</p>
        <p className="mt-1 text-sm text-muted">
          The reward has been paid out. Nothing more happens here.
        </p>
        <Link
          href={`/pools/${challenge.poolId}`}
          className={`mt-4 rounded-xl border border-edge font-medium text-muted hover:text-foreground ${TAP_TARGET}`}
        >
          See the pool
        </Link>
      </div>
    );

  return (
    <div className="mx-auto max-w-xl space-y-6 py-6">
      <div className="text-center">
        <Badge tone="accent">You&apos;ve been challenged</Badge>
        <h1 className="mt-4 text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
          {challengerName} put up{" "}
          <span className="text-accent">{rewardUsd} USDC</span> on you.
        </h1>
        {challenge.targetHandle !== null ? (
          <p className="mt-2 text-sm text-muted">For {challenge.targetHandle}</p>
        ) : null}
      </div>

      {challenge.message !== null ? (
        <blockquote className="rounded-2xl border border-accent/30 bg-accent-deep/20 p-5 text-center text-base italic text-foreground/90">
          &ldquo;{challenge.message}&rdquo;
        </blockquote>
      ) : null}

      <div className="rounded-2xl border border-edge bg-surface p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          The dare
        </p>
        <p className="mt-1 text-lg font-semibold leading-snug">{goalTitle}</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Stat label="Reward" value={<Money usd={rewardUsd} />} />
          <Stat
            label="Time to do it"
            value={
              <Countdown periodStart={periodStart} periodEnd={periodEnd} />
            }
          />
        </div>
        <p className="mt-4 text-sm text-muted">
          You pay nothing to accept. Hit the goal and the reward lands in your
          wallet the second it is verified - in a confidential enclave, so
          nobody ever sees your health data. Only you can claim it: one wallet,
          one entry.
        </p>
      </div>

      {accept}
    </div>
  );
}
