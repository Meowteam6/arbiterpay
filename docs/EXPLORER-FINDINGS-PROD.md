# Explorer QA — findings (REAL PRODUCTION run)

The five explorer personas were pointed at the **live production** GoHealthMe
Circle deploy, and one lighter persona at the live **Merit** site, on film.
Founder-authorized, browse-only pass (2026-08-04). No harness logic was changed:
the run just set `EXPLORER_BASE_URL` (the config's built-in seam). The Merit pass
adds one additive persona (`personas/meritai-browse.explore.ts`) that reuses the
existing `Persona` + wall fixtures unchanged.

- Harness: `app/e2e/explorer/` — `EXPLORER_BASE_URL=<url> npm run test:explore`
- Targets:
  - `https://gohealthme-circle.vercel.app` — 5 personas (browse-pools,
    join-without-wallet, document-claim-attempt, wearable-claim-attempt,
    goal-intent)
  - `https://meritai.me` — 1 lighter persona (meritai-browse)
- Raw artifacts (gitignored): `app/e2e-artifacts/explorer/` —
  `findings/*.json`, `shots/*.png`, `runs/` (always-on video + trace).

## Safety rail — HELD

The explorer ran as an anonymous visitor with the hard rail: **no wallet
connect, no signature, no card/payment, no on-chain transaction, no final
pay/settle/confirm.** Every persona STOPPED at the first auth/wallet/payment
wall and recorded it. Verified from the traces and action logs:

- On GoHealthMe, clicking **Join** / **Sign in** opened the Dynamic
  "Log in or sign up" modal (email + MetaMask / Coinbase / WalletConnect). The
  persona stopped there — **no email entered, no wallet selected, no signature,
  no transaction.** The only money-adjacent request seen was a `GET
  /api/agent/wallet` during page render; there was **no `eth_sendTransaction`,
  no Dynamic signature, no evidence/oracle POST, no Stripe/checkout.**
- On Merit, the persona reached `/signup` (email field present) and `/login`
  and STOPPED — **no credentials filled, nothing submitted.**
- Both surfaces are testnet/sandbox anyway: GoHealthMe shows an **"ARC TESTNET"**
  badge and "USDC here is testnet only and has no real value", and the Dynamic
  modal carries a **"Sandbox"** badge.

## Does the local `/pools` infinite-skeleton bug reproduce on prod? — **NO.**

The defining class-A finding of the local unconfigured run
(`docs/EXPLORER-FINDINGS.md`: `/pools` and `/pools/[id]` stuck on loading
skeletons **forever**, 0 RPC calls, `isLoading` never resolves) **does NOT
reproduce on the live GoHealthMe deploy. Pools load there.** Evidence:

- `browse-pools` saw a real pool card, **clicked it**, and reached the pool
  **detail heading** — the skeletons resolved within ~3-6s (skeletons are
  visible at 00:03 in `browse-pools-04-http-error.png`, resolved by 00:06 per
  the action log).
- `wearable-claim-attempt` and `document-claim-attempt` both opened a
  **fully-rendered** pool detail: "10,000 steps daily for 5 days (sponsored by
  Iron Gym)", tags STEPS / WEARABLE / LIVE, Funder `0xc278...04e1`, BOUNTY POOL
  0.50 USDC, ENTRY FEE 0.00 USDC, PAYOUT MODEL "Pro-rata pot split",
  PARTICIPANTS 0, a "Join this pool" panel
  (`wearable-claim-attempt-06-stuck-state.png`).
- The trace shows the list is populated by **Next.js RSC server prefetches**
  (`/pools/4,5,11,12,13,14?_rsc=…` — real pool IDs), i.e. the chain read runs on
  the Vercel server, not the browser. That is exactly why prod renders where the
  local unconfigured `next dev` did not: on prod the server is configured to
  read the chain and the pools query resolves.
- `goal-intent` hit **0 walls** — the landing goal box and "See who's paying"
  CTA worked and returned an answer, so the local A3 "CTA does not route to
  /goal" bug **also does not reproduce** on prod.

## Wall counts by class

| Surface | Personas | Raw walls | Class A | Class B | Class C |
|---|---|---|---|---|---|
| gohealthme-circle | 5 (5/5 completed) | 25 | 20 (RPC cluster = **1 distinct** live issue) | 2 (anon-gated actions) | 3 (no-op false positives) |
| meritai.me | 1 (1/1 completed) | 4 | 0 | 4 (`/pricing` 404 = 1 distinct expected gate) | 0 |

