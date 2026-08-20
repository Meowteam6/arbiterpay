// Framework-free rules for the peer-challenge layer (invite tokens, the
// challenger's framing message, the optional target label). Kept apart from any
// Supabase or React import so every rule here is unit-testable under vitest's
// node environment and shared verbatim by the create form, the signed write
// route, and the token-gated landing.
//
// The shapes mirror the Supabase schema exactly (project lynhrbkspjsmqzywfhht,
// table public.challenges):
//   invite_token       text  check ~ '^[A-Za-z0-9_-]{32,64}$'  (URL-safe)
//   pool_id            bigint check > 0
//   challenger_address text  check ~ '^0x[0-9a-f]{40}$'  (lowercased hex)
//   target_handle      text  nullable, char_length <= 40
//   message            text  nullable, char_length <= 280
// The database enforces all of these as CHECK constraints; these functions keep
// a bad value from ever reaching it and give the UI a reason string to show.
//
// HARD RULE: nothing here ever carries a health category. The goal lives
// on-chain in the pool goalSpec and is read live from the chain by the landing.
// message is the challenger's own framing text; target_handle is a display
// label the challenger typed. Neither is a copy of the goal.

// ---------------------------------------------------------------- invite token

/** URL-safe base64url alphabet, 32-64 chars. Must match the DB CHECK exactly. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

/** Bytes of entropy per generated token. 24 bytes -> 32 base64url chars, which
 *  is 192 bits of entropy: unguessable, and inside the 32-64 char CHECK. */
export const INVITE_TOKEN_BYTES = 24;

export const TARGET_HANDLE_MAX = 40;
export const MESSAGE_MAX = 280;

/**
 * Encode raw bytes as URL-safe base64 with no padding, so the result is drawn
 * from exactly the [A-Za-z0-9_-] alphabet the token CHECK allows. Takes the
 * bytes as an argument (rather than reaching for a global) so it is pure and
 * testable; the caller supplies crypto-random bytes.
 */
export function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // btoa is available in the browser, Node (>=16) and the edge runtime.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A fresh, unguessable invite token from crypto-random bytes. Server-only in
 * practice (the write route mints it), but pure enough to unit-test: pass a
 * deterministic randomBytes in tests, the live crypto in production.
 */
export function generateInviteToken(
  randomBytes: (n: number) => Uint8Array = cryptoRandomBytes,
): string {
  return base64UrlNoPad(randomBytes(INVITE_TOKEN_BYTES));
}

/** crypto.getRandomValues wrapper. Present in the browser, Node and the edge. */
function cryptoRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Whether a string is a well-formed invite token. The landing and the read
 *  route both call this before touching the database, so a malformed token
 *  never becomes a query. */
export function isValidInviteToken(raw: string): boolean {
  return INVITE_TOKEN_PATTERN.test(raw);
}

// ------------------------------------------------------------ challenger text

export type MessageCheck =
  | { ok: true; message: string | null }
  | { ok: false; reason: string };

/**
 * Normalize the optional framing message. Returns null for an absent or blank
 * value (the column is nullable) and rejects anything over the column length.
 * The message is user data rendered as-is, never interpreted, so no
 * character-class rule is applied beyond the length the schema allows.
 */
export function checkMessage(raw: string | null | undefined): MessageCheck {
  if (raw === null || raw === undefined) return { ok: true, message: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, message: null };
  // Count Unicode code points, matching Postgres char_length semantics rather
  // than JS UTF-16 units, so a multi-codepoint glyph is measured the same way
  // the CHECK constraint measures it.
  if ([...trimmed].length > MESSAGE_MAX) {
    return { ok: false, reason: `Keep the message under ${MESSAGE_MAX} characters.` };
  }
  return { ok: true, message: trimmed };
}

/**
 * Canonicalize a target handle the same way on both sides of the invite:
 * strip a leading @ (people type it), lowercase, trim. The create form stores
 * this canonical form and getChallengesForTargetHandle matches on it, so the
 * recipient's own claimed handle (already lowercase [a-z0-9_]) lines up exactly
 * with what the challenger aimed at. Blank stays blank.
 */
export function normalizeTargetHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

export type TargetHandleCheck =
  | { ok: true; targetHandle: string | null }
  | { ok: false; reason: string };

/**
 * Normalize the optional target label (a name or handle the challenger typed to
 * remember who the challenge is for). Landing-only, and shown minimally; kept
 * loose on purpose (it is not the strict social handle) but bounded so it
 * cannot smuggle in arbitrary text.
 */
export function checkTargetHandle(
  raw: string | null | undefined,
): TargetHandleCheck {
  if (raw === null || raw === undefined) return { ok: true, targetHandle: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, targetHandle: null };
  if ([...trimmed].length > TARGET_HANDLE_MAX) {
    return {
      ok: false,
      reason: `Keep the name under ${TARGET_HANDLE_MAX} characters.`,
    };
  }
  return { ok: true, targetHandle: trimmed };
}

/** The share URL for a token, given an origin (e.g. window.location.origin).
 *  One place so the reveal card and any future surface build it identically. */
export function challengeShareUrl(origin: string, inviteToken: string): string {
  return `${origin.replace(/\/+$/, "")}/c/${inviteToken}`;
}
