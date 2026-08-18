// THE load-bearing privacy test. Pool "initiative" strings and goalSpec are
// health categories in this codebase, and the product's core claim is that a
// health category is NEVER shown next to a social handle. This test renders the
// public paid-wall with data deliberately poisoned with health labels in every
// stray field, and fails if any of those labels reaches the rendered output
// next to the handle.
//
// If someone later wires a goalSpec, an initiative, or a category into the
// profile surface, this test goes red before it can ship.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProfilePaidWall,
  type ProfileData,
} from "@/components/profile-paid-wall";

// Every health-revealing token that must never render next to a handle. The
// initiative values ship in seed-demo-pool.sh and CreatePool.tsx; the goalSpec
// markers ship on live pools.
const HEALTH_TERMS = [
  "flu",
  "flu-shot",
  "flu shot",
  "influenza",
  "vaccination",
  "cholesterol",
  "biometric",
  "preventive",
  "preventive-care",
  "sleep",
  "workout",
  "steps",
  "glucose",
  "goalspec",
  "initiative",
];

const HANDLE = "ironhabit";
const ADDRESS = "0x00000000000000000000000000000000000000a1";
const TX = "0x" + "ab".repeat(32);

/**
 * A profile whose legitimate fields are clean, but every object is spiked with
 * extra health-labeled properties the component must ignore. The cast is the
 * point: it forces properties the ProfileData type forbids, proving the
 * component reads only its whitelisted fields even when handed poison.
 */
function poisonedProfile(): ProfileData {
  return {
    handle: HANDLE,
    emoji: "G",
    address: ADDRESS,
    verifiedWins: 3,
    usdcEarned: "120.00",
    winStreak: 2,
    backers: [
      {
        handle: "nova_eth",
        emoji: "N",
        // poison
        initiative: "cholesterol",
        goalSpec: "[doc] flu-shot",
      },
    ],
    backing: [{ handle: "sol_sister", emoji: "S" }],
    wins: [
      {
        id: "w1",
        at: new Date("2026-08-01T00:00:00.000Z").toISOString(),
        amountUsd: "40.00",
        txHash: TX,
        role: "achiever",
        // poison
        goalSpec: "[doc] sleep 8 hours a night",
        initiative: "preventive-care",
        category: "biometric",
      },
    ],
    // poison at the top level too
    initiative: "cholesterol",
    goalSpec: "[doc] flu-shot",
    category: "biometric workout steps",
  } as unknown as ProfileData;
}

describe("ProfilePaidWall redaction", () => {
  const html = renderToStaticMarkup(
    createElement(ProfilePaidWall, { profile: poisonedProfile() }),
  );
  const lower = html.toLowerCase();

  it("renders the handle and the money facts", () => {
    // Guards against a vacuous pass: the surface really did render.
    expect(html).toContain(`@${HANDLE}`);
    expect(html).toContain("120.00");
    expect(html).toContain("40.00");
  });

  it("links the settlement tx to Arcscan", () => {
    expect(html).toContain(`/tx/${TX}`);
  });

  it("renders no pool health label anywhere next to the handle", () => {
    for (const term of HEALTH_TERMS) {
      expect(lower).not.toContain(term.toLowerCase());
    }
  });

  it("never renders the document marker or a raw goalSpec", () => {
    expect(html).not.toContain("[doc]");
  });
});
