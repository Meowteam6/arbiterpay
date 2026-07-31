/**
 * Build-time client configuration. NEXT_PUBLIC_ values are inlined by Next
 * at build time, so these flags let components render visible configuration
 * errors instead of crashing when an integration is not wired up yet.
 */

export const DYNAMIC_CONFIGURED: boolean =
  (process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? "") !== "";
