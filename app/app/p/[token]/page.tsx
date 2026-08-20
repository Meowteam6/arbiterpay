import type { Metadata } from "next";
import Link from "next/link";
import PoolDetail from "@/components/PoolDetail";
import { TAP_TARGET } from "@/components/ui";
import { getPoolByShareToken } from "@/lib/server/pool-visibility";

// The token is an unguessable bearer capability and the row is looked up live
// per request, so the page is always dynamic and never cached at the edge.
export const dynamic = "force-dynamic";

// A private pool link must never be indexed, and the tab title must never leak
// the goal (which is health-adjacent) into a search result or a preview card.
// The goal is visible ON the gated page only. Title stays deliberately neutral.
export const metadata: Metadata = {
  title: "Private pool - GoHealthMe",
  robots: { index: false, follow: false },
};

/** A neutral dead-end for a bad link that reveals nothing about whether any
 *  given token exists beyond "this one does not resolve". */
function InvalidLink() {
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <h1 className="text-2xl font-bold tracking-tight">
        This private link is not valid
      </h1>
      <p className="mt-3 text-sm text-muted">
        It may have been mistyped, or the pool may no longer be private. Ask
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

export default async function PrivatePoolPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const found = await getPoolByShareToken(token);
  if (found === null) return <InvalidLink />;

  // Possession of the token IS the access grant, so the stranger gate is lifted
  // here even for a viewer who is neither the creator nor a participant.
  // initialPrivate still carries the true flag so the owner toggle renders the
  // right state; tokenAccess is what opens the goal to this token holder.
  return (
    <PoolDetail
      id={found.poolId}
      initialPrivate={found.visibility === "private"}
      tokenAccess
    />
  );
}
