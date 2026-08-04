import { tryMarkClaimed, unmarkClaimed } from "@/lib/server/claims";

export interface PayoutTreasury {
  deposit(args: { token: string; amount: string }): Promise<unknown>;
  transfer(args: { token: string; amount: string; recipientAddress: string }): Promise<unknown>;
}
export interface PayoutResult { status: "paid" | "already-claimed"; }

/**
 * deposit()/transfer() return a fire-and-forget TransactionHandle; awaiting the
 * call only confirms submission. We must wait for the op to reach a terminal
 * status before the next step, or the transfer runs before the deposit settles
 * ("insufficient balance: have 0"). Test fakes resolve to plain values with no
 * `wait`, so this is a no-op for them.
 */
async function settle(op: Promise<unknown>): Promise<void> {
  const handle = await op;
  if (
    handle !== null &&
    typeof handle === "object" &&
    typeof (handle as { wait?: unknown }).wait === "function"
  ) {
    await (handle as { wait: () => Promise<unknown> }).wait();
  }
}

/**
 * Deliver a reward privately. Marks claimed BEFORE moving funds as an optimistic
 * lock against concurrent double-pay, then rolls the lock back if the deposit or
 * transfer fails — so a transient failure never locks the reward forever.
 * Treasury deposits into its own shielded balance, then privately transfers to the
 * participant — the deposit->transfer pair is what breaks the goal<->recipient link.
 */
export async function runPrivatePayout(args: {
  goalId: string;
  recipientUnlinkAddress: string;
  amountBaseUnits: string;
  token: string;
  treasury: PayoutTreasury;
}): Promise<PayoutResult> {
  // Claim-or-lose in one atomic step. The old shape read then wrote, so two
  // concurrent payouts for the same goal could both see "unclaimed" and both
  // pay. Losing the race is an expected outcome, not an error: the winner is
  // paying, so this caller reports already-claimed rather than throwing a 500
  // at a user whose money is on its way.
  if (!(await tryMarkClaimed(args.goalId))) return { status: "already-claimed" };
  try {
    await settle(args.treasury.deposit({ token: args.token, amount: args.amountBaseUnits }));
    await settle(
      args.treasury.transfer({
        token: args.token,
        amount: args.amountBaseUnits,
        recipientAddress: args.recipientUnlinkAddress,
      }),
    );
  } catch (err) {
    // Release the lock so the user can retry once the underlying issue is fixed.
    await unmarkClaimed(args.goalId);
    throw err;
  }
  return { status: "paid" };
}
