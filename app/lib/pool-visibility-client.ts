// Browser side of pool visibility. Kept apart from lib/server/pool-visibility.ts
// because that module imports the service-role Supabase client, which must never
// reach the browser bundle (the same rule client-auth.ts follows). This module
// only talks to the app's own read route and holds no secret.

export type PoolVisibility = "public" | "private";

/**
 * Fetch the effective visibility of a set of pool ids from the batch read
 * route. Returns a map of only the ids the route answered for; a caller MUST
 * treat any id absent from the map as private (fail-safe - never render a pool
 * whose visibility is unknown). Short-circuits with no network call when there
 * is nothing to ask about. Throws on a non-200 so the list surface can show an
 * error rather than a fake-empty board.
 */
export async function fetchPoolVisibilities(
  ids: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, PoolVisibility>> {
  const unique = Array.from(
    new Set(ids.filter((id) => /^[0-9]+$/.test(id) && id !== "0")),
  );
  if (unique.length === 0) return {};

  const response = await fetchImpl(
    `/api/pools/visibility?ids=${unique.join(",")}`,
  );
  if (!response.ok) {
    throw new Error(`pool visibility responded ${response.status}`);
  }
  const body = (await response.json()) as {
    visibility?: Record<string, string>;
  };
  const out: Record<string, PoolVisibility> = {};
  for (const [id, value] of Object.entries(body.visibility ?? {})) {
    if (value === "public" || value === "private") out[id] = value;
  }
  return out;
}

/** Whether a pool id resolved to public in a visibility map. Absent -> false
 *  (fail-safe: an id the route did not answer for is never shown). */
export function isPublicIn(
  visibility: Record<string, PoolVisibility>,
  poolId: string,
): boolean {
  return visibility[poolId] === "public";
}
