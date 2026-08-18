// GET /api/social/resolve?addresses=0xabc...,0xdef... - batch address->handle
// lookup for the display-name resolver. Public and read-only: it returns only
// claimed handles and avatar glyphs, which are public identity, never anything
// health-revealing.
//
// Unknown or unclaimed addresses are simply absent from the response; the
// client falls back to a truncated address for those. When Supabase is not
// configured the response is an empty map rather than an error, so lists keep
// rendering truncated addresses instead of breaking.

import { resolveProfiles, RESOLVE_MAX } from "@/lib/server/social-profile";
import { jsonError, newCorrelationId, safeError } from "@/lib/server/http";

interface ResolvedProfile {
  handle: string;
  emoji: string | null;
}

export async function GET(request: Request) {
  const cid = newCorrelationId("social-resolve");
  try {
    const raw = new URL(request.url).searchParams.get("addresses") ?? "";
    const requested = raw
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a !== "")
      .slice(0, RESOLVE_MAX);

    const resolved = await resolveProfiles(requested);

    const profiles: Record<string, ResolvedProfile> = {};
    for (const [address, profile] of resolved) {
      profiles[address] = { handle: profile.handle, emoji: profile.emoji };
    }
    return Response.json({ profiles });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
