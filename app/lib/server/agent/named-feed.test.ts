// The Payout Feed re-projection carries money and identity only. Pinned here:
// a ledger full of health prose (verdict reasons, decision notes, goal text)
// goes through the real feed projection into named payout rows, and none of
// that prose - and no health category - survives to the row. Only handle,
// address, amount, tx, and time come out.

import { describe, it, expect } from "vitest";
import { toPublicFeedClaim } from "@/lib/server/agent/feed-view";
import {
  participantOf,
  poolIdOf,
  toNamedPayouts,
} from "@/lib/server/agent/named-feed";
import type { LedgerEntry } from "@/lib/server/agent/ledger";

const AT = "2026-08-01T00:00:00.000Z";
const GOAL = "0x" + "cd".repeat(32);
const PARTICIPANT = "0x00000000000000000000000000000000000000a1";

// Every health-revealing token this feed must never emit next to a name.
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
  "goalSpec",
  "initiative",
  "chronic",
];

function sensitiveSettledLedger(): LedgerEntry[] {
  return [
    {
      kind: "plan",
      at: AT,
      capUsd: "1.00",
      poolId: "3",
      participant: PARTICIPANT,
      steps: [
        {
          service: "attester-read",
          label: "document read (TEE attester)",
          estUsd: "0.02",
        },
      ],
    },
    {
      kind: "spend",
      at: AT,
      service: "attester-read",
      label: "document read (TEE attester)",
      amountUsd: "0.02",
      ref: "job-1",
      settlement: "x402",
      note: "the cholesterol panel is legible; escalating for a second read",
    },
    {
      kind: "verdict",
      at: AT,
      verified: true,
      confidence: "high",
      reason: "the chart shows an influenza vaccination and a sleep streak",
      ref: "job-1",
    },
    {
      kind: "reason",
      at: AT,
      decision: "pay",
      note: "paying. the flu shot record matches the preventive-care goal.",
    },
    {
      kind: "settle",
      at: AT,
      status: "settled",
      txHash: "0xsettletx",
      paidUsd: "50.00",
    },
  ];
}

function deferredLedger(): LedgerEntry[] {
  return [
    {
      kind: "plan",
      at: AT,
      capUsd: "1.00",
      participant: PARTICIPANT,
      steps: [],
    },
    { kind: "settle", at: AT, status: "deferred", note: "waiting on period end" },
  ];
}

describe("toNamedPayouts", () => {
  it("names a settled payout with money facts only", () => {
    const ledger = sensitiveSettledLedger();
    const rows = toNamedPayouts(
      [
        {
          claim: toPublicFeedClaim(GOAL, AT, ledger),
          participant: participantOf(ledger),
        },
      ],
      (address) => (address === PARTICIPANT ? "ironhabit" : null),
    );

    expect(rows).toEqual([
      {
        at: AT,
        handle: "ironhabit",
        address: PARTICIPANT,
        amountUsd: "50.00",
        txHash: "0xsettletx",
      },
    ]);
  });

  it("leaks no health category next to the handle", () => {
    const ledger = sensitiveSettledLedger();
    const rows = toNamedPayouts(
      [
        {
          claim: toPublicFeedClaim(GOAL, AT, ledger),
          participant: participantOf(ledger),
        },
      ],
      () => "ironhabit",
    );

    const text = JSON.stringify(rows).toLowerCase();
    // The handle is present...
    expect(text).toContain("ironhabit");
    // ...and not one health token rode along with it.
    for (const term of HEALTH_TERMS) {
      expect(text).not.toContain(term.toLowerCase());
    }
  });

  it("shows nothing for claims that did not pay out", () => {
    const ledger = deferredLedger();
    const rows = toNamedPayouts(
      [
        {
          claim: toPublicFeedClaim(GOAL, AT, ledger),
          participant: participantOf(ledger),
        },
      ],
      () => "ironhabit",
    );
    expect(rows).toEqual([]);
  });

  it("falls back to a null handle when the wallet is unclaimed", () => {
    const ledger = sensitiveSettledLedger();
    const rows = toNamedPayouts(
      [
        {
          claim: toPublicFeedClaim(GOAL, AT, ledger),
          participant: participantOf(ledger),
        },
      ],
      () => null,
    );
    expect(rows[0].handle).toBeNull();
    expect(rows[0].address).toBe(PARTICIPANT);
  });
});

describe("participantOf", () => {
  it("reads the participant address from the plan entry", () => {
    expect(participantOf(sensitiveSettledLedger())).toBe(PARTICIPANT);
  });

  it("returns null when no plan carries a participant", () => {
    expect(participantOf([{ kind: "settle", at: AT, status: "deferred" }])).toBeNull();
  });
});

describe("poolIdOf", () => {
  it("reads the pool id from the plan entry", () => {
    // sensitiveSettledLedger()'s plan carries poolId "3".
    expect(poolIdOf(sensitiveSettledLedger())).toBe("3");
  });

  it("returns null when the plan predates the poolId field", () => {
    expect(poolIdOf(deferredLedger())).toBeNull();
  });

  it("returns null when there is no plan at all", () => {
    expect(poolIdOf([{ kind: "settle", at: AT, status: "deferred" }])).toBeNull();
  });
});
