// GET /api/challenges/[token] - resolve an invite token to its challenge.
//
// Token-gated: the row is reachable ONLY by its exact invite token, which is an
// unguessable bearer capability (not the sequential pool id, so links are not
// enumerable). The table has no anon read policy, so this read runs server-side
// through the service-role client filtered by the token. Possession of the
// token is what grants the read - there is nothing else to authenticate.
//
// The response carries the challenge metadata ONLY (pool id, challenger, the
// framing message, an optional target label). It deliberately does NOT return
// the goal: the goal lives on-chain in the pool goalSpec and is read live from
// the chain by whoever holds the pool id. No health category ever passes
// through this route.
//
// Response JSON: { challenge } on a hit, 404 on a malformed or unknown token.

import { getChallengeByToken } from "@/lib/server/challenges";
import { jsonError, newCorrelationId, safeError } from "@/lib/server/http";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  const cid = newCorrelationId("challenges-read");
  try {
    const { token } = await ctx.params;
    const challenge = await getChallengeByToken(token);
    if (challenge === null) {
      return jsonError(404, "That challenge link is not valid.");
    }
    return Response.json({
      challenge: {
        inviteToken: challenge.inviteToken,
        poolId: challenge.poolId,
        challengerAddress: challenge.challengerAddress,
        targetHandle: challenge.targetHandle,
        message: challenge.message,
        createdAt: challenge.createdAt,
      },
    });
  } catch (err) {
    return jsonError(500, safeError(err, cid));
  }
}
