// POST /api/feedback - collect first-run feedback into Supabase.
//
// Unauthenticated by design (a stranger testing the app should not have to sign
// in to say it confused them), so it is guarded the same way as the other
// public routes: strict validation and an atomic per-session + global rate
// limit on the shared spendFromWindow primitive. The service-role client is the
// only writer; the feedback table has RLS on with no policies, so nothing else
// can touch it. The founder reads it in the Supabase dashboard.
//
// NO HEALTH DATA. The table has no health columns and this route accepts none:
// only an optional wallet address, a coarse rating, a free-text note, and the
// page it came from.
//
// Request JSON:  { rating?: "easy" | "confusing", message?: string,
//                  address?: string, page?: string, session?: string }
// Response JSON: 200 { ok: true } | 400 invalid | 429 rate limited
//               | 503 not wired up | 500 internal (correlation id only)

import { isAddress } from "viem";
import { getSupabaseServiceRole } from "@/lib/server/supabase";
import { HELP_WINDOW_MS } from "@/lib/server/help/knowledge";
import { jsonError, newCorrelationId, readJsonBody, safeError } from "@/lib/server/http";
import { releaseFromWindow, spendFromWindow } from "@/app/api/_money/rate-limit";

// The Supabase server client and its keys want the Node runtime.
export const runtime = "nodejs";

const GLOBAL_KEY = "feedback:global";
const PER_SESSION_CAP = 5;
const GLOBAL_CAP = 200;
const MAX_MESSAGE_CHARS = 1000;
const MAX_PAGE_CHARS = 200;

function tooManyRequests(message: string, retryAfterSeconds: number): Response {
  return Response.json(
    { error: message, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

function sessionKey(address: string | null, rawSession: unknown): string {
  if (address !== null) {
    return `feedback:addr:${address}`;
  }
  const raw = typeof rawSession === "string" ? rawSession : "";
  const session = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return `feedback:sess:${session !== "" ? session : "anon"}`;
}

export async function POST(request: Request) {
  const cid = newCorrelationId("feedback");
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Body must be a JSON object.");
    }

    // rating: optional, but constrained to the two the table's check allows.
    const rawRating = body.rating;
    let rating: "easy" | "confusing" | null = null;
    if (rawRating !== undefined && rawRating !== null) {
      if (rawRating !== "easy" && rawRating !== "confusing") {
        return jsonError(400, "rating must be easy or confusing.");
      }
      rating = rawRating;
    }

    // message: optional free text, trimmed and capped.
    const rawMessage = body.message;
    let message: string | null = null;
    if (rawMessage !== undefined && rawMessage !== null) {
      if (typeof rawMessage !== "string") {
        return jsonError(400, "message must be a string.");
      }
      const trimmed = rawMessage.trim();
      if (trimmed.length > MAX_MESSAGE_CHARS) {
        return jsonError(400, `Keep the note under ${MAX_MESSAGE_CHARS} characters.`);
      }
      message = trimmed === "" ? null : trimmed;
    }

    if (rating === null && message === null) {
      return jsonError(400, "Add a rating or a note.");
    }

    // address: optional. Lowercased because the table's check requires it.
    const rawAddress = body.address;
    let address: string | null = null;
    if (rawAddress !== undefined && rawAddress !== null) {
      if (typeof rawAddress !== "string" || !isAddress(rawAddress)) {
        return jsonError(400, "address must be a valid 0x address when provided.");
      }
      address = rawAddress.toLowerCase();
    }

    // page: optional context, capped.
    const rawPage = body.page;
    let page: string | null = null;
    if (typeof rawPage === "string" && rawPage.trim() !== "") {
      page = rawPage.trim().slice(0, MAX_PAGE_CHARS);
    }

    const now = Date.now();
    const key = sessionKey(address, body.session);

    const perSession = await spendFromWindow(
      key,
      1n,
      BigInt(PER_SESSION_CAP),
      HELP_WINDOW_MS,
      now,
    );
    if (perSession.kind === "deny") {
      return tooManyRequests(
        "Thanks - you have sent plenty for now.",
        perSession.retryAfterSeconds,
      );
    }

    const global = await spendFromWindow(
      GLOBAL_KEY,
      1n,
      BigInt(GLOBAL_CAP),
      HELP_WINDOW_MS,
      now,
    );
    if (global.kind === "deny") {
      await releaseFromWindow(key, 1n, HELP_WINDOW_MS, now);
      return tooManyRequests(
        "Feedback is catching its breath. Try again shortly.",
        global.retryAfterSeconds,
      );
    }

    const supabase = getSupabaseServiceRole();
    if (supabase === null) {
      // Nothing was stored, so give both reservations back.
      await releaseFromWindow(key, 1n, HELP_WINDOW_MS, now);
      await releaseFromWindow(GLOBAL_KEY, 1n, HELP_WINDOW_MS, now);
      return jsonError(503, "Feedback is not wired up right now.");
    }

    const { error } = await supabase
      .from("feedback")
      .insert({ address, rating, message, page });
    if (error !== null) {
      throw new Error(`feedback insert failed: ${error.message}`);
    }

    return Response.json({ ok: true });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
