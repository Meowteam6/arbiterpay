"use client";

import { useState, useCallback } from "react";
import { maxUint256, type Address, type Hash } from "viem";
import {
  erc20Abi,
  getArcPublicClient,
  getHealthPoolsAddress,
  healthPoolsAbi,
  USDC_ADDRESS,
} from "@/lib/contract";
import { humanizeTxError } from "@/lib/tx-errors";
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
}

export function useUsdcDeposit(): UseUsdcDepositResult {
  const { getArcWalletClient } = useEmbeddedWallet();
  const [status, setStatus] = useState<DepositStatus>({ kind: "idle" });

  const reset = useCallback(() => setStatus({ kind: "idle" }), []);

  const runUsdcDeposit = useCallback(
    async (amount: bigint, call: DepositCall): Promise<Hash> => {
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

      try {
        const walletClient = await getArcWalletClient();
        const publicClient = getArcPublicClient();
        const owner = walletClient.account.address;

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
          await publicClient.waitForTransactionReceipt({ hash: approveHash });
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
        await publicClient.waitForTransactionReceipt({ hash: depositHash });

        setStatus({ kind: "done", approveHash, depositHash });
        return depositHash;
      } catch (err) {
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

  return { status, busy, reset, runUsdcDeposit };
}
