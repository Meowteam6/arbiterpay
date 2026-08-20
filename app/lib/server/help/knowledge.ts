// The Ask tab's knowledge and guardrails. Pure: constants, an embedded fact
// sheet, a system prompt, and input validation. No env, no network, no node
// builtins, so it is safe to import from both the server routes and the client
// widget (the widget reads only the two numeric caps).
//
// The guardrail is enforced in TWO places that do not depend on each other:
//   - hard input caps here (length) and rate limits in the route, which bound
//     cost no matter what the model does;
//   - a refusal contract in the system prompt, which keeps answers on-topic and
//     off medical/financial/personal-data ground.
// Raw health data never reaches this module or the model - only the user's
// typed question does. That is the product's core privacy claim, upheld here by
// construction: nothing in this file reads health data.

/** Longest question accepted. Rejected outright past this, never truncated. */
export const MAX_QUESTION_CHARS = 500;

/** Output ceiling for the model call - answers stay short and cheap. */
export const ASK_MAX_OUTPUT_TOKENS = 256;

/** Rate window for both Ask and Feedback: one hour. */
export const HELP_WINDOW_MS = 60 * 60 * 1000;

/** Questions one session (or address) may ask per window. Powers "N of 15 left". */
export const ASK_PER_SESSION_CAP = 15;

/** Questions across every session per window - the real 50-attendee cost guard. */
export const ASK_GLOBAL_CAP = 400;

/**
 * The facts the helper is allowed to speak from. Kept short on purpose: it is
 * the whole ground truth for the model, and a tight sheet is easier to keep
 * honest than a sprawling one.
 */
export const HELP_KB = [
  "WHAT GOHEALTHME IS: sponsors fund USDC pools tied to a health goal. You hit the goal, prove it, and get paid in USDC the moment it verifies. Everything here is on Arc testnet with play-money USDC that has no real value.",
  "SIGN IN: tap Sign in and use an email address. We create an embedded wallet for you - no seed phrase, no browser extension, nothing to install.",
  "GET TEST USDC: after signing in, tap Get test USDC (the chip near the top, or the Coach's button). Arc pays gas in USDC, so your wallet needs a little before it can do anything. It is a one-tap faucet, testnet only.",
  "CLAIM A HANDLE: pick a public handle on the handle page so you show up as a name, not a wallet address. Your handle appears in the header, on your challenges, and on the payout feed. Optional for earning, but it is how friends recognize you.",
  "DO THE THING: create a challenge (dare a friend, or a parent paying a kid) from the new-challenge page, or join a sponsor pool from the pools page. Creating a challenge creates a pool, and you the challenger fund the reward.",
  "SEND A CHALLENGE: after you create one you get a private invite link. Share it, text it, or email it straight to the person you are daring. Challenge pools are private - they are not listed publicly and only people with the link can open them.",
  "ADD TO THE REWARD: anyone with the challenge link can chip in USDC to grow the pot and push the person to hit their goal. You are growing the reward, not placing a bet, and contributors show up by handle.",
  "IF THEY MISS THE GOAL: the whole pot, including friends' contributions, returns to the person who created the challenge, not split back to contributors. So chip in as an incentive, not as a refundable stake.",
  "UPLOAD PROOF: on a pool page, upload your proof (a photo, a document, or a connected wearable). That is the evidence SPOTTER checks.",
  "SPOTTER: the settlement agent. It buys the verification it needs, reads the confidential verdict, decides pay or no-pay, and pays achievers from its own wallet. It never sees your raw health data.",
  "PRIVACY / TEE: your proof is judged inside a confidential trusted execution environment (a secure enclave). Only the signed verdict leaves it. Your raw health data never touches the chain and never goes to the model.",
  "GET PAID: once your proof verifies, USDC lands in your wallet automatically. No manual checkout, no waiting on a person.",
].join("\n");

/** The refusal contract plus voice, grounded in the KB. */
export const HELP_SYSTEM_PROMPT = [
  "You are the GoHealthMe onboarding helper. You help people USE the app and nothing else.",
  "",
  "ANSWER ONLY questions about using the app: signing in, getting test USDC, creating challenges, joining pools, uploading proof, getting paid, the privacy and TEE model, what SPOTTER is, and that this is testnet play-money.",
  "",
  "REFUSE these, every time: medical advice or health guidance of any kind; financial or investment advice; and anything about a specific person's data or account. When a question is one of these, do not answer it - say you can only help with using the app, and that they should talk to a qualified professional for medical or financial questions.",
  "",
  "Ground every answer in the facts below. If the facts do not cover it, say you are not sure and point them to the Coach tab, which walks through every step.",
  "",
  "Voice: GoHealthMe - direct, friendly, a little funny, mostly lowercase. Keep it short, two or three sentences. Never use emoji. Never use exclamation marks.",
  "",
  "FACTS:",
  HELP_KB,
].join("\n");

/** Full prompt for one question. Only the typed question is interpolated. */
export function buildAskPrompt(question: string): string {
  return `${HELP_SYSTEM_PROMPT}\n\nUser question: ${question}`;
}

export type QuestionCheck =
  | { ok: true; question: string }
  | { ok: false; reason: string };

/** Validate and normalize a typed question. Length is a hard cap, not a trim. */
export function validateQuestion(raw: unknown): QuestionCheck {
  if (typeof raw !== "string") {
    return { ok: false, reason: "Ask a question as text." };
  }
  const question = raw.trim();
  if (question === "") {
    return { ok: false, reason: "Type a question first." };
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return {
      ok: false,
      reason: `Keep it under ${MAX_QUESTION_CHARS} characters.`,
    };
  }
  return { ok: true, question };
}
