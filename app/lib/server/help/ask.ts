// The Ask tab's model call. Reuses SPOTTER's Vertex client and model id from
// lib/server/agent/reason.ts - same credentials, same cache, no new SDK path.
// Only the onboarding system prompt and the user's typed question go in; no
// health data ever reaches here.
//
// This never throws and never fails silently: any problem (Gemini
// unconfigured, empty completion, transport error) is logged server-side and
// answered with a written fallback that points the user back to the Coach.

import { GEMINI_MODEL, vertexClient } from "@/lib/server/agent/reason";
import { ASK_MAX_OUTPUT_TOKENS, buildAskPrompt } from "@/lib/server/help/knowledge";

const FALLBACK =
  "the onboarding helper is offline right now. the Coach tab walks you through every step: sign in, grab test USDC, claim a handle, then create or join a pool and upload your proof.";

/** Answer one onboarding question. Returns prose; falls back on any failure. */
export async function generateHelpAnswer(question: string): Promise<string> {
  const client = vertexClient();
  if (client === null) {
    // No Gemini configured (GOOGLE_CLOUD_PROJECT unset). Not an error the user
    // caused, and not something to crash on.
    return FALLBACK;
  }
  try {
    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: buildAskPrompt(question),
      config: {
        // 2.5 Flash spends thinking tokens from the output budget; without this
        // the call returns empty text and reads as a broken integration.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: ASK_MAX_OUTPUT_TOKENS,
        temperature: 0.4,
      },
    });
    const text = response.text;
    if (text === undefined || text.trim() === "") {
      return FALLBACK;
    }
    return text.trim();
  } catch (err) {
    console.error("[help/ask] gemini call failed", err);
    return FALLBACK;
  }
}
