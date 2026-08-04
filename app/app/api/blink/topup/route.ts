// POST /api/blink/topup
//   (file path: app/app/api/blink/topup/route.ts -> route /api/blink/topup)
//
// WHAT THIS IS: a testnet faucet. It grants a small, fixed amount of in-app
// GoHealthMe balance so somebody new can try a pool without first hunting down
// testnet USDC.
//
// WHAT THIS IS NOT: a payment. Nothing is pulled from the caller's wallet,
// nothing settles on Base Sepolia, and no USDC changes hands here. The route
// name is a leftover from the Blink one-tap deposit experiment; the behaviour
// has only ever been a grant, so the limits and the UI copy now say so.
//
// WHY THE LIMITS: this route is unauthenticated and always was. The previous
// version credited a flat 10 USDC keyed on a caller-supplied `ref` string, so
// a fresh ref bought a fresh credit and a loop of curl calls plus
// /api/balance/withdraw drained the treasury. Safety here is by construction:
//   - the ledger idempotency key is derived server-side from the address and
//     the window, never from the request body
//   - one grant per address per FAUCET_COOLDOWN_MS, reserved atomically
//   - a global budget per window, because fresh addresses cost an attacker
//     nothing and a per-address limit alone therefore bounds nothing
//   - a treasury floor, because in-app balance is a claim on real Arc USDC
// The cap arithmetic lives in app/lib/money-guards.ts with unit tests; the
// atomic reservation lives in app/app/api/_money/rate-limit.ts.
//
// Request JSON:  { address: string }
//   A `ref` field is accepted and IGNORED. It used to be the idempotency key
//   and old clients still send one; honouring it is the exploit.
//
// Response JSON:
//   200 { balanceUusdc: string, grantedUusdc: string, applied: boolean }
//   400 bad address | 429 cooldown or budget exhausted (with Retry-After)
//   503 treasury cannot back the grant, or the ledger is unavailable | 500

import { isAddress, type Address } from "viem";
import { credit, getBalance } from "@/lib/server/balance";
import { jsonError, readJsonBody } from "@/lib/server/http";
import { formatUsdc } from "@/lib/contract";
import {
  FAUCET_COOLDOWN_MS,
  FAUCET_DAILY_BUDGET_UUSDC,
  FAUCET_GRANT_UUSDC,
  faucetClaimRef,
  serverFailure,
  treasuryCanCover,
} from "@/lib/money-guards";
import { treasuryUsdcBalanceUusdc } from "@/app/api/_money/treasury-balance";
import {
  LEDGER_LOCK,
  claimOncePerWindow,
  releaseFromWindow,
  releaseOncePerWindow,
  spendFromWindow,
  withLock,
} from "@/app/api/_money/rate-limit";

// The floor check reads Arc over RPC, which needs the Node runtime.
export const runtime = "nodejs";

const SCOPE = "api/blink/topup";
const GLOBAL_BUDGET_KEY = "faucet:global";

/** 429 with an honest wait, so a client can show a countdown, not a stack trace. */
function tooManyRequests(message: string, retryAfterSeconds: number): Response {
  return Response.json(
    { error: message, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

function hoursFrom(seconds: number): string {
  const hours = Math.ceil(seconds / 3600);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Body must be a JSON object.");
    }

    const { address } = body;
    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    const recipient = address as Address;
    const now = Date.now();
    const addressKey = `faucet:address:${recipient.toLowerCase()}`;

    // 1. Treasury floor first, because it is a pure read: checking it before
    //    anything is reserved means the common refusal needs no cleanup.
    //    In-app balance is a claim on real Arc USDC, so the faucet must not
    //    write claims the treasury cannot honour.
    let treasuryUusdc: bigint;
    try {
      treasuryUusdc = await treasuryUsdcBalanceUusdc();
    } catch (err) {
      return serverFailure(SCOPE, err, {
        status: 503,
        message:
          "Could not read the treasury balance, so no faucet grant was made.",
      });
    }
    if (!treasuryCanCover(treasuryUusdc, FAUCET_GRANT_UUSDC)) {
      return jsonError(
        503,
        "The testnet treasury is too low to back a faucet grant right now. Nothing was credited.",
      );
    }

    // 2. One grant per address per window, reserved atomically so two
    //    simultaneous requests for the same address cannot both pass.
    const perAddress = await claimOncePerWindow(
      addressKey,
      FAUCET_COOLDOWN_MS,
      now,
    );
    if (perAddress.kind === "deny") {
      return tooManyRequests(
        `This address already claimed from the faucet. Try again in about ${hoursFrom(perAddress.retryAfterSeconds)}.`,
        perAddress.retryAfterSeconds,
      );
    }

    // 3. Global budget across every address. This is the guard that actually
    //    bounds a scripted attack, since fresh addresses are free.
    const budget = await spendFromWindow(
      GLOBAL_BUDGET_KEY,
      FAUCET_GRANT_UUSDC,
      FAUCET_DAILY_BUDGET_UUSDC,
      FAUCET_COOLDOWN_MS,
      now,
    );
    if (budget.kind === "deny") {
      await releaseOncePerWindow(addressKey, FAUCET_COOLDOWN_MS, now);
      return tooManyRequests(
        `The faucet has handed out its ${formatUsdc(FAUCET_DAILY_BUDGET_UUSDC)} USDC for today. Try again tomorrow.`,
        budget.retryAfterSeconds,
      );
    }

    // 4. Credit under a server-derived ref. Two taps in the same window
    //    produce the same ref, so the ledger applies exactly one of them even
    //    if the reservation above were somehow bypassed. The ledger lock is
    //    what stops this write from clobbering a concurrent debit elsewhere:
    //    the ledger is one JSON blob with no compare-and-swap, so every
    //    mutation of it has to be serialised.
    let applied: boolean;
    try {
      const outcome = await withLock(LEDGER_LOCK, () =>
        credit(recipient, FAUCET_GRANT_UUSDC, faucetClaimRef(recipient, now)),
      );
      if (outcome.kind === "busy") {
        await releaseOncePerWindow(addressKey, FAUCET_COOLDOWN_MS, now);
        await releaseFromWindow(
          GLOBAL_BUDGET_KEY,
          FAUCET_GRANT_UUSDC,
          FAUCET_COOLDOWN_MS,
          now,
        );
        return jsonError(
          503,
          "Another balance operation is in progress. Nothing was granted; try again in a moment.",
        );
      }
      applied = outcome.value.applied;
    } catch (err) {
      // Nothing was granted, so hand both reservations back.
      await releaseOncePerWindow(addressKey, FAUCET_COOLDOWN_MS, now);
      await releaseFromWindow(
        GLOBAL_BUDGET_KEY,
        FAUCET_GRANT_UUSDC,
        FAUCET_COOLDOWN_MS,
        now,
      );
      return serverFailure(SCOPE, err, {
        status: 503,
        message: "Could not credit the faucet grant, so nothing was granted.",
      });
    }

    // The ledger deduped this window's ref, so no balance moved. Give the
    // budget back rather than silently burning it.
    if (!applied) {
      await releaseFromWindow(
        GLOBAL_BUDGET_KEY,
        FAUCET_GRANT_UUSDC,
        FAUCET_COOLDOWN_MS,
        now,
      );
    }

    const balance = await getBalance(recipient);
    return Response.json({
      balanceUusdc: balance.toString(),
      grantedUusdc: applied ? FAUCET_GRANT_UUSDC.toString() : "0",
      applied,
    });
  } catch (err) {
    return serverFailure(SCOPE, err);
  }
}
