// GET /api/agent/feed - the claims SPOTTER has touched, newest first, each
// redacted to public money facts. This endpoint is unauthenticated and the
// full ledger carries model-authored prose about medical documents, so every
// claim passes through toPublicFeedClaim before it leaves the server. Backs
// the /agent console. Read-only.

import { listLedgerGoalIds, readLedger } from "@/lib/server/agent/ledger";
import { toPublicFeedClaim } from "@/lib/server/agent/feed-view";
import { errorMessage, jsonError } from "@/lib/server/http";

const FEED_LIMIT = 20;

export async function GET() {
  try {
    const index = await listLedgerGoalIds(FEED_LIMIT);
    const claims = await Promise.all(
      index.map(async ({ goalId, at }) =>
        toPublicFeedClaim(goalId, at, await readLedger(goalId)),
      ),
    );
    return Response.json({ claims });
  } catch (err) {
    // Loud server-side, generic client-side: the real message can carry
    // store paths and ledger file names, which do not belong on an
    // unauthenticated endpoint.
    console.error("agent feed error:", errorMessage(err));
    return jsonError(500, "agent feed unavailable");
  }
}
