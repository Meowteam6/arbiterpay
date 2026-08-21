import type { Metadata } from "next";
import PoolDetail from "@/components/PoolDetail";
import { displayGoalSpec, fetchPool } from "@/lib/contract";
import { resolvePoolVisibility } from "@/lib/server/pool-visibility";

// Tab titles carry the pool's goal text so shared links read as the goal,
// not as a bare app name. Metadata failures (bad id, RPC hiccup) fall back
// to the app title rather than failing the page.
const FALLBACK_TITLE = "GoHealthMe";
// A private pool (a person-aimed challenge, or a sponsor pool the owner marked
// private) carries a health-adjacent goal that must never reach a tab title, a
// link-preview card, or crawlable metadata - pool ids are sequential, so anyone
// can walk /pools/<n>. The goal lives only on the gated page below, never here.
const PRIVATE_POOL_TITLE = "Private pool - GoHealthMe";
const TITLE_MAX = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const poolId = BigInt(id);
    if (poolId <= 0n) return { title: FALLBACK_TITLE };
    // Store-first, initiative default, fail-safe private (never throws). A
    // private pool - however it got that way - gets the neutral title; a public
    // pool (including a challenge the owner opened up) shows its goal.
    if ((await resolvePoolVisibility(id)) === "private") {
      return { title: PRIVATE_POOL_TITLE };
    }
    const pool = await fetchPool(poolId);
    const goal = displayGoalSpec(pool.goalSpec).trim();
    if (goal === "") return { title: FALLBACK_TITLE };
    const trimmed =
      goal.length > TITLE_MAX
        ? `${goal.slice(0, TITLE_MAX - 3).trimEnd()}...`
        : goal;
    return { title: `${trimmed} - GoHealthMe` };
  } catch {
    return { title: FALLBACK_TITLE };
  }
}

export default async function PoolPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Resolve visibility server-side so the stranger gate is decided before the
  // client renders (no flash of a private goal). Fail-safe private on any doubt.
  let initialPrivate = true;
  try {
    initialPrivate = (await resolvePoolVisibility(id)) === "private";
  } catch {
    initialPrivate = true;
  }
  return <PoolDetail id={id} initialPrivate={initialPrivate} />;
}
