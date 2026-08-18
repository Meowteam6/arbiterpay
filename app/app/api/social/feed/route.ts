// GET /api/social/feed - the human named Payout Feed: SPOTTER's settled claims
// rendered as "who got paid, how much, and the tx", newest first.
//
// This re-projects the SAME redacted feed the /agent console uses
// (feed-view.toPublicFeedClaim) and never widens it: the only fields that leave
// here are a handle, a truncated-address fallback, a USDC amount, a timestamp,
// and the settlement tx hash (see named-feed.ts). No initiative, no goalSpec,
// no decision note, no service label - the redaction rule holds because the
// output type has nowhere to put a health category.
//
// Unauthenticated and read-only. When Supabase is unconfigured, handles resolve
// to null and rows fall back to truncated addresses.

import { listLedgerGoalIds, readLedger } from "@/lib/server/agent/ledger";
import { toPublicFeedClaim } from "@/lib/server/agent/feed-view";
import {
  participantOf,
  toNamedPayouts,
  type NamedFeedInput,
} from "@/lib/server/agent/named-feed";
import { resolveProfiles } from "@/lib/server/social-profile";
import { jsonError, newCorrelationId, safeError } from "@/lib/server/http";

const FEED_LIMIT = 20;

export async function GET() {
  const cid = newCorrelationId("social-feed");
  try {
    const index = await listLedgerGoalIds(FEED_LIMIT);
    const inputs: NamedFeedInput[] = await Promise.all(
      index.map(async ({ goalId, at }) => {
        const ledger = await readLedger(goalId);
        return {
          claim: toPublicFeedClaim(goalId, at, ledger),
          participant: participantOf(ledger),
        };
      }),
    );

    const addresses = inputs
      .map((input) => input.participant)
      .filter((a): a is string => a !== null);
    const resolved = await resolveProfiles(addresses);

    const payouts = toNamedPayouts(inputs, (address) => {
      const profile = resolved.get(address.toLowerCase());
      return profile !== undefined ? profile.handle : null;
    });

    return Response.json({ payouts });
  } catch (err) {
    // The real failure can carry store paths and ledger file names; keep it
    // loud server-side and generic on this public surface.
    console.error("social feed error:", cid);
    return jsonError(500, safeError(err, cid));
  }
}
