// GET /api/agent/feed - the claims SPOTTER has touched, newest first, each
// with its full ledger. Backs the /agent console; same data the per-claim
// receipt renders, at feed density. Read-only.

import { listLedgerGoalIds, readLedger } from "@/lib/server/agent/ledger";
import { errorMessage, jsonError } from "@/lib/server/http";

const FEED_LIMIT = 20;

export async function GET() {
  try {
    const index = await listLedgerGoalIds(FEED_LIMIT);
    const claims = await Promise.all(
      index.map(async ({ goalId, at }) => ({
        goalId,
        at,
        ledger: await readLedger(goalId),
      })),
    );
    return Response.json({ claims });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
