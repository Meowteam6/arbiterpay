import type { Metadata } from "next";
import PoolDetail from "@/components/PoolDetail";
import { displayGoalSpec, fetchPool } from "@/lib/contract";

// Tab titles carry the pool's goal text so shared links read as the goal,
// not as a bare app name. Metadata failures (bad id, RPC hiccup) fall back
// to the app title rather than failing the page.
const FALLBACK_TITLE = "GoHealthMe";
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
  return <PoolDetail id={id} />;
}
