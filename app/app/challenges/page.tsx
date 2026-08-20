"use client";

// "My challenges" - the two-sided home for the peer-challenge layer.
//
// A challenge IS a pool (initiative === "challenge"): the challenger creates
// and funds it, the target accepts the /c/[token] link by calling joinPool.
// Before this page there was nowhere in the app to see that challenge again -
// who dared you, what the dare was, whether it has paid - once the invite link
// was gone. Both sides live here now.
//
// RELIABLE READS ONLY. Everything on this page is discovered the way the
// dashboard discovers joined pools: fetchPools() enumerates poolCount (the
// fixed, non-getLogs path) and getParticipant / getParticipants are plain
// eth_call view reads. There is deliberately NO getLogs / event scan here -
// Arc's public RPCs cannot serve those from the browser.
//
// WHO CHALLENGED YOU is derived, never stored: the challenger is the pool's
// on-chain creator (pool.creator), resolved to an @handle by the same
// display-name resolver the rest of the app uses, falling back to a truncated
// address. The dare is the on-chain goalSpec (rendered through displayGoalSpec,
// which strips the [doc] marker). Nothing health-adjacent is read from any
// off-chain source.
//
// INVITED TO YOU is the one section that starts off-chain. A challenger can aim
// a dare at your @handle at creation; that (handle -> invite token) row is the
// only place the aim is recorded. /api/challenges/invited returns those invites
// ONLY to the signature-verified owner of the handle, so the token - a
// capability that unlocks the goal - never reaches anyone else. Everything shown
// on the card is then read the same reliable way as the rest of the page:
// fetchPool (an eth_call) for the goal, reward and window, fetchParticipant to
// drop any dare you have already accepted. Still no getLogs.
//
// PRIVACY. The dare is health-adjacent, but this is the participant's and the
// creator's OWN challenges page - they are entitled to see their own goal text.
// The public redaction rule (feed / profile / pool metadata) is untouched.

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Countdown from "@/components/Countdown";
import SignInPanel from "@/components/SignInPanel";
import { DYNAMIC_CONFIGURED } from "@/lib/config";
import {
  Badge,
  EmptyState,
  ErrorNote,
  Money,
  Skeleton,
  TAP_TARGET,
} from "@/components/ui";
import {
  displayGoalSpec,
  fetchParticipant,
  fetchParticipants,
  fetchPool,
  fetchPools,
  formatUsdc,
  type ParticipantInfo,
  type PoolInfo,
} from "@/lib/contract";
import { challengeShareUrl } from "@/lib/challenges";
import { fetchWithWalletAuth, type WalletAuthRequester } from "@/lib/client-auth";
import { useEmbeddedWallet } from "@/lib/wallet";
import { useWalletAuth } from "@/lib/useWalletAuth";
import { useDisplayNames } from "@/lib/use-display-names";

/** The on-chain initiative string every challenge pool carries. Mirrors
 *  CHALLENGE_INITIATIVE in CreateChallenge.tsx, which writes it at createPool. */
const CHALLENGE_INITIATIVE = "challenge";

interface InChallenge {
  pool: PoolInfo;
  participant: ParticipantInfo;
}

interface SentChallenge {
  pool: PoolInfo;
  /** Accepters, or null when the count read missed (the card still renders). */
  participantCount: number | null;
}

interface MyChallenges {
  inChallenges: InChallenge[];
  sentChallenges: SentChallenge[];
}

/** The invite row the signed route returns, before the on-chain pool read. */
interface RawInvite {
  poolId: string;
  inviteToken: string;
  challengerAddress: string;
  message: string | null;
}

