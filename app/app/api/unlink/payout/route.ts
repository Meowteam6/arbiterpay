// POST /api/unlink/payout
// Body: { address, poolId, unlinkAddress, rewardUsdc?, goalId? (ignored) }
// Gates on on-chain pool membership AND a PASSING HealthVerdict verdict
// (canSettle) for the chain-derived goalId — membership alone is not an
// achievement, and a rejected verdict must not pay. Then treasury deposit ->
// private transfer to the user's wallet-derived Unlink address. Idempotent
// per chain-derived goalId: one payout per (pool, participant, period), keyed
// on a value the caller cannot vary. The body's goalId is accepted for client
// compatibility but never trusted; rewardUsdc is capped server-side.
import { isAddress, type Address } from "viem";
import { participantJoined, verdictCanSettle } from "@/lib/server/pools";
import { computeGoalId } from "@/lib/server/verdict";
import { treasuryUnlinkClient, ARC_USDC_ADDRESS } from "@/lib/server/unlink";
import { runPrivatePayout } from "@/lib/server/unlink-payout";
import { linkUnlinkAddress } from "@/lib/server/claims";
import { toBaseUnits } from "@/lib/usdc";
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http";

// Hard ceiling on a single private payout. The demo reward is 0.25 USDC; the
// request body may ask for less, never more — an uncapped client-supplied
// amount would let any caller size their own reward.
const MAX_REWARD_USDC = "0.25";

export async function POST(request: Request) {
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const { address, poolId, unlinkAddress } = body;

    if (typeof address !== "string" || !isAddress(address))
      return jsonError(400, "address must be a valid 0x address");
    if (typeof poolId !== "string" && typeof poolId !== "number")
      return jsonError(400, "poolId required");
    if (typeof unlinkAddress !== "string" || unlinkAddress === "")
      return jsonError(400, "unlinkAddress required (wallet-derived, sent from browser)");

    const rewardUsdc =
      typeof body.rewardUsdc === "string" ? body.rewardUsdc : MAX_REWARD_USDC;
    let amountBaseUnits: string;
    try {
      amountBaseUnits = toBaseUnits(rewardUsdc);
    } catch {
      return jsonError(400, "rewardUsdc must be a decimal USDC amount");
    }
    const amount = BigInt(amountBaseUnits);
    if (amount <= 0n || amount > BigInt(toBaseUnits(MAX_REWARD_USDC)))
      return jsonError(
        400,
        `rewardUsdc must be between 0 (exclusive) and ${MAX_REWARD_USDC} USDC`,
      );

    const joined = await participantJoined(BigInt(poolId), address as Address);
    if (!joined)
      return jsonError(
        403,
        `${address} has not joined pool ${String(poolId)} on-chain`,
      );

    // Verdict gate: the same canSettle predicate HealthPools.settle() pays
    // on (recorded AND verified AND confidence above LOW). The goalId is
    // derived from the chain for (poolId, address), never taken from the
    // request body, so a caller cannot point the check at someone else's
    // verified goal.
    const derivedGoalId = await computeGoalId(
      BigInt(poolId),
      address as Address,
    );
    const settleable = await verdictCanSettle(derivedGoalId);
    if (!settleable)
      return jsonError(
        403,
        `no passing verdict for ${address} in pool ${String(poolId)} ` +
          `(goal ${derivedGoalId}) — complete verification before claiming`,
      );

    // Persist the EVM address → Unlink address mapping for reference.
    await linkUnlinkAddress(address, unlinkAddress);

    // Register the treasury under this project before any shielded op. The
    // engine only issues authorization tokens for addresses it knows; an
    // unregistered treasury fails token issuance ("token provider failed").
    // ensureRegistered() is lazy-cached, so this is a no-op after the first call.
    const treasury = treasuryUnlinkClient();
    await treasury.ensureRegistered();

    // Idempotency key is the CHAIN-DERIVED goalId. The old code keyed on the
    // body's goalId, which the caller controlled — a fresh made-up id per
    // request bypassed the claimed-check entirely and re-paid the same goal.
    const result = await runPrivatePayout({
      goalId: derivedGoalId,
      recipientUnlinkAddress: unlinkAddress,
      amountBaseUnits,
      token: ARC_USDC_ADDRESS,
      treasury,
    });

    return Response.json(result);
  } catch (err) {
    return jsonError(500, errorMessage(err));
  }
}
