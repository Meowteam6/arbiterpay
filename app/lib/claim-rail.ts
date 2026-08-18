// The five visible states of a claim, and the pure rule that picks the active
// one. The rail is a progress indicator over the same ledger the receipt reads,
// so the derivation lives here - pure and node-tested - rather than being
// re-decided inside the component.
//
// The load-bearing rule: paid is the ONLY step that renders a payout, and it is
// reached exclusively through runStatus "paid", which lib/agent-receipt returns
// only for a settle entry the ledger recorded as settled. A verified-but-
// deferred verdict is runStatus "recorded" and maps to verdict, never paid.

import type { RunStatus } from "@/lib/agent-receipt";

export type ClaimStep = "join" | "prove" | "checking" | "verdict" | "paid";

export interface ClaimStepMeta {
  id: ClaimStep;
  label: string;
  /** One-line description, shown when this is the active step. */
  blurb: string;
}

export const CLAIM_STEPS: ClaimStepMeta[] = [
  {
    id: "join",
    label: "Join",
    blurb: "One wallet, one entry. You pay in on-chain.",
  },
  {
    id: "prove",
    label: "Prove",
    blurb: "Hand SPOTTER the evidence that you hit the goal.",
  },
  {
    id: "checking",
    label: "SPOTTER checking",
    blurb: "The agent buys the verification it needs, under a hard cap.",
  },
  {
    id: "verdict",
    label: "Verdict",
    blurb: "A confidential verdict lands. Your data never left the enclave.",
  },
  {
    id: "paid",
    label: "Paid",
    blurb: "USDC in your wallet the moment settlement runs.",
  },
];

const ORDER: ClaimStep[] = ["join", "prove", "checking", "verdict", "paid"];

/** Position of a step in the rail, 0-based. */
export function claimStepIndex(step: ClaimStep): number {
  return ORDER.indexOf(step);
}

/**
 * The active step, derived from what the page already knows:
 *   - not joined                              -> join
 *   - joined, no claim on the ledger          -> prove
 *   - a claim is mid-flight (verifying)       -> checking
 *   - settled payout recorded (runStatus paid)-> paid
 *   - any other terminal, INCLUDING recorded  -> verdict
 *
 * recorded is a verified verdict whose settlement is deferred to the pool's
 * period end; it must show as verdict, never paid. Only runStatus "paid"
 * advances the rail to paid.
 */
export function claimStepOf(
  joined: boolean,
  hasClaim: boolean,
  runStatus: RunStatus | null,
): ClaimStep {
  if (!joined) return "join";
  if (!hasClaim || runStatus === null) return "prove";
  switch (runStatus) {
    case "verifying":
      return "checking";
    case "paid":
      return "paid";
    case "recorded":
    case "no-pay":
    case "cap-exceeded":
    case "blocked":
    case "error":
      return "verdict";
  }
}