/** A dare aimed at you that you have NOT yet accepted, resolved against chain. */
interface InvitedChallenge {
  pool: PoolInfo;
  inviteToken: string;
  challengerAddress: string;
  message: string | null;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Both sides of the peer-challenge layer for one wallet, read entirely from
 * the chain. fetchPools() is the poolCount-enumeration path the dashboard uses;
 * getParticipant and getParticipants are view calls. No getLogs anywhere.
 */
async function fetchMyChallenges(
  address: `0x${string}`,
): Promise<MyChallenges> {
  const pools = await fetchPools();
  const challengePools = pools.filter(
    (pool) => pool.initiative === CHALLENGE_INITIATIVE,
  );

  // One getParticipant eth_call per challenge pool - the exact reliable read
  // DashboardContent.fetchJoinedPools uses, scoped here to challenge pools.
  const participants = await Promise.all(
    challengePools.map((pool) => fetchParticipant(pool.id, address)),
  );

  // Aimed at you: a challenge you joined that somebody else created. Excluding
  // your own pools keeps "@creator challenged you" honest and keeps a pool from
  // showing in both sections at once.
  const inChallenges: InChallenge[] = challengePools
    .map((pool, i) => ({ pool, participant: participants[i] }))
    .filter(
      (entry) =>
        entry.participant.joined && !sameAddress(entry.pool.creator, address),
    );

  // Sent by you: any challenge pool you created.
  const sentPools = challengePools.filter((pool) =>
    sameAddress(pool.creator, address),
  );

  // Accepter count per sent challenge (getParticipants view call - reliable, no
  // logs). A read miss leaves the count null rather than dropping the card.
  const counts = await Promise.all(
    sentPools.map((pool) =>
      fetchParticipants(pool.id)
        .then((list) => list.length)
        .catch(() => null),
    ),
  );
  const sentChallenges: SentChallenge[] = sentPools.map((pool, i) => ({
    pool,
    participantCount: counts[i],
  }));

  return { inChallenges, sentChallenges };
}

/**
 * The dares aimed at your handle that you have not yet accepted.
 *
 * The invite list itself is signature-gated (only the handle's owner may read
 * its tokens), so this asks /api/challenges/invited with the wallet proof
 * attached. Everything after that is the page's usual reliable read: one
 * fetchPool per invite for the goal / reward / window, one fetchParticipant to
 * drop anything already joined (that belongs in "Challenges you're in"). No
 * getLogs. Best-effort by design: an unsigned or failed response yields an empty
 * list so the additive section simply stays hidden rather than erroring the page.
 */
async function fetchInvitedChallenges(
  address: `0x${string}`,
  requestAuth: WalletAuthRequester,
): Promise<InvitedChallenge[]> {
  const { response, auth } = await fetchWithWalletAuth(
    "/api/challenges/invited",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    },
    requestAuth,
  );
  // The tokens are private to the handle owner: without an attached signature
  // there is nothing to show, and a non-ok response is not worth erroring over.
  if (auth.kind !== "ok" || !response.ok) return [];

  const body = (await response.json().catch(() => ({}))) as {
    invites?: RawInvite[];
  };
  const raw = body.invites ?? [];

  const resolved = await Promise.all(
    raw.map(async (invite): Promise<InvitedChallenge | null> => {
      let poolId: bigint;
      try {
        poolId = BigInt(invite.poolId);
      } catch {
        return null;
      }
      try {
        const pool = await fetchPool(poolId);
        const participant = await fetchParticipant(poolId, address);
        // Already accepted -> it lives in "Challenges you're in", not here.
        if (participant.joined) return null;
        return {
          pool,
          inviteToken: invite.inviteToken,
          challengerAddress: invite.challengerAddress,
          message: invite.message,
        };
      } catch {
        // An unreadable pool is dropped rather than shown as a broken card.
        return null;
      }
    }),
  );

  return resolved.filter((entry): entry is InvitedChallenge => entry !== null);
}

/** The participant's standing on a challenge they are in, read from the chain
 *  alone: recorded + verdict + settled is all it takes to say where the money
 *  is. Labels match the page's stated set (Not started / awaiting settle / Paid)
 *  plus the honest "Goal missed" the contract can also report. */
function challengeStatus(
  pool: PoolInfo,
  p: ParticipantInfo,
): { label: string; tone: "accent" | "muted" | "warning" } {
  if (p.resultRecorded && p.verdict) {
    return pool.settled
      ? { label: "Paid", tone: "accent" }
      : { label: "Verified - awaiting settle", tone: "accent" };
  }
  if (p.resultRecorded && !p.verdict) {
    return { label: "Goal missed", tone: "muted" };
  }
  return { label: "Not started", tone: "warning" };
}

