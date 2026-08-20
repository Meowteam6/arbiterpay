// Records that the user DELIBERATELY chose to connect an external wallet
// (tapped "Connect your own wallet" in SignInPanel), so the provider-level
// injected-wallet guard can tell an explicit connect apart from a silent
// load-time reconnect.
//
// WHY THIS EXISTS
// walletsFilter removes MetaMask from the login modal LIST, but it does not
// stop Dynamic from auto-detecting and reconnecting an already-approved
// injected/eip6963 wallet on page load. That reconnect lands in userWallets and
// lib/wallet.ts resolves `primaryWallet ?? userWallets[0]`, so a browser that
// once approved MetaMask silently becomes the session - which is exactly what
// confused a tester. The optional guard in providers.tsx
// (handleConnectedWallet, gated on GUARD_INJECTED_WALLET) vetoes a non-embedded
// connection UNLESS the embedded wallet is connecting or this intent is set.
//
// SESSION-STICKY, NOT A TIME WINDOW
// A full page reload re-imports this module and resets the flag to false, so a
// fresh load starts with no external intent - a silent reconnect is vetoed. The
// moment the user taps to connect their own wallet, the flag stays true for the
// rest of that page session, so later refreshes the SDK triggers on a network
// or account change (the app calls switchNetwork on every transaction) do NOT
// disconnect a wallet the user deliberately connected.

let externalIntent = false;

/** Call immediately before opening the external-wallet connect flow. */
export function markExternalConnectIntent(): void {
  externalIntent = true;
}

/** True once the user has deliberately connected an external wallet this page
 *  session; false on a fresh load until they do. */
export function externalConnectIntended(): boolean {
  return externalIntent;
}
