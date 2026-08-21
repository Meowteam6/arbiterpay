// SPOTTER's voice, in one place. A flat list of deadpan lines keyed by surface
// and state, each carrying every locale inline so the honesty tests (see
// spotter-lines.test.ts) cover EN, 中文 and Tagalog with one pass. The picker
// lives in spotter-says.ts.
//
// Three rules the tests enforce over EVERY locale string:
//   a) SPOTTER never says a number — amounts live in the mono money slot, not
//      his mouth.
//   b) No borrowed-trust words (verify/check/shield/confirmed/proven) on a
//      self-reported, error or flake line — a self-report is never dressed as
//      verified, in any language. Lines that NEGATE trust are allowlisted.
//   c) tone "loud" is reachable only on a verified win.

export type Locale = "en" | "zh-Hans" | "tl";

/** en is always present; zh/tl are filled by the i18n pass and the picker
 *  falls back to en until they are. */
export type LocalizedText = { en: string } & Partial<Record<Locale, string>>;

export type Surface =
  | "dashboard-header"
  | "pools-header"
  | "agent-header"
  | "feed-header"
  | "dashboard-empty"
  | "pools-empty"
  | "agent-empty"
  | "feed-empty"
  | "evidence"
  | "payout";

export type SpotterState =
  | "idle"
  | "empty"
  | "verifying"
  | "won-verified"
  | "paid-self-reported"
  | "broke"
  | "error"
  | "streak-nudge";

/** "loud" is the ONLY tone allowed on a verified win (test c). */
export type Tone = "deadpan" | "dry" | "warn" | "loud";

export interface SpotterLine {
  /** Stable, unique — the sessionStorage anti-repeat key. */
  id: string;
  surface: Surface;
  state: SpotterState;
  tone: Tone;
  text: LocalizedText;
  weight?: number;
  /** True for lines that mention a trust word only to NEGATE it ("didn't
   *  vouch", "not verifying"). Allowlisted by the borrowed-trust test. */
  negatesTrust?: boolean;
}

export const SPOTTER_LINES: SpotterLine[] = [
  // ── Headers (deadpan, one-liners beside the scenic otter) ────────────────
  { id: "dash-h1", surface: "dashboard-header", state: "idle", tone: "deadpan", text: { en: "I hold the wallet. You hold the streak." } },
  { id: "dash-h2", surface: "dashboard-header", state: "idle", tone: "deadpan", text: { en: "Watching the money so you don't have to." } },
  { id: "dash-h3", surface: "dashboard-header", state: "idle", tone: "deadpan", text: { en: "Your goals. My problem now." } },

  { id: "pools-h1", surface: "pools-header", state: "idle", tone: "deadpan", text: { en: "Somebody put money up. It's just sitting there. Rude not to." } },
  { id: "pools-h2", surface: "pools-header", state: "idle", tone: "deadpan", text: { en: "Pick one. Do the thing. Get paid. In that order." } },

  { id: "agent-h1", surface: "agent-header", state: "idle", tone: "deadpan", text: { en: "I buy the proof, I make the call, I move the money." } },
  { id: "agent-h2", surface: "agent-header", state: "idle", tone: "deadpan", text: { en: "No human touches the checkout. That's the whole bit." } },

  { id: "feed-h1", surface: "feed-header", state: "idle", tone: "deadpan", text: { en: "Real payouts, flowing downstream. None of them fake." } },
  { id: "feed-h2", surface: "feed-header", state: "idle", tone: "deadpan", text: { en: "Everybody here already got paid. Catch up." } },

  // ── Empty states (dry — never a dead screen) ─────────────────────────────
  { id: "dash-e1", surface: "dashboard-empty", state: "empty", tone: "dry", text: { en: "Nothing on record yet. I can't pay a streak that doesn't exist." } },
  { id: "dash-e2", surface: "dashboard-empty", state: "empty", tone: "dry", text: { en: "Empty. Go put your name on a pool." } },

  { id: "pools-e1", surface: "pools-empty", state: "empty", tone: "dry", text: { en: "No live pools right now. Even I'm just watching the river." } },
  { id: "pools-e2", surface: "pools-empty", state: "empty", tone: "dry", text: { en: "Quiet out here. Check back when a sponsor shows up." } },

  { id: "agent-e1", surface: "agent-empty", state: "empty", tone: "dry", text: { en: "I've done nothing yet. Give me something to verify." } },
  { id: "agent-e2", surface: "agent-empty", state: "empty", tone: "dry", text: { en: "Idle otter. Feed me a claim." } },

  { id: "feed-e1", surface: "feed-empty", state: "empty", tone: "dry", text: { en: "Quiet on the river. Nobody's shown up yet today." } },
  { id: "feed-e2", surface: "feed-empty", state: "empty", tone: "dry", text: { en: "No payouts yet. The first win lands right here." } },

  // ── Verifying (deadpan — the part you're paying for) ──────────────────────
  { id: "ev-v1", surface: "evidence", state: "verifying", tone: "deadpan", text: { en: "Reading the record. Give me a sec." } },
  { id: "ev-v2", surface: "evidence", state: "verifying", tone: "deadpan", text: { en: "Your data stays sealed. I only get the verdict." } },
  { id: "ev-v3", surface: "evidence", state: "verifying", tone: "deadpan", text: { en: "Working. This is the part you're paying me for." } },

  // ── Payout: verified win (LOUD — only here) ──────────────────────────────
  { id: "pay-v1", surface: "payout", state: "won-verified", tone: "loud", text: { en: "Absolute unit. Run it back." } },
  { id: "pay-v2", surface: "payout", state: "won-verified", tone: "loud", text: { en: "That happened. I saw it, I paid it." } },
  { id: "pay-v3", surface: "payout", state: "won-verified", tone: "loud", text: { en: "Clean proof. Money's already moving." } },

  // ── Payout: self-reported (WARN — never loud, never "verified") ───────────
  { id: "pay-s1", surface: "payout", state: "paid-self-reported", tone: "warn", text: { en: "Paid on your word. Still not stamped." } },
  { id: "pay-s2", surface: "payout", state: "paid-self-reported", tone: "warn", negatesTrust: true, text: { en: "Self-reported. I logged it, I didn't vouch for it." } },

  // ── Broke, streak-nudge, error (state-reactive elsewhere) ────────────────
  { id: "broke-1", surface: "agent-header", state: "broke", tone: "warn", negatesTrust: true, text: { en: "Out of budget. Not verifying anything until topped up." } },
  { id: "broke-2", surface: "agent-header", state: "broke", tone: "warn", text: { en: "Wallet's dry. I don't run on vibes, I run on USDC." } },

  { id: "streak-1", surface: "dashboard-header", state: "streak-nudge", tone: "dry", text: { en: "Streak's still breathing. Don't make me write the sad version." } },
  { id: "streak-2", surface: "dashboard-header", state: "streak-nudge", tone: "dry", text: { en: "One more day keeps the money coming. I'm just saying." } },

  { id: "err-1", surface: "evidence", state: "error", tone: "dry", text: { en: "Something broke and it wasn't your streak. Give me a second." } },
  { id: "err-2", surface: "evidence", state: "error", tone: "dry", text: { en: "That failed cleanly. Nothing moved, nothing lost. Try again." } },
];
