// Design tokens mirrored 1:1 from app/globals.css so the video is pixel-identical
// to the live product. Color roles are load-bearing and honest:
//   gold  = money in motion ONLY (a payout landing, the agent's live spend).
//           Never a static balance, never a verdict, never a generic highlight.
//   emerald = trust / verification / water.
//   coral   = people / human celebration. Never on a number, never a verdict.
//   warning (amber) = self-reported / unverified. Deliberately NOT gold.
export const theme = {
  background: "#faf6ee", // warm cream canvas
  surface: "#ffffff",
  surfaceRaised: "#fffdf8",
  border: "#ece3d2",
  foreground: "#16211b",
  muted: "#5f6f64",
  accent: "#10b981", // emerald - trust
  accentStrong: "#059669",
  accentDeep: "#064e3b",
  coral: "#ff8a5c", // people
  coralStrong: "#f06d3a",
  danger: "#ef4444",
  warning: "#b45309", // self-reported / unverified (never gold)
  gold: "#f3b13c", // MONEY IN MOTION ONLY
  goldStrong: "#eaa11f",
  goldDeep: "#a9760c", // legible money text on cream
} as const;

// Confetti palette matches components/Confetti.tsx exactly: coral + emerald only.
// The burst is NEVER gold - gold lives strictly on the coin and the amount,
// which are the things that actually moved.
export const confettiColors = [
  theme.coral,
  theme.coralStrong,
  theme.accent,
  theme.accentStrong,
] as const;
