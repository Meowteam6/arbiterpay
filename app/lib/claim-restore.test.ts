// A restored claim has to reopen on the tab that owns it. These cases pin the
// two ledger shapes that carry the answer (the plan, and the cheap read that
// followed it) and the retry case, where the newest attempt wins.

import { describe, it, expect } from "vitest";
import {
  claimProofPathOf,
  claimScreenOf,
  claimVisibilityOf,
  emptyClaimScreen,
  mergeRunLedger,
  nextClaimScreen,
  receiptToKeep,
} from "@/lib/claim-restore";
import type { ClientAuth } from "@/lib/client-auth";
import type { LedgerEntry } from "@/lib/agent-receipt";

const AT = "2026-08-04T10:00:00.000Z";

function plan(service: string): LedgerEntry {
  return {
    at: AT,
    kind: "plan",
    steps: [{ service, label: "cheap read", estUsd: "0.01" }],
    capUsd: "1.00",
  };
}

function spend(service: string, ref: string): LedgerEntry {
  return {
    at: AT,
    kind: "spend",
    service,
    label: "cheap read",
    amountUsd: "0.01",
    ref,
    settlement: "prepaid",
  };
}

const VERDICT: LedgerEntry = {
  at: AT,
  kind: "verdict",
  verified: true,
  confidence: "high",
  reason: "goal met",
  ref: "job-1",
};

describe("claimProofPathOf", () => {
  it("has no answer for an empty ledger", () => {
    expect(claimProofPathOf([])).toBeNull();
  });

  it("reads the wearable path off the junction read", () => {
    expect(
      claimProofPathOf([
        plan("junction-read"),
        spend("junction-read", "wearable-1750000000"),
        VERDICT,
      ]),
    ).toBe("wearable");
  });

  it("reads the document path off the attester read", () => {
    expect(
      claimProofPathOf([
        plan("attester-read"),
        spend("attester-read", "job-1"),
        VERDICT,
      ]),
    ).toBe("document");
  });

  it("answers from the plan alone when the buy never landed", () => {
    expect(claimProofPathOf([plan("junction-read")])).toBe("wearable");
    expect(claimProofPathOf([plan("attester-read")])).toBe("document");
  });

  it("treats a vision-judge escalation as the document path", () => {
    expect(
      claimProofPathOf([spend("vision-judge", "job-1:vision-judge")]),
    ).toBe("document");
  });

  it("ignores the settlement chain read, which both paths buy", () => {
    expect(
      claimProofPathOf([
        plan("junction-read"),
        spend("junction-read", "wearable-1"),
        spend("chain-read", "0xdeadbeef"),
      ]),
    ).toBe("wearable");
  });

  it("resolves a retried claim to the path that ran last", () => {
    expect(
      claimProofPathOf([
        plan("junction-read"),
        spend("junction-read", "wearable-1"),
        spend("attester-read", "job-2"),
      ]),
    ).toBe("document");
  });

  it("has no answer when nothing names a path", () => {
    expect(claimProofPathOf([VERDICT])).toBeNull();
    expect(claimProofPathOf([spend("chain-read", "0xdead")])).toBeNull();
  });
});

// ------------------------------------------------------------ claim visibility
//
// The regression these cases exist for: the claim read was redacted to stop it
// leaking model prose about medical documents, and the browser kept reading
// `body.ledger`. It came back undefined, the components saw an empty array,
// and a user who had already uploaded evidence and paid gas was shown a blank
// "Prove it." box - an invitation to buy the same verification twice.

describe("claimVisibilityOf", () => {
  const OK: ClientAuth = {
    kind: "ok",
    credential: { address: "0xabc", timestamp: AT, signature: "0x00" },
    headers: {},
  };

  it("shows the ledger to an owner", () => {
    const ledger = [plan("attester-read"), spend("attester-read", "job-1")];
    expect(claimVisibilityOf({ hasLedger: true, ledger }, OK)).toEqual({
      kind: "visible",
      ledger,
    });
  });

  it("treats an owner's empty ledger as no claim at all", () => {
    // Nothing has happened yet, so the upload box is the honest screen.
    expect(claimVisibilityOf({ hasLedger: false, ledger: [] }, OK)).toEqual({
      kind: "none",
    });
  });

  it("reports a withheld claim as withheld, never as absent", () => {
    const result = claimVisibilityOf({ hasLedger: true }, { kind: "declined" });
    expect(result.kind).toBe("locked");
    expect(result.kind === "locked" && result.reason).toMatch(/sign/i);
  });

  it("does not call a claim somebody else's on the client's guess", () => {
    // The client thought its signature was good and the ledger still did not
    // come back. That is usually an expired signature or a chain read that
    // failed - telling this person their own claim belongs to a stranger is
    // the kind of wrong that reads as "my money is gone".
    const result = claimVisibilityOf({ hasLedger: true, access: "unproven" }, OK);
    expect(result.kind === "locked" && result.reason).toMatch(/sign again/i);
    expect(result.kind === "locked" && result.reason).not.toMatch(
      /different wallet/i,
    );
  });

  it("says wrong wallet only when the server says so", () => {
    const result = claimVisibilityOf(
      { hasLedger: true, access: "not-owner" },
      OK,
    );
    expect(result.kind === "locked" && result.reason).toMatch(
      /different wallet/i,
    );
  });

  it("keeps the connect-your-wallet advice ahead of the server's verdict", () => {
    // No wallet at all: "switch wallets" would be nonsense advice.
    const result = claimVisibilityOf(
      { hasLedger: true, access: "unproven" },
      { kind: "no-wallet" },
    );
    expect(result.kind === "locked" && result.reason).toMatch(/connect/i);
  });

  it("names the missing wallet when there is no wallet", () => {
    const result = claimVisibilityOf({ hasLedger: true }, { kind: "no-wallet" });
    expect(result.kind === "locked" && result.reason).toMatch(/connect/i);
  });

  it("advises signing again when the server said nothing about access", () => {
    // An older server, or a response that lost the field: the safe copy is
    // the recoverable one, not an accusation.
    const result = claimVisibilityOf({ hasLedger: true }, OK);
    expect(result.kind === "locked" && result.reason).toMatch(/sign again/i);
  });

  it("offers the upload box to a signed-out visitor with no claim", () => {
    expect(
      claimVisibilityOf({ hasLedger: false }, { kind: "no-wallet" }),
    ).toEqual({ kind: "none" });
  });

  it("degrades to no claim on a response missing both fields", () => {
    expect(claimVisibilityOf({}, OK)).toEqual({ kind: "none" });
  });

  it("ignores a ledger field that is not an array", () => {
    const result = claimVisibilityOf(
      { hasLedger: true, ledger: "everything" },
      { kind: "declined" },
    );
    expect(result.kind).toBe("locked");
  });
});

