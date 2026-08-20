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

/**
 * Opt-in guard against a browser wallet silently hijacking the session.
 *
 * When "1", providers.tsx installs a handleConnectedWallet handler that vetoes
 * a non-embedded (injected/external) wallet connection unless the user
 * deliberately chose to connect one (see lib/wallet-connect-intent.ts). The
 * embedded email wallet always passes. This stops Dynamic from auto-reconnecting
 * an already-approved MetaMask on page load and quietly making it the session.
 *
 * Default OFF. It is an auth-path change and this app's sign-in has regressed
 * before, so it ships inert until the auto-reconnect is reproduced in a real
 * browser. When unset the handler is never installed and provider behaviour is
 * byte-for-byte unchanged. Enabling it makes external-wallet users re-tap
 * "Connect your own wallet" after every full page reload, which is the
 * deliberate tradeoff for closing the hijack.
 */
export const GUARD_INJECTED_WALLET: boolean =
  (process.env.NEXT_PUBLIC_GUARD_INJECTED_WALLET ?? "") === "1";
