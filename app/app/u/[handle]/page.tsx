import type { Metadata } from "next";
import Link from "next/link";
import {
  ProfilePaidWall,
  type Peer,
  type ProfileData,
  type Win,
} from "@/components/profile-paid-wall";
import { formatUsdc } from "@/lib/contract";
import { getProfileByHandle, resolveProfiles } from "@/lib/server/social-profile";
import { getSocialStats } from "@/lib/server/social-stats";
import { checkHandle } from "@/lib/social";

// Live on-chain stats and a Supabase lookup on every view, so never prerender.
export const dynamic = "force-dynamic";

/** Avatar glyph: the claimed one, or a plain monogram from the handle. No
 *  emoji literal lives in code - an absent glyph falls back to a letter. */
function avatarGlyph(handle: string, emoji: string | null): string {
  if (emoji !== null && emoji.trim() !== "") return emoji;
  const first = handle.trim().charAt(0).toUpperCase();
  return first === "" ? "?" : first;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const check = checkHandle(handle);
  if (!check.ok) return { title: "GoHealthMe" };
  return {
    title: `@${check.handle} on GoHealthMe`,
    description: "Verified health-goal wins and USDC payouts. No health category is ever shown.",
  };
}

/** The unclaimed-handle landing: a growth loop, not a dead 404. */
function Unclaimed({ handle }: { handle: string }) {
  return (
    <main className="min-h-screen bg-background px-4 py-16 text-foreground">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-bold tracking-tight">@{handle}</h1>
        <p className="text-sm text-muted">
          Nobody has claimed this handle yet.
        </p>
        <Link
          href="/handle"
          className="rounded-xl bg-accent-strong px-5 py-3 text-sm font-semibold text-background hover:bg-accent"
        >
          Claim your handle
        </Link>
      </div>
    </main>
  );
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const check = checkHandle(handle);
  if (!check.ok) return <Unclaimed handle={handle} />;

  const profile = await getProfileByHandle(check.handle);
  if (profile === null) return <Unclaimed handle={check.handle} />;

  const stats = await getSocialStats(profile.address);

  // Resolve backer/backing wallets to handles. Only wallets that have claimed a
  // handle appear as named peers; anonymous backers are counted in the stats
  // but not named here.
  const peerAddresses = [...stats.backerAddresses, ...stats.backingAddresses];
  const peerProfiles = await resolveProfiles(peerAddresses);
  const toPeers = (addresses: string[]): Peer[] =>
    addresses
      .map((address) => peerProfiles.get(address.toLowerCase()))
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
      .map((p) => ({ handle: p.handle, emoji: avatarGlyph(p.handle, p.emoji) }));

  const wins: Win[] = stats.recentWins.map((win, index) => ({
    id: `${win.txHash}-${index}`,
    at: win.at,
    amountUsd: win.amountUsd,
    txHash: win.txHash,
    role: win.role,
  }));

  const data: ProfileData = {
    handle: profile.handle,
    emoji: avatarGlyph(profile.handle, profile.emoji),
    address: profile.address,
    verifiedWins: stats.goalsHit,
    usdcEarned: formatUsdc(stats.usdcEarned),
    winStreak: stats.winStreak,
    backers: toPeers(stats.backerAddresses),
    backing: toPeers(stats.backingAddresses),
    wins,
  };

  return <ProfilePaidWall profile={data} />;
}