// ---------------------------------------------------------------- run screen
//
// The regression these exist for is the worse twin of the blank upload box: a
// receipt listing real USDC SPOTTER already spent, wiped by ONE transient 5xx
// or network blip - typically the first request of a resumed run, or the
// deferred-settle re-poll firing before the chain is ready. What replaced it
// invited the user to upload again, which buys a second attester job and draws
// on the per-claim cap a second time for a claim that already ran.

describe("nextClaimScreen", () => {
  const OK: ClientAuth = {
    kind: "ok",
    credential: { address: "0xabc", timestamp: AT, signature: "0x00" },
    headers: {},
  };
  const shown = [plan("attester-read"), spend("attester-read", "job-1")];

  it("replaces the rows when the poll carried a ledger", () => {
    const next = [...shown, VERDICT];
    const screen = nextClaimScreen(claimScreenOf(shown), { ledger: next }, OK);
    expect(screen.ledger).toBe(next);
    expect(screen.lockedReason).toBeNull();
  });

  it("keeps the rows and explains itself when the poll came back withheld", () => {
    const screen = nextClaimScreen(
      claimScreenOf(shown),
      { hasLedger: true },
      { kind: "declined" },
    );
    expect(screen.ledger).toEqual(shown);
    expect(screen.lockedReason).not.toBeNull();
  });

  it("never returns fewer rows than it was given", () => {
    // A response claiming there is no claim cannot un-spend what is on screen.
    const screen = nextClaimScreen(claimScreenOf(shown), { hasLedger: false }, OK);
    expect(screen.ledger).toEqual(shown);
  });

  it("clears the withheld note once the rows come back", () => {
    const locked = nextClaimScreen(
      claimScreenOf(shown),
      { hasLedger: true },
      { kind: "declined" },
    );
    const recovered = nextClaimScreen(locked, { ledger: shown }, OK);
    expect(recovered.lockedReason).toBeNull();
  });
});

describe("receiptToKeep", () => {
  const shown = [plan("junction-read"), spend("junction-read", "w-1")];

  it("keeps a receipt with money on it through a failed poll", () => {
    expect(receiptToKeep(claimScreenOf(shown))).toEqual(shown);
  });

  it("keeps it through a poll that failed while the rows were withheld", () => {
    expect(receiptToKeep({ ledger: shown, lockedReason: "locked" })).toEqual(
      shown,
    );
  });

  it("has nothing to keep when nothing was ever shown", () => {
    expect(receiptToKeep(emptyClaimScreen())).toBeUndefined();
    expect(receiptToKeep(undefined)).toBeUndefined();
  });

  it("survives a resumed run whose very first request fails", () => {
    // The exact regression. Restore put paid rows on screen; the resumed run's
    // first poll threw (a 5xx, or the settle re-poll firing before the chain
    // was ready). The loop must start from the screen - starting it at nothing,
    // as it used to, left this claim rendering a bare upload box and invited a
    // second paid attempt.
    const restored = claimScreenOf(shown);
    expect(receiptToKeep(restored)).toEqual(shown);
    expect(receiptToKeep(emptyClaimScreen())).toBeUndefined();
  });
});

describe("mergeRunLedger", () => {
  it("takes the fresh ledger when the poll carried one", () => {
    const next = [plan("junction-read")];
    expect(mergeRunLedger([], { ledger: next })).toBe(next);
  });

  it("keeps the rows already on screen when a poll comes back withheld", () => {
    // Money that moved must not vanish from the receipt because a cached
    // signature aged out mid-run.
    const shown = [plan("junction-read"), spend("junction-read", "w-1")];
    expect(mergeRunLedger(shown, { hasLedger: true })).toBe(shown);
  });
});
