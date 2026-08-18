// Framework-free rules for the social identity layer (handles, emoji, address
// keys). Kept apart from any Supabase or React import so every rule here is
// unit-testable under vitest's node environment and shared verbatim by the
// browser claim form, the signed write route, and the read path.
//
// The shapes mirror the Supabase schema exactly (project lynhrbkspjsmqzywfhht):
//   profiles.address  text  check ~ '^0x[0-9a-f]{40}$'  (lowercased hex)
//   profiles.handle   text  check = lower(handle) and ~ '^[a-z0-9_]{3,20}$'
//   profiles.emoji    text  nullable, char_length <= 16
// The database enforces all three as CHECK constraints; these functions keep a
// bad value from ever reaching it and give the UI a reason string to show.

import { isAddress } from "viem";

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;
export const EMOJI_MAX = 16;

/**
 * Handles that must never be claimable: they would let one wallet impersonate
 * the product, the agent, or an operator on a public /u/[handle] page. Small
 * on purpose - this is impersonation defense, not a username policy.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "spotter",
  "gohealthme",
  "admin",
  "administrator",
  "support",
  "official",
  "team",
  "root",
  "system",
  "api",
]);

/** Lowercase and trim a requested handle into its canonical stored form. */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

export type HandleCheck = { ok: true; handle: string } | { ok: false; reason: string };

/**
 * Validate a requested handle and return its canonical form. The reason string
 * is user-facing copy, so it stays plain and specific.
 */
export function checkHandle(raw: string): HandleCheck {
  const handle = normalizeHandle(raw);
  if (handle === "") return { ok: false, reason: "Pick a handle." };
  if (handle.length < HANDLE_MIN) {
    return { ok: false, reason: `Handles are at least ${HANDLE_MIN} characters.` };
  }
  if (handle.length > HANDLE_MAX) {
    return { ok: false, reason: `Handles are at most ${HANDLE_MAX} characters.` };
  }
  if (!HANDLE_PATTERN.test(handle)) {
    return {
      ok: false,
      reason: "Use only lowercase letters, numbers, and underscores.",
    };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { ok: false, reason: "That handle is reserved." };
  }
  return { ok: true, handle };
}

/**
 * Normalize an optional avatar glyph. Returns null for an absent or blank
 * value (the column is nullable) and rejects anything over the column's
 * length. The glyph is user data and is rendered as-is - never interpreted -
 * so no character-class rule is applied beyond the length the schema allows.
 */
export type EmojiCheck = { ok: true; emoji: string | null } | { ok: false; reason: string };

export function checkEmoji(raw: string | null | undefined): EmojiCheck {
  if (raw === null || raw === undefined) return { ok: true, emoji: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, emoji: null };
  // Count Unicode code points, matching Postgres char_length semantics rather
  // than JS UTF-16 units, so a multi-codepoint glyph is measured the same way
  // the CHECK constraint measures it.
  if ([...trimmed].length > EMOJI_MAX) {
    return { ok: false, reason: "That avatar is too long." };
  }
  return { ok: true, emoji: trimmed };
}

/**
 * Canonical lowercase address key, or null when the input is not an address.
 * Identity across the whole layer is keyed by this exact form; both contracts
 * and the schema store lowercased hex, so any address entering the layer is
 * funneled through here first.
 */
export function normalizeAddress(raw: string): string | null {
  // strict: false accepts any 0x + 40 hex regardless of EIP-55 casing - the
  // value is lowercased into the canonical key anyway, and an address arriving
  // in the "wrong" case is an integration quirk, not a different wallet.
  if (!isAddress(raw, { strict: false })) return null;
  return raw.toLowerCase();
}

/** 0x1234...abcd - the fallback label when an address has no claimed handle. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * The name to show for an address: its handle as @handle when one is claimed,
 * otherwise the truncated address. One place so every list renders identity
 * the same way.
 */
export function displayNameFor(
  address: string,
  handle: string | null | undefined,
): string {
  return handle !== null && handle !== undefined && handle !== ""
    ? `@${handle}`
    : shortAddress(address);
}