Distinct findings: **1 class-A** (live, GoHealthMe RPC), **3 class-B** gates on
GoHealthMe + **1 class-B** on Merit, **1 class-C** harness artifact.

## Findings table

| # | Persona | URL | Wall kind | What was actually seen | Class | Sev | Shot |
|---|---|---|---|---|---|---|---|
| A1 | browse-pools / join / document / wearable | `/pools`, `/pools/[id]` | console-error + network-failure + http-error(400) | browser Arc RPC reads fail: CORS on `rpc.testnet.arc.network`, HTTP 400 on `rpc.drpc.testnet.arc.network` | **A** | medium | `shots/browse-pools-04-http-error.png` |
| B1 | join / document / wearable | `/pools/[id]` | (recorded as no-op — see C1) | Dynamic "Log in or sign up" wallet-connect modal opens → **safety-rail STOP** | B | low | `shots/join-without-wallet-06-no-op-click.png` |
| B2 | document-claim / wearable | `/pools/[id]` | stuck-state | pool detail renders but the upload-proof / wearable-check action is **hidden until you join** (anon gate) | B | low | `shots/wearable-claim-attempt-06-stuck-state.png` |
| C1 | join / document / wearable | `/pools/[id]` | no-op-click | detector false positive: the Dynamic modal **did** open (B1) but renders in a portal/iframe the DOM-hash misses | C | — | `shots/document-claim-attempt-07-no-op-click.png` |
| M1 | meritai-browse | `meritai.me/pricing` | http-error(404) + error-banner | no standalone pricing page — stock Next "404 This page could not be found." | B | low | `shots/meritai-browse-01-http-error.png` |

---

## Class A — real, live product finding

### A1 — Browser-side Arc RPC reads fail (CORS + HTTP 400) on every pool page

- **Personas / intent:** browse-pools, join-without-wallet,
  document-claim-attempt, wearable-claim-attempt — anyone who opens `/pools` or a
  pool detail.
- **URL:** `https://gohealthme-circle.vercel.app/pools` and `/pools/[id]`.
- **What the console/network actually showed (verbatim):**
  - `Access to fetch at 'https://rpc.testnet.arc.network/' from origin
    'https://gohealthme-circle.vercel.app' has been blocked by CORS policy:
    Response to preflight request doesn't pass access control check: No
    'Access-Control-Allow-Origin' header is present on the requested resource.`
  - `net::ERR_FAILED on https://rpc.testnet.arc.network/`
  - `HTTP 400 on https://rpc.drpc.testnet.arc.network/`
  - `Failed to load resource: the server responded with a status of 400 ()`
- **What it means:** the client wallet/chain transport is a viem fallback across
  **three** Arc-testnet RPCs — `rpc.testnet.arc.network` (CORS-blocked from the
  browser), `rpc.drpc.testnet.arc.network` (returns 400), and
  `rpc.blockdaemon.testnet.arc.network` (the third, which is why reads still
  ultimately succeed). Two of the three configured browser RPCs are broken, so
  **every** pool page floods the console with CORS + failed-fetch + 400 errors.
- **Why it is A, not B or C:** it is not caused by any missing config and it is
  not detector noise — a real visitor's browser console shows these on the live
  site. It is currently **non-blocking** (pools render via server RSC and reads
  fall back to the blockdaemon RPC), which is why severity is medium not high —
  but on a payments product a chain transport where 2 of 3 endpoints are
  misconfigured is real fragility (if blockdaemon degrades, client reads die) and
  a poor signal in the console.
- **Fix direction:** drop or replace the CORS-broken and 400-returning RPCs, or
  proxy chain reads through a same-origin `/api/rpc` route so the browser never
  talks to a CORS-restricted endpoint.
- **Money shot:** `shots/browse-pools-04-http-error.png` @ video **00:03** (the
  `/pools` page — "ARC TESTNET", "testnet only… no real value" — at the instant
  the RPC returns 400).
- **Severity:** medium.

```
/queue repo:arbiterpay "[explorer/browse-pools+join+document+wearable] Live gohealthme-circle: 2 of 3 browser Arc-testnet RPCs are broken — rpc.testnet.arc.network is CORS-blocked (no Access-Control-Allow-Origin for the vercel origin) and rpc.drpc.testnet.arc.network returns HTTP 400, flooding the console on every /pools and /pools/[id] view. Reads still succeed via the blockdaemon fallback + server RSC, so it is non-blocking today but is real chain-transport fragility on a payments product. Drop/replace the broken RPCs or proxy chain reads through a same-origin /api/rpc." severity:medium label:reliability,web3
```

