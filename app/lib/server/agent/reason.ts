// SPOTTER's reason step: Gemini on Vertex AI decides pay or no-pay from
// DERIVED data only - the attester's verdict struct, the public goal text,
// and the claim's own spending state. Document bytes structurally cannot
// reach this module; the TEE attester is the only thing that ever sees them,
// which is the product's core privacy claim.
//
// The model gets the deterministic recommendation as an anchor and may only
// exercise judgement around it; run.ts additionally refuses to pay against an
// unverified attester verdict no matter what the model says, so a bad or
// hijacked completion can veto a payout but never mint one.
//
// Any Gemini failure - missing env, quota, transport, unparseable output -
// falls back to the deterministic rule with a loud note in the ledger. The
// claim never dies because the reasoning service did.

import { GoogleGenAI } from "@google/genai";
import { optionalEnv } from "@/lib/server/env";
import type { InferenceStatus, Verdict } from "@/lib/server/judge";

export const GEMINI_MODEL = "gemini-2.5-flash";

export type EscalationContext =
  | { kind: "none" }
  | {
      kind: "bought";
      /** Summary of the escalation service's response; null when the
       *  response was lost to a resume between polls. */
      opinion: string | null;
    }
  | { kind: "skipped"; why: string };

export interface ReasonContext {
  goalSpec: string;
  verdict: Verdict;
  attesterStatus: InferenceStatus;
  escalation: EscalationContext;
  capUsd: string;
  spentUsd: string;
}

export interface ReasonDecision {
  decision: "pay" | "no-pay";
  note: string;
}

export type ReasonFn = (ctx: ReasonContext) => Promise<ReasonDecision>;

/** The rule Gemini anchors to and the fallback when Gemini is unavailable. */
export function deterministicReason(ctx: ReasonContext): ReasonDecision {
  const pay =
    ctx.attesterStatus === "completed" &&
    ctx.verdict.verified &&
    ctx.verdict.confidence !== "low";
  return {
    decision: pay ? "pay" : "no-pay",
    note: pay
      ? `verified, ${ctx.verdict.confidence} confidence. paying.`
      : `not paying: ${ctx.verdict.reason}`,
  };
}

let cachedClient: GoogleGenAI | null = null;

function vertexClient(): GoogleGenAI | null {
  const project = optionalEnv("GOOGLE_CLOUD_PROJECT", "");
  if (project === "") return null;
  if (cachedClient === null) {
    cachedClient = new GoogleGenAI({
      vertexai: true,
      project,
      location: optionalEnv("VERTEX_LOCATION", "us-central1"),
    });
  }
  return cachedClient;
}

function prompt(ctx: ReasonContext, anchor: ReasonDecision): string {
  return [
    "You are SPOTTER, the settlement agent for sponsor-funded health goal",
    "pools. You decide whether a participant's claim is paid. You never see",
    "health documents; a confidential attester already judged the evidence",
    "inside a secure enclave and you only get its verdict. Your voice is",
    "deadpan, lowercase, no exclamation marks.",
    "",
    `Goal: ${ctx.goalSpec}`,
    `Attester status: ${ctx.attesterStatus}`,
    `Attester verdict: verified=${ctx.verdict.verified}, confidence=${ctx.verdict.confidence}`,
    `Attester reason: ${ctx.verdict.reason}`,
    ctx.escalation.kind === "bought"
      ? `Second opinion bought: ${ctx.escalation.opinion ?? "no readable response"}`
      : ctx.escalation.kind === "skipped"
        ? `Second opinion NOT bought: ${ctx.escalation.why}`
        : "No second opinion was needed.",
    `Spend so far: ${ctx.spentUsd} USDC of a ${ctx.capUsd} USDC cap.`,
    `Rule-based recommendation: ${anchor.decision} (${anchor.note})`,
    "",
    "Decide pay or no-pay. Deviate from the recommendation only when the",
    "verdict details clearly warrant it, and never pay a claim the attester",
    "did not verify. Reply with ONLY a JSON object:",
    '{"decision": "pay" | "no-pay", "note": "<one deadpan sentence>"}',
  ].join("\n");
}

function coerce(text: string | undefined, anchor: ReasonDecision): ReasonDecision | null {
  if (text === undefined || text.trim() === "") return null;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (parsed.decision !== "pay" && parsed.decision !== "no-pay") return null;
    const note =
      typeof parsed.note === "string" && parsed.note.trim() !== ""
        ? parsed.note.trim()
        : anchor.note;
    return { decision: parsed.decision, note };
  } catch {
    return null;
  }
}

export const geminiReason: ReasonFn = async (ctx) => {
  const anchor = deterministicReason(ctx);
  const client = vertexClient();
  if (client === null) {
    return {
      decision: anchor.decision,
      note: `gemini unavailable (GOOGLE_CLOUD_PROJECT not set); deterministic rule applied. ${anchor.note}`,
    };
  }
  try {
    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt(ctx, anchor),
      config: {
        // On 2.5 Flash, thinking tokens consume the output budget; without
        // this the call returns empty text and reads as a broken integration.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 256,
        temperature: 0,
        responseMimeType: "application/json",
      },
    });
    const decision = coerce(response.text, anchor);
    if (decision === null) {
      return {
        decision: anchor.decision,
        note: `gemini returned no usable decision; deterministic rule applied. ${anchor.note}`,
      };
    }
    return decision;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: anchor.decision,
      note: `gemini unavailable (${message.slice(0, 120)}); deterministic rule applied. ${anchor.note}`,
    };
  }
};
