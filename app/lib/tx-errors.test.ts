import { describe, it, expect } from "vitest";
import {
  humanizeTxError,
  canCoverJoinCosts,
  JOIN_GAS_MARGIN,
} from "@/lib/tx-errors";

// Realistic viem error shapes. viem nests the useful text (revert reason,
// node message) in `cause`, and the top-level message carries the multi-line
// "Request Arguments ... Version: viem@2.x" dump that must never render as
// the primary message.

function viemError(message: string, cause?: Error): Error {
  const err = new Error(message);
  if (cause !== undefined) {
    (err as Error & { cause?: unknown }).cause = cause;
  }
  return err;
}

const INSUFFICIENT_FUNDS_FIXTURE = [
  "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.",
  "",
  "Estimate Gas Arguments:",
  "  from:  0x8ba1f109551bD432803012645Ac136ddd64DBA72",
  "  to:    0xc4274eF2cBe28f77Af31b980055Cc1171818390C",
  "  data:  0x3b3546c80000000000000000000000000000000000000000000000000000000000000001",
  "",
  "Details: insufficient funds for gas * price + value: balance 0, tx cost 420000000000000, overshot 420000000000000",
  "Version: viem@2.52.0",
].join("\n");

const REVERT_FIXTURE = (reason: string) =>
  [
    `The contract function "joinPool" reverted with the following reason:`,
    reason,
    "",
    "Contract Call:",
    "  address:   0xc4274eF2cBe28f77Af31b980055Cc1171818390C",
    "  function:  joinPool(uint256 poolId, uint256 nullifierHash)",
    "  args:      (1, 79228162514264337593543950336)",
    "  sender:    0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "",
    "Docs: https://viem.sh/docs/contract/writeContract",
    "Version: viem@2.52.0",
  ].join("\n");

const USER_REJECTED_FIXTURE = [
  "User rejected the request.",
  "",
  "Details: MetaMask Tx Signature: User denied transaction signature.",
  "Version: viem@2.52.0",
].join("\n");