function InvitedChallengeCard({
  entry,
  challengerName,
  acceptUrl,
}: {
  entry: InvitedChallenge;
  challengerName: string;
  acceptUrl: string;
}) {
  const { pool, message } = entry;

  return (
    <div className="rounded-2xl border border-accent/40 bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge>Challenge</Badge>
        <Badge tone="accent">Invited</Badge>
      </div>
      <p className="mt-3 text-sm text-muted">
        <span className="font-semibold text-foreground">{challengerName}</span>{" "}
        invited you
      </p>
      <h3 className="mt-1 text-lg font-semibold leading-snug">
        {displayGoalSpec(pool.goalSpec)}
      </h3>
      {message !== null ? (
        <p className="mt-2 text-sm italic text-muted">{message}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted">
        <span>
          Reward <Money usd={formatUsdc(pool.balance)} size="sm" />
        </span>
        <Countdown periodStart={pool.periodStart} periodEnd={pool.periodEnd} />
      </div>
      <Link
        href={acceptUrl}
        className={`mt-4 w-full rounded-xl bg-accent-strong font-semibold text-background hover:bg-accent ${TAP_TARGET}`}
      >
        Accept the dare
      </Link>
    </div>
  );
}

function InChallengeCard({
  entry,
  challengerName,
}: {
  entry: InChallenge;
  challengerName: string;
}) {
  const { pool, participant } = entry;
  const status = challengeStatus(pool, participant);
  // Nothing recorded yet means the proof is still owed - lead with the upload.
  const needsProof = !participant.resultRecorded;
  const id = pool.id.toString();

  return (
    <div className="rounded-2xl border border-edge bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge>Challenge</Badge>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className="mt-3 text-sm text-muted">
        <span className="font-semibold text-foreground">{challengerName}</span>{" "}
        challenged you
      </p>
      <h3 className="mt-1 text-lg font-semibold leading-snug">
        {displayGoalSpec(pool.goalSpec)}
      </h3>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted">
        <span>
          Reward <Money usd={formatUsdc(pool.balance)} size="sm" />
        </span>
        <Countdown periodStart={pool.periodStart} periodEnd={pool.periodEnd} />
      </div>
      <Link
        href={`/pools/${id}`}
        className={`mt-4 w-full rounded-xl font-semibold ${TAP_TARGET} ${
          needsProof
            ? "bg-accent-strong text-background hover:bg-accent"
            : "border border-edge text-foreground hover:border-accent/50"
        }`}
      >
        {needsProof ? "Upload your proof" : "View challenge"}
      </Link>
    </div>
  );
}

function SentChallengeCard({ entry }: { entry: SentChallenge }) {
  const { pool, participantCount } = entry;
  const id = pool.id.toString();
  const countLabel =
    participantCount === null
      ? null
      : participantCount === 0
        ? "No one has accepted yet"
        : participantCount === 1
          ? "1 person accepted"
          : `${participantCount} people accepted`;

  return (
    <div className="rounded-2xl border border-edge bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge>Challenge</Badge>
        {pool.settled ? <Badge tone="muted">Settled</Badge> : null}
      </div>
      <h3 className="mt-3 text-lg font-semibold leading-snug">
        {displayGoalSpec(pool.goalSpec)}
      </h3>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted">
        <span>
          Reward <Money usd={formatUsdc(pool.balance)} size="sm" />
        </span>
        <Countdown periodStart={pool.periodStart} periodEnd={pool.periodEnd} />
        {countLabel !== null ? <span>{countLabel}</span> : null}
      </div>
      <Link
        href={`/pools/${id}`}
        className={`mt-4 w-full rounded-xl border border-edge font-semibold text-foreground hover:border-accent/50 ${TAP_TARGET}`}
      >
        View challenge
      </Link>
    </div>
  );
}

function DareAFriend() {
  return (
    <Link
      href="/challenge/new"
      className="inline-block rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
    >
      Dare a friend
    </Link>
  );
}

function MyChallengesContent() {
  const { ready, authenticated, address } = useEmbeddedWallet();
  const requestAuth = useWalletAuth();

  const query = useQuery({
    queryKey: ["my-challenges", address],
    queryFn: () => {
      if (address === null) throw new Error("No wallet address.");
      return fetchMyChallenges(address);
    },
    enabled: address !== null,
  });

  // The dares aimed at your handle. Signature-gated, so it is cached on the
  // address: the embedded wallet signs once and the credential is reused rather
  // than re-signing every render.
  const invitedQuery = useQuery({
    queryKey: ["invited-challenges", address],
    queryFn: () => {
      if (address === null) throw new Error("No wallet address.");
      return fetchInvitedChallenges(address, requestAuth);
    },
    enabled: address !== null,
  });

  // Resolve challengers to @handles for the "in" and "invited" cards. A stable,
  // deduped array keeps the resolver's query key from churning on every render;
  // useDisplayNames normalizes and dedupes the two sources internally.
  const nameAddresses = useMemo(
    () => [
      ...(query.data?.inChallenges ?? []).map((entry) => entry.pool.creator),
      ...(invitedQuery.data ?? []).map((entry) => entry.challengerAddress),
    ],
    [query.data, invitedQuery.data],
  );
  const { displayName } = useDisplayNames(nameAddresses);

  const origin =
    typeof window === "undefined" ? "" : window.location.origin;

  if (!ready) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (!authenticated || address === null) {
    // Email-first panel, the same signed-out path the dashboard uses: we make
    // the wallet, an external wallet is the deliberate second choice inside it.
    return (
      <div className="mx-auto max-w-md space-y-4">
        <div className="text-center">
          <p className="text-lg font-semibold">Sign in to see your challenges</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            The dares aimed at you and the ones you have sent live here once you
            sign in.
          </p>
        </div>
        <SignInPanel />
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorNote
        title="Could not load your challenges"
        detail={
          query.error instanceof Error
            ? query.error.message
            : "Unknown error reading from Arc testnet."
        }
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const data = query.data ?? { inChallenges: [], sentChallenges: [] };
  const invited = invitedQuery.data ?? [];
  const nothing =
    data.inChallenges.length === 0 &&
    data.sentChallenges.length === 0 &&
    invited.length === 0;

  // A freshly-invited user has no sent or joined challenges, so hold the empty
  // state until the (signature-gated) invited read settles - otherwise the page
  // flashes "No challenges yet" and then pops an invite in above it.
  if (nothing && invitedQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
      </div>
    );
  }

  if (nothing) {
    return (
      <EmptyState
        title="No challenges yet"
        detail="Dare a friend to hit a goal and put real USDC behind it. When someone dares you back, it shows up here too."
        action={<DareAFriend />}
      />
    );
  }

  return (
    <div className="space-y-8">
      {invited.length > 0 ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Invited to you</h2>
            <p className="mt-1 text-sm text-muted">
              Dares aimed straight at your handle. Accept one and go for the
              goal - you pay nothing, and the reward pays the second it is
              verified.
            </p>
          </div>
          {invited.map((entry) => (
            <InvitedChallengeCard
              key={entry.inviteToken}
              entry={entry}
              challengerName={displayName(entry.challengerAddress)}
              acceptUrl={challengeShareUrl(origin, entry.inviteToken)}
            />
          ))}
        </section>
      ) : null}

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Challenges you&apos;re in</h2>
          <p className="mt-1 text-sm text-muted">
            Dares a friend aimed at you and you accepted. Upload your proof and
            the reward pays the second it is verified.
          </p>
        </div>
        {data.inChallenges.length === 0 ? (
          <EmptyState
            title="No challenges aimed at you yet"
            detail="When a friend dares you and you open their link to accept, the challenge shows up here."
          />
        ) : (
          data.inChallenges.map((entry) => (
            <InChallengeCard
              key={entry.pool.id.toString()}
              entry={entry}
              challengerName={displayName(entry.pool.creator)}
            />
          ))
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Challenges you sent</h2>
          <p className="mt-1 text-sm text-muted">
            Dares you funded and aimed at someone else. You put up the reward;
            they get paid the moment they prove it.
          </p>
        </div>
        {data.sentChallenges.length === 0 ? (
          <EmptyState
            title="You have not sent any challenges yet"
            detail="Dare a friend to hit a goal and back it with USDC. They pay nothing to accept."
            action={<DareAFriend />}
          />
        ) : (
          data.sentChallenges.map((entry) => (
            <SentChallengeCard key={entry.pool.id.toString()} entry={entry} />
          ))
        )}
      </section>
    </div>
  );
}

export default function ChallengesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          My challenges
        </h1>
        <p className="mt-1 text-sm text-muted">
          Dares aimed at you, and the ones you have put your USDC behind.
        </p>
      </div>
      {DYNAMIC_CONFIGURED ? (
        <MyChallengesContent />
      ) : (
        <EmptyState
          title="Sign-in is not configured"
          detail="Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable embedded wallets and peer challenges."
          action={
            <Link
              href="/pools"
              className="inline-block rounded-xl bg-accent-strong px-6 py-3 text-sm font-semibold text-background hover:bg-accent"
            >
              Browse pools instead
            </Link>
          }
        />
      )}
    </div>
  );
}
