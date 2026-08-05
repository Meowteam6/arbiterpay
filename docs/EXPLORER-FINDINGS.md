# Explorer QA — findings (real-environment persona run)

Five agent-authored personas walked the **real** app (`next dev`, this
checkout's default **unconfigured** state — no `.env`, no wallet, no Circle /
Dynamic / Junction credentials) on film. Every wall a persona hit was recorded,
never thrown; the run finished 5/5 with screenshots, per-wall video timestamps,
and the action log as repro steps.

- Harness: `app/e2e/explorer/` (`npm run test:explore`)
- Raw artifacts (gitignored): `app/e2e-artifacts/explorer/` — `findings/*.json`,
  `shots/*.png`, `runs/` (video + trace), and the machine-generated `findings.md`.
- Run: 5 personas, **9 walls** — 4 real (class A), 5 expected gates (class B),
  0 harness artifacts (class C) after the detector fix below.

## Safety envelope

The target is the app's own `next dev` with **no** configuration. No wallet is
funded and no credential is present, so **no real transaction is possible** —
the money-route personas (join / document-claim / wearable-claim) are *expected*
to hit config and sign-in walls, and those walls are the deliverable. Nothing
here provisions anything, sets `EXPLORER_BASE_URL`, or touches the hermetic mock
suite (still 43/43).

## Classification

- **A — real, user-blocking.** A visitor on any deploy would hit this; not a
  consequence of the missing config.
- **B — expected gate.** An honest refusal caused by the unconfigured surface
  (sign-in / wallet). Correct behaviour, not a bug.
- **C — harness artifact.** Noise the detector should not have recorded; fixed.

## Findings table

| # | Persona | Wall | What the visitor saw | Class | Sev | Shot |
|---|---|---|---|---|---|---|
| 1 | browse-pools | stuck-state | `/pools` shows 3 loading skeletons that never resolve — no pools, no empty state, no error (15s) | **A** | high | `shots/browse-pools-02-stuck-state.png` |
| 2 | join-without-wallet | stuck-state | `/pools/1` detail stuck on skeletons — no join affordance ever appears (15s) | **A** | high | `shots/join-without-wallet-02-stuck-state.png` |
| 3 | document-claim-attempt | stuck-state | `/pools/1` detail stuck on skeletons — no upload-proof affordance (12s) | **A** | high | `shots/document-claim-attempt-02-stuck-state.png` |
| 4 | wearable-claim-attempt | stuck-state | `/pools/1` detail stuck on skeletons — no run-the-check affordance (12s) | **A** | high | `shots/wearable-claim-attempt-02-stuck-state.png` |
| 5 | browse-pools | error-banner | "Dynamic is not configured…" + "Sign-in unavailable" | B | low | `shots/browse-pools-01-error-banner.png` |
| 6 | join-without-wallet | error-banner | same Dynamic banner | B | low | `shots/join-without-wallet-01-error-banner.png` |
| 7 | document-claim-attempt | error-banner | same Dynamic banner | B | low | `shots/document-claim-attempt-01-error-banner.png` |
| 8 | wearable-claim-attempt | error-banner | same Dynamic banner | B | low | `shots/wearable-claim-attempt-01-error-banner.png` |
| 9 | goal-intent | error-banner | same Dynamic banner | B | low | `shots/goal-intent-01-error-banner.png` |

Secondary observation (not a hard wall, drawn from the goal-intent action log):
the landing "See who's paying" CTA performs a native form `GET` to `/?` instead
of client-routing to `/goal`. Same class-A root as the skeletons: client
interactivity does not engage on this surface.

---

## Class A — real, user-blocking

### A1 — `/pools` list renders skeletons forever (money shot)

- **Persona / intent:** browse-pools — a first-time visitor wants to see which
  pools exist, what they pay, and open one to read its terms.
- **Wall:** `stuck-state` — "see at least one pool card (or an honest empty/error
  state) — stuck for 15000ms".
- **What was seen:** the `/pools` header ("Bounty pools", "Create pool") renders,
  then three `PoolCardSkeleton`s animate and **never resolve**. No pool cards, no
  "No pools yet" empty state, no "Could not load pools" error note.
- **Evidence beyond the film:** a standalone probe held `/pools` for 20s — 15
  skeleton elements still present, `role="alert"` empty, body text contains none
  of the empty/error copy, and **zero** RPC calls left the page. The raw SSR HTML
  of `/pools` already contains the 15 skeleton markers and none of the
  empty/error branch text, so the page is served stuck on both server and client.
