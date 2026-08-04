// POST /api/balance/withdraw
//   (file path: app/app/api/balance/withdraw/route.ts -> route /api/balance/withdraw)
//
// Move USDC from a user's in-app GoHealthMe balance onto Arc as spendable USDC.
// The ledger is debited first, then the treasury delivers the same amount of
// Arc USDC to the user's wallet so the existing join/fund/back flows can pull
// from it. Keeping the user as the on-chain payer means no contract change and
// no participant-identity confusion.
//
// THIS IS THE ONLY MONEY-OUT ROUTE. It signs with TREASURY_PRIVATE_KEY and
// sends real Arc USDC, and like the rest of the balance surface it is
// unauthenticated: anyone who can make an address hold in-app balance can call
// it. Two guards bound that by construction:
//   - a per-address rate window, so one address cannot move more than
//     WITHDRAW_DAILY_CAP_UUSDC per WITHDRAW_WINDOW_MS. The reservation is
//     ATOMIC (see app/app/api/_money/rate-limit.ts): a read-then-write counter
//     would let simultaneous requests both read the same total, both conclude
//     they were under the cap, and both pay out.
//   - a treasury floor, so a transfer that would leave the shared testnet
//     treasury below TREASURY_FLOOR_UUSDC is REFUSED rather than attempted.
// Refusing is the correct answer: a drained treasury breaks settlement for
// every other flow, and an honest 429 or 503 beats a reverted transfer.
//
// Idempotent by a client-supplied ref. The ref is safe to trust here in a way
// it was not on the faucet: it can only ever suppress a repeat withdrawal, it
// can never authorize an extra one.
//
// Ordering on the money path: reserve the cap -> debit -> transfer. Reserving
// first means a crash costs the caller this window's allowance, never the
// treasury its funds. Every exit after the reservation releases it, and a
// failed transfer refunds the debit. Nothing reports success unless the
// transfer actually landed, and no failure is swallowed: if a refund itself
// fails, the response says so rather than claiming money came back.
//
// Request JSON:
//   { address: string, amountUusdc: number|string, ref: string }
//
// Response JSON:
//   200 { txHash: string, balanceUusdc: string }
//   400 bad input or insufficient balance | 409 already processed
//   429 over the daily cap (with Retry-After) | 502 transfer failed
//   503 treasury floor or ledger unavailable | 500 unexpected

import { isAddress, type Address } from "viem";
import { credit, debit, getBalance } from "@/lib/server/balance";
import { sponsorUsdc } from "@/lib/server/treasury";
import { jsonError, readJsonBody } from "@/lib/server/http";
import { formatUsdc } from "@/lib/contract";
import {
  WITHDRAW_DAILY_CAP_UUSDC,
  WITHDRAW_WINDOW_MS,
  serverFailure,
  treasuryCanCover,
} from "@/lib/money-guards";
import { treasuryUsdcBalanceUusdc } from "@/app/api/_money/treasury-balance";
import {
  LEDGER_LOCK,
  releaseFromWindow,
  spendFromWindow,
  withLock,
} from "@/app/api/_money/rate-limit";

// viem signing and the Arc RPC reads need the Node runtime.
export const runtime = "nodejs";

const SCOPE = "api/balance/withdraw";

function parseAmountUusdc(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) return null;
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  }
  return null;
}

/**
 * Undo a debit for a move that did not happen. Returns whether the balance
 * actually came back: a failed refund is the one outcome where the caller is
 * genuinely out of pocket, so it must never be reported as if it succeeded.
 */
async function refundDebit(
  address: Address,
  amountUusdc: bigint,
  ref: string,
): Promise<boolean> {
  try {
    // Under the ledger lock, like every other mutation of the blob.
    const outcome = await withLock(LEDGER_LOCK, () =>
      credit(address, amountUusdc, `${ref}:refund`),
    );
    if (outcome.kind === "busy") {
      throw new Error("Could not take the ledger lock to refund the debit");
    }
    return true;
  } catch (err) {
    console.error(
      `[${SCOPE}] REFUND FAILED for ${address} amount=${amountUusdc.toString()} ref=${ref}`,
      err,
    );
    return false;
  }
}

