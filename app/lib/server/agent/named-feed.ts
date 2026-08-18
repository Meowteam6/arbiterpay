// The human-legible Payout Feed: SPOTTER's settled claims, re-projected from
// the already-redacted public feed (feed-view.ts) into named payout rows.
//
// THE REDACTION RULE, ENFORCED BY THE OUTPUT TYPE
// A NamedPayout can hold a handle, an address, a USDC amount, a timestamp, and
// a settlement tx hash - and nothing else. There is no field for an
// initiative, a goalSpec, a decision note, or a service label, so a health
// category cannot ride along even if one reached this function. Only two
// things are read off each claim: the settle facts (amount, tx, time) that
// feed-view already stripped down to money, and the participant address (a
// public on-chain value, never a health string). The decision, the spends,
// their service labels, and every ledger prose field are ignored here exactly
// as they are omitted from the paid-wall.
//
// A row exists only for a claim that actually paid out: settled, with a tx
// hash and a USDC amount. Deferred and no-pay claims are not payouts and do
// not appear.

import type { PublicFeedClaim } from "@/lib/server/agent/feed-view";
import type { LedgerEntry } from "@/lib/server/agent/ledger";

export interface NamedPayout {
  at: string;
  /** @handle when the wallet has claimed one, else null (caller shows the
   *  truncated address instead). Never a health label. */
  handle: string | null;
  /** Lowercased participant address, for the fallback label and nothing else. */
  address: string | null;
  amountUsd: string;
  txHash: string;
}

/** One claim plus the participant address for it (from the ledger's plan). */
export interface NamedFeedInput {
  claim: PublicFeedClaim;
  participant: string | null;
}

/**
 * Read the claim's participant from the ledger. The plan entry records it at
 * plan time; it is an address (public, on-chain), which is the only thing
 * pulled from the ledger here. No goal text, no reason, no service label.
 */
export function participantOf(ledger: LedgerEntry[]): string | null {
  for (const entry of ledger) {
    if (entry.kind === "plan" && typeof entry.participant === "string") {
      return entry.participant.toLowerCase();
    }
  }
  return null;
}

/**
 * Project settled claims into named payout rows, newest first. `handleFor`
 * maps a lowercased address to its @-less handle, or null when unclaimed.
 */
export function toNamedPayouts(
  inputs: NamedFeedInput[],
  handleFor: (address: string) => string | null,
): NamedPayout[] {
  const rows: NamedPayout[] = [];
  for (const { claim, participant } of inputs) {
    const settle = claim.settle;
    if (settle === null) continue;
    if (settle.status !== "settled") continue;
    if (settle.txHash === null || settle.paidUsd === null) continue;

    const handle =
      participant !== null ? handleFor(participant.toLowerCase()) : null;

    rows.push({
      at: settle.at,
      handle,
      address: participant,
      amountUsd: settle.paidUsd,
      txHash: settle.txHash,
    });
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return rows;
}