- **Why it matters:** `app/pools/page.tsx` *has* an `ErrorNote` ("Could not load
  pools") and an `EmptyState` ("No pools yet"), but the pools query stays in
  `isLoading` forever and never reaches either branch on this surface — so the
  honest states the author wrote are unreachable and the visitor is left staring
  at a spinner with no way to tell "loading" from "broken". This is not specific
  to the missing wallet config: any slow/failed chain read reproduces it.
- **Repro:** open `/` → click **Pools** (or open `/pools`) → wait. Skeletons
  never resolve.
- **Money shot:** `shots/browse-pools-02-stuck-state.png` @ video 00:21.
- **Severity:** high.

```
/queue repo:arbiterpay "[explorer/browse-pools] /pools renders 3 loading skeletons that never resolve — no pool cards, no 'No pools yet' empty state, no 'Could not load pools' error; the pools query stays isLoading forever on an unconfigured surface (0 RPC calls, role=alert never renders, stuck 15s). Give the client read a timeout so the existing ErrorNote/EmptyState branch becomes reachable." severity:high label:ux,reliability
```

### A2 — `/pools/[id]` detail stuck on skeletons blocks every money route

- **Personas / intent:** join-without-wallet, document-claim-attempt,
  wearable-claim-attempt — each opens a pool and tries to join / upload proof /
  run a wearable check.
- **Wall:** `stuck-state` on "see a join affordance" / "see a document-upload
  affordance" / "see a wearable-check affordance" (12–15s each).
- **What was seen:** `/pools/1` renders the `PoolDetail` skeleton (title bar +
  card skeletons) and **never resolves** — so none of join, upload-proof, or
  run-the-check ever appears. Every money route dead-ends at a spinner **before**
  any sign-in or config gate, so the product never even gets to say "no" honestly.
- **Why it matters:** this is the same defect as A1 on the detail page, and it is
  strictly worse for the money paths — a would-be participant cannot see the pool,
  let alone attempt to join or claim. The wall is upstream of the expected sign-in
  gate, so the gate never runs.
- **Repro:** open `/pools/1` (or click any card, which itself never renders) →
  wait for a join/upload/check control → it never comes.
- **Money shots:** `shots/join-without-wallet-02-stuck-state.png` @ 00:20,
  `shots/document-claim-attempt-02-stuck-state.png` @ 00:17,
  `shots/wearable-claim-attempt-02-stuck-state.png` @ 00:17.
- **Severity:** high.

```
/queue repo:arbiterpay "[explorer/join+document+wearable] /pools/[id] pool detail is stuck on skeletons the same way the list is, so a visitor never reaches the join / upload-proof / run-the-check affordance — every money route dead-ends at a spinner before any sign-in gate can refuse honestly. Surface an error/empty state on the pool-detail read (timeout the client chain read)." severity:high label:money-route,ux
```

### A3 — landing "See who's paying" CTA doesn't route to `/goal`

- **Persona / intent:** goal-intent — a visitor types their goal into the landing
  box and expects to see who is paying for it.
- **Observation (from the action log; not a hard wall):** after filling the goal
  box and clicking **See who's paying**, the URL became `/?` and the visitor
  stayed on the landing page instead of navigating to `/goal`. `GoalIntent.tsx`
  routes via `router.push('/goal?q=…')` on submit, so a native form `GET` to `/?`
  means the client `onSubmit` handler did not intercept — the same
  interactivity-not-engaging root as A1/A2. (`/goal` itself renders fine when
  opened directly, echoing the goal as a heading.)
- **Why it matters:** the goal box is the product's front door ("say the thing
  you've been putting off"). A primary CTA that no-ops / falls back to a bare
  page reload is a first-impression failure.
- **Repro:** open `/` → type a goal → click **See who's paying** → lands on `/?`,
  not `/goal`.
- **Shot:** `shots/goal-intent-01-error-banner.png` (landing) @ 00:00.
- **Severity:** medium.

```
/queue repo:arbiterpay "[explorer/goal-intent] 'See who's paying' submits a native form GET to /? instead of client-routing to /goal — the landing CTA (the product's front door) does not reach the goal-match page when clicked on this surface. Make the goal box route to /goal reliably." severity:medium label:ux
```

---

## Class B — expected gates (honest, unconfigured surface)

All five personas hit exactly one class-B wall: the config banner
**"Dynamic is not configured. Set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID to enable
sign-in and embedded wallets."**, paired with a **"Sign-in unavailable"** button
in the header. This is the app degrading **honestly**: it names what is missing,
disables sign-in instead of offering a broken button, and still renders the rest
of the site (`app/providers.tsx` deliberately mounts wagmi + react-query without
Dynamic). This is the *expected* deliverable of the unconfigured surface and,
notably, a model for how the pools pages *should* fail. No product bug.

```
# Expected gate — file only as documentation, not a bug:
/queue repo:arbiterpay "[explorer/all-personas] Confirm the 'Dynamic is not configured' banner + 'Sign-in unavailable' state is the intended unconfigured-surface behaviour (it is honest and non-blocking). No code change expected — captured for the record." severity:low label:expected,docs
```

## Class C — harness artifacts (fixed)

- **Next.js HMR websocket console errors.** The first (interrupted) run recorded
  several `console-error` walls of the form
  `WebSocket connection to 'ws://127.0.0.1:3210/_next/webpack-hmr…' failed`.
  That is dev-server hot-reload infrastructure, absent from a production build —
  not a wall a real visitor meets. **Fixed** in `support/walls.ts`: a
  `DEV_CONSOLE_NOISE` filter drops `webpack-hmr` / Fast-Refresh chatter from the
  console and network detectors. The clean re-run recorded zero such walls.
- **"browser has been closed" cannot-proceed.** The interrupted run left one
  `cannot-proceed` wall ("Target page… has been closed") — an artifact of the
  process being killed mid-persona, not a product wall. It did not recur on the
  clean 5/5 run; no code change needed.
