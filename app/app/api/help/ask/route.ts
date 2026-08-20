// POST /api/help/ask - the onboarding helper's one guarded Gemini call.
//
// This route is unauthenticated by design (a cold first-time visitor has no
// session), so safety comes from the shape of the rules, exactly like the money
// routes: a hard input cap, a hard output cap (in lib/server/help/ask.ts), and
// an atomic per-session + global rate limit built on the same spendFromWindow
// primitive the faucet uses. Fifty attendees sharing a link cannot run up cost:
// fresh addresses are free, so the GLOBAL counter is the real bound.
//
// Only the user's typed question is ever sent to the model. No health data, no
// pool state, no address - see lib/server/help/knowledge.ts for the prompt.
//
// Request JSON:  { question: string, session?: string, address?: string }
// Response JSON: 200 { answer, remaining } | 400 bad question | 429 rate limited
//               | 500 internal (correlation id only)

import { isAddress } from "viem";
import { generateHelpAnswer } from "@/lib/server/help/ask";
import {
  ASK_GLOBAL_CAP,
  ASK_PER_SESSION_CAP,
  HELP_WINDOW_MS,
  validateQuestion,
} from "@/lib/server/help/knowledge";
import { jsonError, newCorrelationId, readJsonBody, safeError } from "@/lib/server/http";
import { releaseFromWindow, spendFromWindow } from "@/app/api/_money/rate-limit";

// generateContent runs on the Node runtime (the Vertex SDK), so pin it.
export const runtime = "nodejs";

const GLOBAL_KEY = "help:ask:global";

/** 429 with an honest wait, matching the money routes' shape. */
function tooManyRequests(message: string, retryAfterSeconds: number): Response {
  return Response.json(
    { error: message, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/**
 * The rate-limit bucket for one caller. An address (when present) is the
 * strongest key; otherwise the client's localStorage session id; otherwise a
 * shared "anon" bucket. The global counter backstops all three.
 */
function sessionKey(body: Record<string, unknown>): string {
  const rawAddress = body.address;
  if (typeof rawAddress === "string" && isAddress(rawAddress)) {
    return `help:ask:addr:${rawAddress.toLowerCase()}`;
  }
  const rawSession = typeof body.session === "string" ? body.session : "";
  const session = rawSession.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return `help:ask:sess:${session !== "" ? session : "anon"}`;
}

export async function POST(request: Request) {
  const cid = newCorrelationId("help-ask");
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Body must be a JSON object.");
    }

    const check = validateQuestion(body.question);
    if (!check.ok) {
      return jsonError(400, check.reason);
    }

    const now = Date.now();
    const key = sessionKey(body);

    // Per-session first: reserve one question. Its remaining count feeds the
    // "N of 15 left" counter.
    const perSession = await spendFromWindow(
      key,
      1n,
      BigInt(ASK_PER_SESSION_CAP),
      HELP_WINDOW_MS,
      now,
    );
    if (perSession.kind === "deny") {
      return tooManyRequests(
        "You have used your questions for now. The Coach tab walks you through every step.",
        perSession.retryAfterSeconds,
      );
    }

    // Global next: if the whole event has hit its ceiling, hand back the
    // per-session reservation so it is not spent on a request that never ran.
    const global = await spendFromWindow(
      GLOBAL_KEY,
      1n,
      BigInt(ASK_GLOBAL_CAP),
      HELP_WINDOW_MS,
      now,
    );
    if (global.kind === "deny") {
      await releaseFromWindow(key, 1n, HELP_WINDOW_MS, now);
      return tooManyRequests(
        "The helper is busy right now. The Coach tab walks you through every step.",
        global.retryAfterSeconds,
      );
    }

    const answer = await generateHelpAnswer(check.question);
    return Response.json({
      answer,
      remaining: Number(perSession.remainingUusdc),
    });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
