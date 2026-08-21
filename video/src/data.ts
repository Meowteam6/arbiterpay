// Representative demo data, passed through composition props so amounts and the
// river of payouts are data-driven. Honest posture: these are testnet play-money
// USDC figures shaped to look like the real product, not claims of live volume.
// City + goal + amount only - never a real person's name or health category.

export type CurrentEntry = {
  city: string;
  goal: string; // the behavior, never a raw health metric
  amount: string; // USDC, mono gold when it lands
  verified: boolean; // false => self-reported tier, must never read "verified"
};

// THE DROP hero amount. A clean, plausible pool payout. Held STILL - no count-up.
export const dropAmount = "12.00";

// THE CURRENT - a downstream river of payouts. Verified and self-reported mixed,
// so the self-reported tier is visibly present and honestly not "verified".
export const currentEntries: CurrentEntry[] = [
  { city: "Manila", goal: "10k steps", amount: "8.00", verified: true },
  { city: "Lisbon", goal: "8h sleep", amount: "5.00", verified: true },
  { city: "Austin", goal: "3 workouts", amount: "15.00", verified: true },
  { city: "Nairobi", goal: "morning walk", amount: "4.00", verified: false },
  { city: "Seoul", goal: "dental checkup", amount: "20.00", verified: true },
  { city: "Bogotá", goal: "7h sleep", amount: "6.00", verified: true },
  { city: "Manila", goal: "evening walk", amount: "4.00", verified: false },
  { city: "Berlin", goal: "5k run", amount: "9.00", verified: true },
];

// Cross-border grandma beat: two points on the map that connect. This is the
// THESIS/vision line made literal, not a live cross-border settlement claim.
export const grandmaRoute = {
  from: { label: "you", x: 0.30, y: 0.42 },
  to: { label: "lola", x: 0.68, y: 0.55 },
};
