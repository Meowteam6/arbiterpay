// USDC is 6 decimals on Arc. All SDK boundaries use base-unit strings.
import { parseUnits } from "viem";

export const USDC_DECIMALS = 6 as const;

export function toBaseUnits(amount: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(amount.trim())) {
    throw new Error(
      `Invalid USDC amount "${amount}": max ${USDC_DECIMALS} decimal places`,
    );
  }
  return parseUnits(amount.trim(), USDC_DECIMALS).toString();
}
