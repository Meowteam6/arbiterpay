// Rate limiting for every /api/* request, applied before any route handler runs.
//
// FILE NAME: this is the file the batch plan called `middleware.ts`. Next 16
// deprecated and renamed that convention to `proxy.ts`
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md,
// "v16.0.0 - Middleware is deprecated and renamed to Proxy"), so writing
// middleware.ts here would be building on a deprecated convention. Same
// position in the tree, same execution point, same matcher semantics.
//
// WHY A PROXY AND NOT PER-ROUTE CODE: the point of the limiter is that it
// covers routes nobody remembered to think about, including ones added later.
// A per-route helper only protects the routes that opted in, which is the
// state this app was already in.
//
// Everything interesting lives in lib/server/rate-limit.ts: tier
// classification, the fail-open/fail-closed split, and the in-process fallback
// used when Redis is not configured. This file stays a thin adapter so that
// logic can be unit tested.
//
// Runtime: Next 16 runs the proxy on Node.js by default, so the Upstash REST
// client used by the limiter works here unchanged.

import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit, rateLimitResponse } from "@/lib/server/rate-limit";

export const config = {
  // API routes only. Pages, static assets, and image optimisation are left
  // alone: throttling them would break the app long before it stopped an
  // attacker, and none of them touch money or health data directly.
  matcher: "/api/:path*",
};

export async function proxy(request: NextRequest): Promise<NextResponse | Response> {
  const decision = await checkRateLimit(request);
  if (!decision.allowed) return rateLimitResponse(decision);
  return NextResponse.next();
}
