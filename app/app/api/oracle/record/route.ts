// POST /api/oracle/record
// Headers: x-oracle-secret: <ORACLE_API_SECRET>
// Body: { poolId, address, goalDays?, threshold? }
//
// Reads Junction (health-data) progress for the address, derives the verdict
// (streak >= goalDays) and multiplier (base 10000, +2500 comeback bonus
// when the preceding week averaged under 60, capped at 30000), refuses
// addresses that never joined the pool on-chain, and submits
// recordResult to HealthPools on Arc testnet.
// Returns: { txHash, verdict, multiplierBps, streakDays }

import { timingSafeEqual } from "crypto";
import { isAddress, type Address, type Hex } from "viem";
import { getProgress, isConnected } from "@/lib/server/junction";
import { participantJoined } from "@/lib/server/pools";
import { deriveMultiplierBps, recordResult } from "@/lib/server/oracle";
import { recordVerdict, VERDICT_FACETS } from "@/lib/server/verdict";
import { requireEnv } from "@/lib/server/env";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    const expected = requireEnv("ORACLE_API_SECRET");
    const provided = request.headers.get("x-oracle-secret");
    if (provided === null || !secretMatches(provided, expected)) {
      return jsonError(401, "Missing or invalid x-oracle-secret header");
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (err) {
      return jsonError(400, errorMessage(err));
    }

    const { poolId, address } = body;
    if (typeof poolId !== "string" && typeof poolId !== "number") {
      return jsonError(400, "poolId must be a string or number");
    }
    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    const goalDays = typeof body.goalDays === "number" ? body.goalDays : 7;
    const threshold = typeof body.threshold === "number" ? body.threshold : 75;
    if (!Number.isInteger(goalDays) || goalDays < 1 || goalDays > 100) {
      return jsonError(400, "goalDays must be an integer in 1..100");
    }
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
      return jsonError(400, "threshold must be an integer in 1..100");
    }

    // Entry gate: only addresses that joined the pool on-chain get results
    // recorded. joinPool enforces one wallet, one entry.
    const joined = await participantJoined(BigInt(poolId), address as Address);
    if (!joined) {
      return jsonError(
        403,
        `${address} has not joined pool ${String(poolId)} on-chain. Join the pool first.`,
      );
    }

    const connected = await isConnected(address);
    if (!connected) {
      return jsonError(
        404,
        `No health-data provider connected for ${address}. Connect via POST /api/junction/link.`,
      );
    }

    const progress = await getProgress(address, threshold, goalDays);
    const verdict = progress.streakDays >= goalDays;
    const multiplierBps = deriveMultiplierBps(progress.baselineWeekAvg);

    // STEP 1 — the pool result. One-shot per participant per pool; an
    // ALREADY_RECORDED revert means an earlier call landed it, so fall through
    // rather than failing, otherwise a retry can never complete step 2.
    let txHash: Hex | undefined;
    try {
      txHash = await recordResult(
        BigInt(poolId),
        address as Address,
        verdict,
        multiplierBps,
      );
    } catch (err) {
      const message = errorMessage(err);
      if (!message.includes("ALREADY_RECORDED")) {
        return jsonError(500, `Recording the result on-chain failed: ${message}`);
      }
    }

    // STEP 2 — the Chainlink verdict registry, which gates settlement.
    //
    // HealthPools.settle() pays a participant only when canSettle(goalId) is
    // true. recordResult alone is NOT enough: without this write a passing
    // wearable streak settles to ZERO while the response says verdict:true.
    //
    // Only written for a PASS. recordVerdict is one-shot, so recording a failing
    // verdict here would permanently block a later passing one for the same goal
    // (only the registry owner could override it).
    if (verdict) {
      try {
        const vr = await recordVerdict(
          BigInt(poolId),
          address as Address,
          true,
          // A streak threshold check against provider data is deterministic, not
          // a probabilistic judgement.
          "high",
          `junction:${address}:${progress.streakDays}d`,
          // Wearable evidence — NOT AI-attested. Must not claim a TEE inference
          // that never happened.
          VERDICT_FACETS.wearable,
        );
        console.log(`[oracle] HealthVerdict registry: ${vr.status}`);
      } catch (e) {
        const message = errorMessage(e);
        console.error(
          `[oracle] registry write FAILED for pool ${String(poolId)} / ${address} — ` +
            `participant is NOT settleable until this succeeds: ${message}`,
        );
        return jsonError(
          502,
          `Result recorded on-chain, but the Chainlink verdict registry write ` +
            `failed, so this goal cannot pay out yet. Retry this request — the ` +
            `result is already recorded and will not be duplicated. (${message})`,
        );
      }
    }

    return Response.json({
      txHash,
      verdict,
      multiplierBps: Number(multiplierBps),
      streakDays: progress.streakDays,
    });
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
