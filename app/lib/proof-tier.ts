// The proof-tier honesty boundary, in one pure module.
//
// A goal is proven by one of three modalities (see lib/contract.ts's Modality),
// but on the READ side every surface only needs one distinction: is this win a
// VERIFIED-tier win (wearable/document, judged in the enclave) or a low-trust
// SELF-REPORTED win (a photo/screenshot we cannot confirm is real, recent, or
// theirs)? A self-reported win is a REAL win and pays at 1x, but it must NEVER
// render or read as "Verified" anywhere — badge, label, pill, card, feed row,
// receipt, or stat. That is a compliance boundary, not a style choice.
//
// The tier is distinguishable from two tamper-evident sources, both keyed by
// goalId, and this module is the single place that maps either onto a display
// tier and onto the exact copy each surface shows:
//   - on-chain: the HealthVerdict facet bitmap. A passing verdict with bitmap 0
//     asserts NO trust facet -> self-reported. FACET_WEARABLE or
//     FACET_AI_ATTESTED set -> verified tier. (lib/contract.ts reads it.)
//   - off-chain: the ledger verdict entry's optional `selfReported` flag.
//
// Pure by construction (no RPC, no JSX), so every surface's honesty is unit-
// testable in node.

/** Facet bits, mirroring HealthVerdict.sol FACET_* constants. Only the two
 *  trust facets this pipeline ever writes matter for the read-side tier: a
 *  verified verdict carries one of them, a self-reported verdict carries none
 *  (bitmap 0). The World-ID bit is never written (World ID was removed). */
export const FACET_WEARABLE = 1 << 0; // bit0: wearable/device data verified
export const FACET_AI_ATTESTED = 1 << 2; // bit2: AI attested (TEE inference)

/**
 * The display trust tier of a recorded verdict.
 *   "verified"      — a passing verdict that asserts a trust facet.
 *   "self-reported" — a passing verdict that asserts NO facet (the low-trust
 *                     tier). NEVER render this as "Verified".
 *   "unknown"       — no passing verdict on record (registry off, not recorded,
 *                     or a read that failed). MUST NOT be presented as verified.
 */
export type ProofTier = "verified" | "self-reported" | "unknown";

/**
 * Classify a HealthVerdict registry record into a display tier from its public
 * routing scalars (the `verified` bool and the facet `bitmap`) — never any
 * health-derived content. A passing verdict with a facet set is verified; a
 * passing verdict with bitmap 0 is the self-reported tier; anything without a
 * passing verdict is unknown and is treated as NOT verified everywhere.
 */
export function proofTierFromVerdict(verified: boolean, bitmap: number): ProofTier {
  if (!verified) return "unknown";
  return bitmap === 0 ? "self-reported" : "verified";
}

/** Tally a set of achiever-win tiers into the two counts the profile shows.
 *  Self-reported wins are counted SEPARATELY and never inflate the verified
 *  count; an "unknown"-tier win is counted in neither (it is not proven
 *  verified, and it is not known to be self-reported). */
export function tallyWinTiers(tiers: ProofTier[]): {
  verifiedWins: number;
  selfReportedWins: number;
} {
  let verifiedWins = 0;
  let selfReportedWins = 0;
  for (const tier of tiers) {
    if (tier === "verified") verifiedWins += 1;
    else if (tier === "self-reported") selfReportedWins += 1;
  }
  return { verifiedWins, selfReportedWins };
}

/** A profile paid-wall win row's presentation. `tier` is null for a backer
 *  win (whose row makes no trust-tier claim of its own). A self-reported win
 *  never carries a check/shield and never reads "Verified". */
export interface WinPresentation {
  label: string;
  tone: "accent" | "warning" | "muted";
  /** Whether the emerald check badge renders. Never true for self-reported. */
  showCheck: boolean;
  /** Small trailing qualifier, e.g. the self-reported low-trust note. */
  sublabel: string | null;
}

export function profileWinPresentation(
  role: "achiever" | "backer",
  tier: ProofTier | null,
): WinPresentation {
  if (role === "backer") {
    return { label: "Backed a winner", tone: "accent", showCheck: true, sublabel: null };
  }
  if (tier === "self-reported") {
    return {
      label: "Self-reported win",
      tone: "warning",
      showCheck: false,
      sublabel: "unverified · self-reported",
    };
  }
  if (tier === "verified") {
    return { label: "Verified win", tone: "accent", showCheck: true, sublabel: null };
  }
  // Unknown tier: an achiever win we cannot prove is verified. Neutral, never
  // "Verified", never a check badge.
  return { label: "Achiever win", tone: "muted", showCheck: false, sublabel: null };
}

/** The leading clause and tone of a deferred (recorded-but-unsettled) claim
 *  card on the dashboard. The surface appends the settle-moment + countdown.
 *  Self-reported and unknown claims never lead with "Verified". */
export interface DeferredLead {
  lead: string;
  tone: "accent" | "warning";
  /** Whether to name the pending claim "self-reported" in the settle sentence. */
  selfReported: boolean;
}

export function dashboardDeferredLead(tier: ProofTier | null): DeferredLead {
  if (tier === "self-reported") {
    return {
      lead: "Self-reported — not verified, but recorded on-chain.",
      tone: "warning",
      selfReported: true,
    };
  }
  if (tier === "verified") {
    return { lead: "Verified and recorded on-chain.", tone: "accent", selfReported: false };
  }
  return { lead: "Recorded on-chain.", tone: "accent", selfReported: false };
}

/** The status badge for a challenge whose result is recorded and passing but
 *  not yet settled. Mirrors the dashboard's deferred tiering so a self-reported
 *  challenge never reads "Verified - awaiting settle". */
export function challengeAwaitingSettleStatus(tier: ProofTier | null): {
  label: string;
  tone: "accent" | "warning";
} {
  if (tier === "self-reported") {
    return { label: "Self-reported - awaiting settle", tone: "warning" };
  }
  if (tier === "verified") {
    return { label: "Verified - awaiting settle", tone: "accent" };
  }
  return { label: "Recorded - awaiting settle", tone: "accent" };
}

/** The deferred (verdict-recorded, settling) copy for the claim rail. A
 *  self-reported deferred verdict never reads "Verified". */
export function railDeferredCopy(selfReported: boolean): string {
  return selfReported
    ? "Self-reported (unverified). Settles when the pool period ends."
    : "Verified. Settles when the pool period ends.";
}