---

## Class B — expected gates (honest refusals / safety-rail stops)

### B1 — Join / Sign in open the Dynamic wallet-connect modal (the safety-rail wall)

- **Personas:** join-without-wallet, document-claim-attempt,
  wearable-claim-attempt.
- **What was seen:** clicking **Join this pool** (or the header **Sign in**)
  opens the Dynamic **"Log in or sign up"** modal — email field, MetaMask,
  Coinbase, WalletConnect, "580+ wallets", "Powered by dynamic", "Sandbox"
  badge. This is the correct auth/wallet wall and the point at which the persona
  **STOPS** per the safety rail. Unlike the local run (which showed a "Dynamic is
  not configured" banner), prod has Dynamic wired (env `3d446c7a-…`), so the real
  modal opens.
- **Class:** B (expected, working). No bug. Recorded here because it is the money
  wall the personas were built to reach — and did.
- **Shot:** `shots/join-without-wallet-06-no-op-click.png` (screenshot named
  "no-op" only because of the C1 detector quirk; the modal is clearly open).
- **Severity:** low (informational).

### B2 — Pool actions are hidden from anonymous visitors until they join

- **Personas:** document-claim-attempt (no upload-proof affordance),
  wearable-claim-attempt (no run-the-check affordance) — each recorded as a
  `stuck-state` after 12s of waiting for an action that only a joined member
  sees.
- **What was seen:** the pool detail renders fully (bounty, entry fee, payout
  model, participants, "Join this pool" panel) but the upload-proof / wearable
  claim controls are correctly **not present** for a logged-out visitor.
- **Class:** B (expected gate — you must join/sign in first). No bug.
- **Shot:** `shots/wearable-claim-attempt-06-stuck-state.png` (a clean,
  fully-loaded pool detail — doubles as proof pools render on prod).
- **Severity:** low.

---

## Class C — harness artifact (noted, NOT fixed on this branch)

### C1 — `no-op-click` false positive on Join / Sign in

- The `no-op-click` walls (join button; two sign-in buttons) are **false
  positives**. The screenshots for those exact walls show the Dynamic modal
  **open** (see B1). The detector fingerprints `document.body.innerHTML`; the
  Dynamic modal mounts through a portal/iframe that the hash does not capture, so
  a real, visible modal reads as "changed neither URL nor DOM".
- **Recommendation (deliberately NOT applied — this is a prod-hunt branch and the
  rail forbids changing harness logic here):** before declaring a no-op, the
  detector should also check for a newly-visible `role="dialog"` / overlay /
  iframe. File as a harness follow-up.

```
/queue repo:arbiterpay "[explorer/harness] no-op-click detector false-positives when a click opens a Dynamic (portal/iframe) modal — the body.innerHTML DOM-hash misses portalled overlays, so Join/Sign-in reads as no-op though the wallet-connect modal clearly opens. Before the no-op verdict, also probe for a newly-visible role=dialog / overlay / iframe." severity:low label:test-infra
```

---

## Merit (`meritai.me`) — lighter browse pass

Landing loads cleanly ("Merit — Extraordinary ability, evidenced / Build your
O-1A case, faster"). Primary CTA **"Start your case"** routes to `/signup`
(email field present — inspected, not submitted); **"Sign in"** routes to
`/login`. Both are honest auth walls and the persona stopped at them. No class-A
issues.

### M1 — No standalone `/pricing` page (404)

- **URL:** `https://meritai.me/pricing` → **HTTP 404**, stock Next.js
  "404 — This page could not be found." The product is "Free to start", so the
  paywall is the signup gate rather than a pricing page — the 404 is expected,
  but a paid product with no linkable pricing/plans page is a minor
  marketing/SEO gap worth a glance.
- **Class:** B (expected). **Severity:** low.
- **Shot:** `shots/meritai-browse-01-http-error.png`.

```
/queue repo:meritai "[explorer/meritai-browse] No standalone /pricing (or /plans) page — meritai.me/pricing 404s and there is no Pricing link in the nav; the only paywall surface is the /signup gate. For a paid O-1A product consider a linkable pricing/plans page (marketing + SEO). Landing, 'Start your case'→/signup, and 'Sign in'→/login all work." severity:low label:marketing,ux
```
