// GET /api/pools/visibility?ids=1,2,3 - the effective public/private flag for a
// set of pools, so the public /pools board can drop private ones.
//
// Unauthenticated and read-only: it emits ONLY the visibility enum, never a
// share_token, so there is nothing here a stranger cannot already infer from
// whether a pool appears on the board. The resolver is store-first with an
// initiative default and fails safe to private on a per-pool basis (see
// lib/server/pool-visibility.ts). A genuine store outage makes the resolver
// throw, and this route turns that into a 500 - the board then shows an error
// rather than a fake-empty list, which is the honest failure for a surface that
// would otherwise silently hide every pool.
//
// Response JSON: { visibility: { "1": "public", "2": "private", ... } }

import { resolvePoolVisibilities } from "@/lib/server/pool-visibility";
import { jsonError, newCorrelationId, safeError } from "@/lib/server/http";

/** Cap the id list so a hand-built request cannot fan out an unbounded number
 *  of chain reads. The board never asks about more pools than exist. */
const MAX_IDS = 500;

export async function GET(request: Request) {
  const cid = newCorrelationId("pool-visibility-batch");
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("ids") ?? "";
    const ids = Array.from(
      new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^[0-9]+$/.test(s) && s !== "0"),
      ),
    ).slice(0, MAX_IDS);

    if (ids.length === 0) return Response.json({ visibility: {} });

    const resolved = await resolvePoolVisibilities(ids);
    const visibility: Record<string, string> = {};
    for (const [id, value] of resolved) visibility[id] = value;
    return Response.json({ visibility });
  } catch (err) {
    console.error("pool visibility batch error:", cid);
    return jsonError(500, safeError(err, cid));
  }
}