/** Message for a failed move, honest about whether the refund landed. */
function failedMoveMessage(lead: string, refunded: boolean): string {
  return refunded
    ? `${lead} Your balance was refunded.`
    : `${lead} Refunding your balance also failed, so it is still debited and we are looking into it.`;
}

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonError(400, "Body must be a JSON object.");
    }

    const { address, amountUusdc, ref } = body;

    if (typeof address !== "string" || !isAddress(address)) {
      return jsonError(400, "address must be a valid 0x address");
    }
    if (typeof ref !== "string" || ref.trim() === "") {
      return jsonError(400, "ref must be a non-empty idempotency string");
    }
    const amount = parseAmountUusdc(amountUusdc);
    if (amount === null) {
      return jsonError(400, "amountUusdc must be a positive integer");
    }

    const recipient = address as Address;
    const now = Date.now();
    const capKey = `withdraw:${recipient.toLowerCase()}`;

    // 1. Enough in-app balance? A cheap early rejection only. It is NOT the
    //    authority: the check that counts happens under the ledger lock in
    //    step 4, together with the debit, because a check and a debit that are
    //    not atomic with each other are exactly how a double spend gets in.
    const held = await getBalance(recipient);
    if (held < amount) {
      return jsonError(
        400,
        `Insufficient balance. This address holds ${formatUsdc(held)} USDC.`,
      );
    }

    // 2. Treasury floor. A pure read, so checking it before the reservation
    //    means the common refusal needs no cleanup. Refuse rather than attempt
    //    a transfer that would drain the shared testnet treasury.
    let treasuryUusdc: bigint;
    try {
      treasuryUusdc = await treasuryUsdcBalanceUusdc();
    } catch (err) {
      return serverFailure(SCOPE, err, {
        status: 503,
        message:
          "Could not read the treasury balance, so nothing was moved and your balance is unchanged.",
      });
    }
    if (!treasuryCanCover(treasuryUusdc, amount)) {
      return jsonError(
        503,
        "The testnet treasury cannot cover this transfer right now. Nothing was moved and your balance is unchanged.",
      );
    }

    // 3. Reserve against the per-address daily cap, atomically and BEFORE any
    //    money moves.
    const capped = await spendFromWindow(
      capKey,
      amount,
      WITHDRAW_DAILY_CAP_UUSDC,
      WITHDRAW_WINDOW_MS,
      now,
    );
    if (capped.kind === "deny") {
      const hours = Math.ceil(capped.retryAfterSeconds / 3600);
      return Response.json(
        {
          error:
            `Daily limit reached. An address can move ${formatUsdc(WITHDRAW_DAILY_CAP_UUSDC)} USDC to Arc per day and ` +
            `${formatUsdc(capped.remainingUusdc)} USDC of that is left. Try again in about ${hours} hour${hours === 1 ? "" : "s"}.`,
          remainingUusdc: capped.remainingUusdc.toString(),
          retryAfterSeconds: capped.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(capped.retryAfterSeconds) },
        },
      );
    }

    // 4. Debit, idempotent by ref, under the ledger lock so the balance read
    //    inside debit() and the write that follows it cannot interleave with
    //    another request. Without this, two callers holding distinct refs both
    //    read the same balance, both debit, one debit is lost to the other's
    //    write, and BOTH transfers land: a double spend the cap above cannot
    //    see. Every exit from here on releases the cap reservation.
    let debited;
    try {
      const outcome = await withLock(LEDGER_LOCK, () =>
        debit(recipient, amount, ref),
      );
      if (outcome.kind === "busy") {
        await releaseFromWindow(capKey, amount, WITHDRAW_WINDOW_MS, now);
        return jsonError(
          409,
          "Another balance operation is in progress. Nothing was moved; try again in a moment.",
        );
      }
      debited = outcome.value;
    } catch (err) {
      await releaseFromWindow(capKey, amount, WITHDRAW_WINDOW_MS, now);
      // debit() throws on insufficient balance too, which the step 1 precheck
      // usually catches; reaching here means the balance changed underneath us
      // or the store failed. Either way nothing moved.
      return serverFailure(SCOPE, err, {
        status: 503,
        message:
          "Could not reserve your balance for this withdrawal. Nothing was moved.",
      });
    }
    if (!debited.applied) {
      // This exact ref was already processed, so no new money is owed and the
      // allowance this call reserved must go back.
      await releaseFromWindow(capKey, amount, WITHDRAW_WINDOW_MS, now);
      return jsonError(409, "This withdrawal was already processed.");
    }

    // 5. Deliver spendable USDC on Arc. On any failure refund the debit and
    //    release the allowance, so a failed move costs the caller nothing.
    let txHash: string;
    try {
      txHash = await sponsorUsdc(recipient, amount);
    } catch (err) {
      const refunded = await refundDebit(recipient, amount, ref);
      await releaseFromWindow(capKey, amount, WITHDRAW_WINDOW_MS, now);
      return serverFailure(SCOPE, err, {
        status: 502,
        message: failedMoveMessage(
          "The treasury transfer did not go through, so nothing moved on Arc.",
          refunded,
        ),
      });
    }

    const balance = await getBalance(recipient);
    return Response.json({ txHash, balanceUusdc: balance.toString() });
  } catch (err) {
    return serverFailure(SCOPE, err);
  }
}
