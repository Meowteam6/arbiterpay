// Pick the SPOTTER pose whose action matches a pool's PUBLIC goal, so the card's
// icon slot IS the otter doing the thing the goal describes (flu shot, dental, ...).
//
// PRIVACY: only ever call this on a public pool OFFER (PoolCard / PoolDetail),
// never on a payout or win surface. A pool's goal is public by design, but an
// individual's completed win must stay category-neutral (see NamedPayoutFeed /
// profile-paid-wall: "the health category is never shown"). Mapping a win to an
// action pose would leak that category.

export type GoalPose = "flushot" | "screening" | "checkup" | "dental" | "greet";

// Order matters: the most specific match wins. "greet" is the neutral fallback
// for any goal we don't have a bespoke pose for yet.
const RULES: ReadonlyArray<readonly [GoalPose, RegExp]> = [
  ["flushot", /\b(flu|influenza|vaccin|vaxx?|immuniz|shot|jab|booster)/i],
  ["dental", /\b(dental|dentist|teeth|tooth|floss|cleaning)/i],
  ["screening", /\b(screen|biometric|blood[\s-]?pressure|\bbmi\b|glucose|cholesterol|lipid|a1c|lab[\s-]?(work|panel|test))/i],
  ["checkup", /\b(physical|check[\s-]?up|annual|wellness|preventive|primary[\s-]?care|doctor|visit)/i],
];

/**
 * Resolve a pool's public goal text to a SPOTTER pose asset key.
 * @param initiative the pool's short public label/tag
 * @param goalSpec the pool's public goal spec string
 * @returns a pose key; assets live at /spotter/spotter-<pose>.png
 */
export function otterPoseForGoal(initiative: string, goalSpec: string): GoalPose {
  const haystack = `${initiative} ${goalSpec}`;
  for (const [pose, pattern] of RULES) {
    if (pattern.test(haystack)) return pose;
  }
  return "greet";
}
