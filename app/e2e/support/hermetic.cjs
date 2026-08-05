// Preloaded into the `next dev` process by playwright.config.ts so that a test
// run makes NO request beyond 127.0.0.1 — not even from tooling.
//
// The app's own upstreams are redirected by env (ARC_RPC_URL and friends), but
// two fetches in the dev-server process belong to nobody's config:
//
//   - Next's dev hot-reloader asks registry.npmjs.org for the latest version
//     once a browser connects, with no env switch to turn it off.
//   - The Dynamic SDK's server-side render fetches its wallet-book from
//     dynamic-static-assets.com even with no environment id configured. (The
//     browser-side copy of that fetch is aborted by page.route in
//     support/test.ts; this catches the SSR copy.)
//
// Both callers treat a failed response as a non-event, so this answers them
// locally with 501 instead of letting a socket open. Deny-by-name, not
// allow-loopback-only: an UNKNOWN external call must stay visible to the
// adversarial network guard (below) rather than be silently swallowed here.
//
// CHAINING: Next re-serialises NODE_OPTIONS when it re-execs its dev server
// and collapses a repeated --require into one broken path, so this file must
// be the single preload. An external guard (the enforced hermeticity check
// preloads a DNS/TCP/fetch recorder) rides in through E2E_PRELOAD instead,
// loaded first so its instrumentation sits under this filter.

"use strict";

if (process.env.E2E_PRELOAD) {
  require(process.env.E2E_PRELOAD);
}

const STUBBED_HOSTS = ["registry.npmjs.org", "dynamic-static-assets.com"];

function isStubbed(url) {
  try {
    const host = new URL(url).hostname;
    return STUBBED_HOSTS.some(
      (blocked) => host === blocked || host.endsWith(`.${blocked}`),
    );
  } catch {
    return false;
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input && input.url) || "";
  if (isStubbed(url)) {
    return Promise.resolve(
      new Response("", { status: 501, statusText: "hermetic e2e run" }),
    );
  }
  return originalFetch.call(this, input, init);
};
