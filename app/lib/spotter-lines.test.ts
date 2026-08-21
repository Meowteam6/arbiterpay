import { describe, it, expect } from "vitest";
import { SPOTTER_LINES } from "./spotter-lines";

// SPOTTER's honesty, enforced over EVERY locale string on every line. These are
// compliance guardrails, not style: a self-reported win must never read as
// verified in any language, and SPOTTER never states an amount.

// (a) No amount: no digit and no dollar sign. The currency word alone is fine;
//     a NUMBER is what belongs in the mono money slot, never in his mouth.
const HAS_AMOUNT = /[$\d]/;

// (b) Borrowed trust vocabulary.
const TRUST_WORDS = /\b(verif\w*|check\w*|shield|confirmed|proven)\b/i;

// The non-verified states where a trust word would launder a self-report.
const NO_TRUST_STATES = new Set(["paid-self-reported", "error", "broke"]);

describe("SPOTTER voice — honesty", () => {
  it("(a) never states a number, in any locale", () => {
    for (const line of SPOTTER_LINES) {
      for (const [locale, text] of Object.entries(line.text)) {
        expect(
          HAS_AMOUNT.test(text),
          `${line.id} [${locale}]: "${text}"`,
        ).toBe(false);
      }
    }
  });

  it("(b) never borrows trust vocabulary on a non-verified state (unless it negates it)", () => {
    for (const line of SPOTTER_LINES) {
      if (!NO_TRUST_STATES.has(line.state) || line.negatesTrust) continue;
      for (const [locale, text] of Object.entries(line.text)) {
        expect(
          TRUST_WORDS.test(text),
          `${line.id} [${locale}]: "${text}"`,
        ).toBe(false);
      }
    }
  });

  it('(c) tone "loud" is reachable only on a verified win', () => {
    for (const line of SPOTTER_LINES) {
      if (line.tone !== "loud") continue;
      expect(line.state, line.id).toBe("won-verified");
    }
  });

  it("every line id is unique", () => {
    const ids = SPOTTER_LINES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
