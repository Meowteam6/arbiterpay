"use client";

import { useState, useCallback } from "react";
import { maxUint256, type Address, type Hash } from "viem";
import {
  erc20Abi,
  formatUsdc,
  getArcPublicClient,
  getHealthPoolsAddress,
  healthPoolsAbi,
  USDC_ADDRESS,
} from "@/lib/contract";
import {
  canCoverUsdcCosts,
  fundingShortfallDetail,
  humanizeTxError,
  JOIN_GAS_MARGIN,
} from "@/lib/tx-errors";
import { useEmbeddedWallet } from "@/lib/wallet";

/**
 * SWAP POINT: Blink + Gateway deposit replaces this approve+write step
 * (see notes/Blink Integration Brief.md).
 *
 * Every USDC-pulling contract call in the app (createPool initialFunding,
 * fundPool top-up, backGoal stake) funnels through runUsdcDeposit below.
 * On Saturday the two-step "approve USDC then call the contract" flow gets
 * replaced by a single Blink one-tap deposit (Blink-on-Base + Circle Gateway
 * minting USDC straight onto Arc). Isolating it here means the Blink swap
 * touches THIS file only, not CreatePool / FundPool / BackGoal.
 */

/** The contract write that consumes the approved USDC, by name + args. */
export type DepositCall =
  | {
      functionName: "createPool";
      args: readonly [
        string,
        string,
        bigint,
        bigint,
        bigint,
        number,
        bigint,
      ];
    }
  | { functionName: "fundPool"; args: readonly [bigint, bigint] }
  | { functionName: "backGoal"; args: readonly [bigint, Address, bigint] };

export type DepositStatus =
  | { kind: "idle" }
  | { kind: "approving" }
  | { kind: "depositing" }
  // approveHash is null when a prior (max) approval was reused — no approve tx.
  | { kind: "done"; approveHash: Hash | null; depositHash: Hash }
  // message is the one-line human detail; raw carries the untouched wallet
  // error text for a collapsed technical-details view (empty when the error
  // originated here rather than in a wallet or contract call).
  | { kind: "error"; message: string; raw?: string };

/**
 * What the balance preflight found when the wallet cannot afford the deposit.
 * Everything a FundingHelp card needs, so a consumer can render the funding
 * affordance instead of only the one-line message on DepositStatus.
 */
export interface DepositFundingGap {
  address: Address;
  /** Wallet USDC balance, 6-decimal base units. */
  balance: bigint;
  /** Deposit amount plus the gas margin, 6-decimal base units. */
  needed: bigint;
}

export interface UseUsdcDepositResult {
  status: DepositStatus;
  busy: boolean;
  reset: () => void;
  /**
   * Pull `amount` USDC from the signed-in wallet by approving the HealthPools
   * contract, then invoke the supplied contract call. Resolves with the
   * deposit tx hash on success and throws on failure (caller surfaces it).
   */
  runUsdcDeposit: (amount: bigint, call: DepositCall) => Promise<Hash>;
  /**
   * Additive. Set when the preflight found the wallet short of funds, cleared
   * on every new attempt and on reset. Render <FundingHelp> from it; the same
   * shortfall also lands in status.message so surfaces that only read the
   * frozen {status, busy, reset, runUsdcDeposit} shape still say something
   * useful instead of dumping a raw wallet error.
   */
  needsFunds: DepositFundingGap | null;
}

