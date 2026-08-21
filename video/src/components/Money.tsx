// The money mark. Gold, mono, tabular, held STILL - it lands and stays. There is
// deliberately no count-up: a count-up reads as a slot machine / wager, and this
// product is reward-not-wager. The amount is the truth of what moved, shown whole.
import React from "react";
import { monoFamily } from "../fonts";
import { theme } from "../theme";

export const Money: React.FC<{ amount: string; size?: number; deep?: boolean }> = ({
  amount,
  size = 120,
  deep = false,
}) => (
  <span
    style={{
      fontFamily: monoFamily,
      fontVariantNumeric: "tabular-nums",
      fontWeight: 600,
      fontSize: size,
      lineHeight: 1,
      color: deep ? theme.goldDeep : theme.gold,
      letterSpacing: -1,
    }}
  >
    <span style={{ fontSize: size * 0.5, verticalAlign: "text-top", marginRight: 2 }}>$</span>
    {amount}
    <span style={{ fontSize: size * 0.28, marginLeft: 10, color: theme.goldDeep, letterSpacing: 1 }}>USDC</span>
  </span>
);