describe("humanizeTxError", () => {
  it("maps PERIOD_ENDED to the joining-closed message", () => {
    const result = humanizeTxError(viemError(REVERT_FIXTURE("PERIOD_ENDED")));
    expect(result.title).toBe("Joining is closed");
    expect(result.detail).toBe(
      "This pool's period has ended - joining is closed.",
    );
  });

  it("maps ALREADY_JOINED to the already-joined message", () => {
    const result = humanizeTxError(viemError(REVERT_FIXTURE("ALREADY_JOINED")));
    expect(result.title).toBe("Already in");
    expect(result.detail).toBe("This wallet already joined this pool.");
  });

  it("maps NULLIFIER_USED to the entry-used message", () => {
    const result = humanizeTxError(viemError(REVERT_FIXTURE("NULLIFIER_USED")));
    expect(result.title).toBe("Entry already used");
    expect(result.detail).toBe(
      "This entry was already used to join this pool - one wallet, one entry.",
    );
  });

  it("maps the viem insufficient-funds dump to the funding message", () => {
    const result = humanizeTxError(viemError(INSUFFICIENT_FUNDS_FIXTURE));
    expect(result.title).toBe("Not enough USDC");
    expect(result.detail).toContain("Arc testnet pays gas in USDC");
    expect(result.detail).toContain("faucet.circle.com");
    expect(result.detail).not.toContain("viem");
  });

  it("maps the bare node insufficient-funds message", () => {
    const result = humanizeTxError(
      viemError("insufficient funds for gas * price + value"),
    );
    expect(result.title).toBe("Not enough USDC");
  });

  it("maps an ERC-20 balance revert to the funding message", () => {
    const result = humanizeTxError(
      viemError(REVERT_FIXTURE("ERC20: transfer amount exceeds balance")),
    );
    expect(result.title).toBe("Not enough USDC");
  });

  it("maps a user rejection to the cancelled message", () => {
    const result = humanizeTxError(viemError(USER_REJECTED_FIXTURE));
    expect(result.title).toBe("Transaction cancelled");
    expect(result.detail).toBe("You cancelled the transaction.");
  });

  it("finds the revert reason nested in the cause chain", () => {
    const inner = viemError("execution reverted: ALREADY_JOINED");
    const outer = viemError("Transaction failed.", inner);
    const result = humanizeTxError(outer);
    expect(result.title).toBe("Already in");
    // raw stays the top-level message, untouched.
    expect(result.raw).toBe("Transaction failed.");
  });

  it("does not confuse ALREADY_SETTLED with ALREADY_JOINED", () => {
    const result = humanizeTxError(
      viemError(REVERT_FIXTURE("ALREADY_SETTLED")),
    );
    expect(result.title).toBe("Pool already settled");
  });

  it("maps a bare SETTLED revert to the settled message", () => {
    const result = humanizeTxError(viemError(REVERT_FIXTURE("SETTLED")));
    expect(result.title).toBe("Pool already settled");
  });

  it("keeps the first line of configuration errors as the detail", () => {
    const result = humanizeTxError(
      new Error(
        "HealthPools contract address is not configured. Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS.",
      ),
    );
    expect(result.title).toBe("App is not configured");
    expect(result.detail).toContain("NEXT_PUBLIC_HEALTH_POOLS_ADDRESS");
  });

  it("maps a missing wallet to the not-connected message", () => {
    const result = humanizeTxError(
      new Error("No EVM wallet connected. Sign in first."),
    );
    expect(result.title).toBe("Wallet not connected");
  });

  it("preserves the full raw viem text verbatim", () => {
    const result = humanizeTxError(viemError(INSUFFICIENT_FUNDS_FIXTURE));
    expect(result.raw).toBe(INSUFFICIENT_FUNDS_FIXTURE);
    expect(result.raw).toContain("Version: viem@2.52.0");
  });

  it("falls back to a generic line for unknown errors", () => {
    const result = humanizeTxError(new Error("gremlins in the mempool"));
    expect(result.title).toBe("Transaction failed");
    expect(result.detail).toBe(
      "Something went wrong while sending the transaction. Try again in a moment.",
    );
    expect(result.raw).toBe("gremlins in the mempool");
  });

  it("handles thrown strings", () => {
    const result = humanizeTxError("User rejected the request.");
    expect(result.title).toBe("Transaction cancelled");
    expect(result.raw).toBe("User rejected the request.");
  });

  it("handles thrown non-Error objects and nullish values", () => {
    expect(humanizeTxError({ code: -32603 }).title).toBe("Transaction failed");
    expect(humanizeTxError({ code: -32603 }).raw).toBe('{"code":-32603}');
    expect(humanizeTxError(null).title).toBe("Transaction failed");
    expect(humanizeTxError(undefined).title).toBe("Transaction failed");
  });
});

describe("canCoverJoinCosts", () => {
  it("rejects a zero balance even for a free pool", () => {
    expect(canCoverJoinCosts(0n, 0n)).toBe(false);
  });

  it("accepts a balance exactly covering fee plus margin", () => {
    const entryFee = 5_000_000n; // 5 USDC
    expect(canCoverJoinCosts(entryFee + JOIN_GAS_MARGIN, entryFee)).toBe(true);
  });

  it("rejects a balance one unit below fee plus margin", () => {
    const entryFee = 5_000_000n;
    expect(canCoverJoinCosts(entryFee + JOIN_GAS_MARGIN - 1n, entryFee)).toBe(
      false,
    );
  });

  it("accepts a comfortable balance for a free pool", () => {
    expect(canCoverJoinCosts(10_000_000n, 0n)).toBe(true);
  });

  it("rejects a balance covering the fee but not the gas margin", () => {
    const entryFee = 5_000_000n;
    expect(canCoverJoinCosts(entryFee, entryFee)).toBe(false);
  });

  it("honours a custom gas margin", () => {
    expect(canCoverJoinCosts(100n, 0n, 100n)).toBe(true);
    expect(canCoverJoinCosts(99n, 0n, 100n)).toBe(false);
  });
});
