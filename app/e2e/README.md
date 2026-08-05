# End-to-end suite (Path A)

```bash
npm run test:e2e          # headless, starts both servers itself
npm run test:e2e:ui       # the Playwright UI runner
npm run test:e2e:demo     # @demo happy paths on video -> e2e-artifacts/demo/
npx playwright test fail-closed -g "non-member"   # one file, one name
```

First run only: `npx playwright install chromium`.

Nothing here needs a credential, a funded wallet, or network access beyond
`127.0.0.1`. If a test ever seems to need one, the suite has stopped being
hermetic and that is the bug. Concretely: `ARC_RPC_URL`, `CIRCLE_API_BASE_URL`,
`JUNCTION_BASE_URL` and `CONFIDENTIAL_AI_BASE_URL` are each EXCLUSIVE in the
app once set — no code path falls back to a public endpoint past them — and
the browser's one third-party asset fetch (Dynamic's wallet-book CDN) is
aborted by the shared fixture.

Failing tests keep a trace and a video (`retain-on-failure`); passing runs
record nothing.

## The demo profile

`npm run test:e2e:demo` (playwright.demo.config.ts) reruns only the tests
tagged `@demo` — the browser-driven happy paths: landing to goal, pool
browsing and the join panel, and both claim kinds ending on the SPOTTER
console — with video always on, 1280x720, slowed ~300ms per action so a human
can follow it. One `.webm` per test lands in `e2e-artifacts/demo/`. This
exists for Circle/XPRIZE demo footage: a real passing run against the mock,
deterministic and offline. The recording of a real mainnet/testnet settlement
that the submission also needs remains a separate human step.

## How it is wired

Two processes, both started by `playwright.config.ts`:

| Process | Port | What it is |
|---|---|---|
| `next dev` | 3100 | the app, unmodified |
| `e2e/support/mock-upstream.ts` | 3111 | Arc testnet JSON-RPC, Junction, the Chainlink Confidential AI attester, a Circle API refuse-everything stub, and the fixture control plane |

The app is pointed at the mock through the env it already honours —
`ARC_RPC_URL`, `JUNCTION_BASE_URL`, `CONFIDENTIAL_AI_BASE_URL`,
`CIRCLE_API_BASE_URL` — so the code
under test is the real code all the way down to the socket. The browser is
pointed at the same mock for its client-side chain reads (`support/test.ts`
proxies the three public Arc RPC hosts), so a test has exactly one place to
seed the world:

```ts
const state = emptyState();
state.pools = [pool({ id: "1", document: true })];
state.participants[participantKey("1", wallet.address)] = joinedParticipant();
await mock.seed(state);
```

`mock.read()` reads it back afterwards, including the chain writes the app made
and the prompts that actually crossed the enclave boundary — assert on effects,
not only on responses.

`next dev`, never `next build && next start`: `lib/server/store.ts` refuses to
boot in production mode without Redis, by design. Development mode engages the
JSON file store under `DATA_DIR` (`.data-e2e/`, wiped by `globalSetup`).

## Why the money paths are driven through `request`, not clicks

`EvidenceUpload`, `WearableCheck`, `JoinPool` and `BackGoal` all short-circuit
on the build-time `DYNAMIC_CONFIGURED` flag before they reach any wallet code.
Rendering their real UI needs a live Dynamic environment id — a real account,
with live calls to Dynamic's cloud — which the zero-credential constraint rules
out. So the browser specs cover what the browser genuinely decides (which pools
are offered, what each panel says, that an unconfigured build refuses to
pretend it can sign) and the claim routes are driven directly, which is what
actually decides the money. Those routes are unauthenticated by design; the
browser adds no authority to them, only a file picker.

The specs *do* sign the app's EIP-191 ownership message (`testWallet(...)
.authHeaders()`), because a claim's verdict prose only comes back to a proven
owner.

## Not covered here, and why

- **A real browser-driven wallet connect, join, or signature.** Needs Dynamic.
  Faking it through SDK internals would test the fake.
- **A settled claim (`status: "paid"`).** Reaching it needs a pool whose period
  has ended *and* SPOTTER holding the on-chain oracle/attester role through a
  Circle developer-controlled wallet. Claims here stop at `recorded` with the
  settlement deferred, which is the honest terminal state for a live pool.
- **The SPOTTER-as-oracle write path** (`recordResultAsSpotter` and friends).
  Deliberately routed around by leaving `SPOTTER_WALLET_ADDRESS` unset; the
  legacy oracle-key path Path A specifies is what runs.
- **Real attester latency** (`queued` → `running` → `completed` over time) and
  real Junction OAuth. The mock answers immediately.
- **`/api/agent/sweep`**, Blink, and Unlink — outside Path A.
