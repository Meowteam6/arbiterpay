// GET /api/badges?address=0x...
//   (file path: app/app/api/badges/route.ts -> route /api/badges)
//
// Returns a wallet's Duolingo-style completion stickers: the full grid of ten
// badges, each earned or locked, so the client can render greyed locked states
// alongside earned ones. Everything is derived from state the app already holds
// (pool participation/funding, the existing win source, authored challenges) -
// this route adds no new getLogs and reads no health data.
//
// Unauthenticated and read-only: a wallet address is public, and nothing here is
// health data or a money action. Whether a badge is earned is exactly the kind
// of public, on-chain-derived fact the social layer already exposes per address.
//
// Request:  query param ?address=<0x address>
// Response: { earnedCount, total, badges: [...] }  (see lib/badges.ts for shape)
//           { error } on 400 (bad address) or 500 (last-resort failure)

import { isAddress } from "viem";
import { getBadges } from "@/lib/badges";
import { jsonError, newCorrelationId, safeError } from "@/lib/server/http";

export async function GET(request: Request) {
  const cid = newCorrelationId("badges");
  try {
    const address = new URL(request.url).searchParams.get("address");
    if (address === null || !isAddress(address)) {
      return jsonError(400, "address query param must be a valid 0x address");
    }

    // getBadges is built to never throw for a degraded source (it locks that
    // source's badges instead), so this try/catch is a last-resort guard. Use
    // safeError so an unexpected failure never leaks RPC URLs or store paths to
    // this public surface; the real cause stays loud in the server log.
    const result = await getBadges(address);
    return Response.json(result);
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
