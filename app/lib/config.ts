/**
 * Build-time client configuration. NEXT_PUBLIC_ values are inlined by Next
 * at build time, so these flags let components render visible configuration
 * errors instead of crashing when an integration is not wired up yet.
 */

export const DYNAMIC_CONFIGURED: boolean =
  (process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? "") !== "";

/**
 * Cosmetic-only switch for recorded demo runs.
 *
 * When "1", the operator-facing configuration banners (the amber "Dynamic is
 * not configured" strip) are suppressed so demo footage shows the product, not
 * the deployment checklist. STRICTLY presentation: every behavioral fallback —
 * DYNAMIC_CONFIGURED short-circuits, the join panel's honest "Sign-in is not
 * configured" refusal — is untouched, so a demo build can never pretend an
 * integration exists. Unset everywhere except the e2e demo profile.
 */
export const DEMO_CHROME: boolean =
  (process.env.NEXT_PUBLIC_DEMO_CHROME ?? "") === "1";
