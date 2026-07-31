// SPOTTER's wearable evidence source: a poll-compatible reader over Junction
// provider data for pools whose goal is a device-verified streak.
//
// Why this exists: the run loop only understands one evidence interface -
// deps.poll(ref, goalSpec) resolving to a PollResult - and document claims
// satisfy it with the TEE attester. Wearable claims have no attester job at
// all; the evidence is the participant's own Junction summary scoped to the
// pool period. This module derives the verdict from that summary
// DETERMINISTICALLY (a streak threshold check, not a probabilistic judgement)
// so the confidence is "high" whenever the data was actually readable, and
// the run loop's escalation path never fires for wearables.
//
// The claim's ref is `wearable-${periodStart}` (synthesized by the run
// route), so the junction-read purchase dedupes to one per pool period while
// the derived verdict tracks fresh data on every poll.
//
// Privacy: only the derived streak count crosses this boundary. Raw sleep
// records stay inside junction.ts and are never surfaced to the ledger, the
// reason step, or the chain.

import type { Address } from "viem";
import { getProgress, isConnected } from "@/lib/server/junction";
import type { PollResult } from "@/lib/server/judge";
import type { ServiceQuote } from "@/lib/server/agent/x402";

export const JUNCTION_READ_SERVICE = "junction-read";
export const JUNCTION_READ_LABEL = "wearable summary (Junction)";
export const JUNCTION_READ_EST_USD = "0.01";

export const DEFAULT_GOAL_DAYS = 7;
export const DEFAULT_THRESHOLD = 75;

/** Junction is metered under the existing API key, so the quote is always
 *  prepaid - a null url means buyLive never invents a payment reference. */
export function junctionReadQuote(): ServiceQuote {
  return {
    service: JUNCTION_READ_SERVICE,
    label: JUNCTION_READ_LABEL,
    estUsd: JUNCTION_READ_EST_USD,
    url: null,
  };
}

/**
 * Pull the streak parameters out of the pool's public goal text, falling back
 * to the defaults (7 days at score 75) when the text does not spell them out.
 * The parse is deliberately narrow: a day count reads like "7-day" / "for 7
 * days" / "5 nights", a threshold like "score 80", "efficiency 80" or "80+".
 */
export function parseWearableGoal(goalSpec: string): {
  goalDays: number;
  threshold: number;
} {
  let goalDays = DEFAULT_GOAL_DAYS;
  let threshold = DEFAULT_THRESHOLD;

  const days = /(\d+)[\s-]*(?:day|night)/i.exec(goalSpec);
  if (days !== null) {
    const parsed = Number(days[1]);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 60) {
      goalDays = parsed;
    }
  }

  const score =
    /(?:score|efficiency)\s*(?:of|>=|at least|above)?\s*(\d+)/i.exec(
      goalSpec,
    ) ?? /(\d+)\s*\+/.exec(goalSpec);
  if (score !== null) {
    const parsed = Number(score[1]);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) {
      threshold = parsed;
    }
  }

  return { goalDays, threshold };
}

export interface WearableWindow {
  address: Address;
  /** Pool periodStart, epoch seconds (from the chain, not the caller). */
  periodStart: bigint;
  /** Pool periodEnd, epoch seconds. */
  periodEnd: bigint;
}

function isoDay(epochSeconds: bigint): string {
  return new Date(Number(epochSeconds) * 1000).toISOString().slice(0, 10);
}

/**
 * Build a deps.poll-compatible evidence source for one wearable claim. Never
 * throws: any Junction failure resolves to a failed, UNVERIFIED verdict so a
 * provider outage can neither pay a claim nor crash the run - and because
 * the run loop re-decides whenever this verdict's content changes, the next
 * successful poll recovers on its own.
 */
export function wearableEvidenceSource(
  window: WearableWindow,
): (ref: string, goalSpec: string) => Promise<PollResult> {
  return async (_ref, goalSpec) => {
    const { goalDays, threshold } = parseWearableGoal(goalSpec);
    try {
      if (!(await isConnected(window.address))) {
        return {
          status: "failed",
          verdict: {
            verified: false,
            confidence: "low",
            reason:
              "No wearable is connected for this wallet. Connect one from the dashboard and run the check again.",
          },
        };
      }

      const progress = await getProgress(
        window.address,
        threshold,
        goalDays,
        isoDay(window.periodStart),
        isoDay(window.periodEnd),
      );

      if (progress.streakDays >= goalDays) {
        return {
          status: "completed",
          verdict: {
            verified: true,
            confidence: "high",
            reason:
              `Junction reports ${progress.streakDays} qualifying days ` +
              `(score ${threshold} or higher) inside this pool period, ` +
              `meeting the ${goalDays}-day goal.`,
          },
        };
      }

      return {
        status: "completed",
        verdict: {
          verified: false,
          confidence: "high",
          reason:
            `Junction reports ${progress.streakDays} of ${goalDays} ` +
            `qualifying days (score ${threshold} or higher) inside this ` +
            `pool period. The goal is not met yet.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[wearable] Junction read failed for ${window.address}: ${message}`,
      );
      return {
        status: "failed",
        verdict: {
          verified: false,
          confidence: "low",
          reason:
            "The wearable data provider could not be reached, so nothing " +
            "was verified. Run the check again once it recovers.",
        },
      };
    }
  };
}