export function useUsdcDeposit(): UseUsdcDepositResult {
  const { getArcWalletClient } = useEmbeddedWallet();
  const [status, setStatus] = useState<DepositStatus>({ kind: "idle" });
  const [needsFunds, setNeedsFunds] = useState<DepositFundingGap | null>(null);

  const reset = useCallback(() => {
    setStatus({ kind: "idle" });
    setNeedsFunds(null);
  }, []);

  const runUsdcDeposit = useCallback(
    async (amount: bigint, call: DepositCall): Promise<Hash> => {
      setNeedsFunds(null);
      const poolsAddress = getHealthPoolsAddress();
      if (poolsAddress === null) {
        const message =
          "HealthPools contract address is not configured. Set NEXT_PUBLIC_HEALTH_POOLS_ADDRESS.";
        setStatus({ kind: "error", message });
        throw new Error(message);
      }
      if (amount <= 0n) {
        const message = "Deposit amount must be greater than zero.";
        setStatus({ kind: "error", message });
        throw new Error(message);
      }

      // Set by the preflight below so the catch keeps the funding message
      // instead of relabelling it through humanizeTxError.
      let fundingGap: DepositFundingGap | null = null;

      try {
        const walletClient = await getArcWalletClient();
        const publicClient = getArcPublicClient();
        const owner = walletClient.account.address;

        // ---- Balance preflight -------------------------------------------
        // Arc pays gas in USDC, so a wallet with nothing in it cannot send
        // the approve OR the write - viem would surface a multi-line
        // insufficient-funds dump. Read the balance first and fail with the
        // funding instructions instead. Best-effort: a failed read falls
        // through and the catch below humanizes whatever the wallet throws.
        let balance: bigint | null = null;
        try {
          balance = (await publicClient.readContract({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
          })) as bigint;
        } catch {
          balance = null;
        }
        if (balance !== null && !canCoverUsdcCosts(balance, amount)) {
          fundingGap = {
            address: owner,
            balance,
            needed: amount + JOIN_GAS_MARGIN,
          };
          setNeedsFunds(fundingGap);
          setStatus({
            kind: "error",
            message: fundingShortfallDetail(
              formatUsdc(balance),
              formatUsdc(fundingGap.needed),
            ),
            raw: "",
          });
          throw new Error("Wallet balance cannot cover this deposit.");
        }

        // ---- Approve only if needed -------------------------------------
        // ERC-20 requires the pool contract to be approved before it can pull
        // USDC. We check the existing allowance first and, when an approval is
        // required, approve maxUint256 ONCE — so every later deposit reuses it
        // and skips this tx entirely (one wallet confirmation per action, not
        // two). The first-ever deposit still does approve + write.
        const allowance = (await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "allowance",
          args: [owner, poolsAddress],
        })) as bigint;

        let approveHash: Hash | null = null;
        if (allowance < amount) {
          setStatus({ kind: "approving" });
          approveHash = await walletClient.writeContract({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [poolsAddress, maxUint256],
          });
          // waitForTransactionReceipt resolves as soon as the transaction is
          // MINED - it does not throw when the transaction reverted. Reporting
          // success off the bare await would show a tx link for a transaction
          // that moved nothing, so the status is checked here and on every
          // receipt below, the same way the server paths do it.
          const approveReceipt = await publicClient.waitForTransactionReceipt({
            hash: approveHash,
          });
          if (approveReceipt.status !== "success") {
            throw new Error(
              `The USDC approval ${approveHash} reverted on Arc testnet.`,
            );
          }
        }

        // ---- The contract write that pulls USDC --------------------------
        setStatus({ kind: "depositing" });
        const depositHash = await walletClient.writeContract({
          address: poolsAddress,
          abi: healthPoolsAbi,
          // viem's union typing needs each variant narrowed; the DepositCall
          // union guarantees functionName/args line up with the ABI.
          functionName: call.functionName,
          args: call.args,
        } as Parameters<typeof walletClient.writeContract>[0]);
        const depositReceipt = await publicClient.waitForTransactionReceipt({
          hash: depositHash,
        });
        if (depositReceipt.status !== "success") {
          throw new Error(
            `The ${call.functionName} transaction ${depositHash} reverted on Arc testnet.`,
          );
        }

        setStatus({ kind: "done", approveHash, depositHash });
        return depositHash;
      } catch (err) {
        // The preflight already wrote the funding instructions into status;
        // re-humanizing would replace them with a generic failure line.
        if (fundingGap !== null) {
          throw err instanceof Error
            ? err
            : new Error("Wallet balance cannot cover this deposit.");
        }
        // Never surface viem's multi-line dump as the message. Consumers
        // render status.message in an ErrorNote; the raw text rides along
        // separately for a collapsed technical-details view.
        const human = humanizeTxError(err);
        setStatus({ kind: "error", message: human.detail, raw: human.raw });
        throw err instanceof Error ? err : new Error(human.detail);
      }
    },
    [getArcWalletClient],
  );

  const busy = status.kind === "approving" || status.kind === "depositing";

  return { status, busy, reset, runUsdcDeposit, needsFunds };
}
