# Explorer QA — persona runs against a real environment

```bash
npm run test:explore        # default: the app's own `next dev`, unconfigured
npm run test:explore:env    # sandbox mode: requires EXPLORER_ENV_FILE (see below)
npx tsx e2e/explorer/report.ts   # re-aggregate findings.md from the last run
```

This harness is the opposite of the hermetic suite one directory up. **No
mock upstream, no `hermetic.cjs` preload, no injected env** — an
agent-authored persona pursues a real user goal against the REAL app, on
film, and every wall it hits (console error, HTTP >= 400, error banner,
no-op click, stuck state) becomes a money-shot finding: screenshot +
video timestamp + the action log as repro steps. Walls never fail a run;
the only hard assertion per persona is "run completed and findings were
written".

## Safety envelope (read before changing anything here)

The default target is `next dev` in this checkout's **default, unconfigured
state**: no `.env` provisioned, no wallet funded, no Circle / Dynamic /
Stripe credentials present. Consequently **no real financial transaction is
possible** — join, claim, and settle attempts are expected to hit sign-in
gates and configuration walls, and those walls ARE the deliverable.

Hard rules:

- Do NOT create, fund, or provision any wallet for this harness.
- Do NOT add real credentials, to this config or to any env file it reads.
- Do NOT point `EXPLORER_BASE_URL` at production.
- Do NOT import `e2e/support/hermetic.cjs`, `e2e/support/mock-upstream.ts`,
  or anything else from the hermetic suite — mock-bounding the explorer
  defeats its purpose. The hermetic suite keeps its mocks; this harness
  keeps its reality. They share nothing but Playwright.

## Findings pipeline

| Path (under `e2e-artifacts/explorer/`) | What it is |
|---|---|
| `findings.md` | the aggregated report: per wall — persona, intent, money shot, repro steps, severity guess, ready `/queue` line |
| `findings/<persona>.json` | raw per-persona findings (walls + full action log) |
| `shots/*.png` | wall screenshots |
| `runs/` | Playwright output: always-on video (1280x720) and traces |

`findings/` and `shots/` are wiped at the start of each run (globalSetup)
so `findings.md` only ever describes the run that produced it. Everything
under `e2e-artifacts/` is gitignored.

## Layout

| File | Role |
|---|---|
| `explorer.config.ts` | separate Playwright config; spawns `next dev` (default) or targets `EXPLORER_BASE_URL` |
| `support/walls.ts` | wall-detector fixture: console/page errors, HTTP >= 400 (money routes `/api/oracle`, `/api/evidence`, `/api/agent`, `/api/pools` tagged), error banners, no-op clicks, stuck states |
| `support/persona.ts` | attempt-style DSL: try a step, else note the wall and continue; every step appends to the action log |
| `support/reset.ts` | globalSetup: clean findings/shots dirs |
| `report.ts` | globalTeardown + standalone aggregator → `findings.md` |
| `personas/*.explore.ts` | the five v1 personas: browse-pools, join-without-wallet, document-claim-attempt, wearable-claim-attempt, goal-intent |

Persona files end in `.explore.ts` precisely so the hermetic config
(`testMatch: *.spec.ts`) never picks them up, and vice versa.

## Running against another surface

```bash
EXPLORER_BASE_URL=http://127.0.0.1:3000 npm run test:explore
```

No server is spawned; the personas walk whatever is already listening
there. Local surfaces only — never production.

## Sandbox mode, later

`npm run test:explore:env` refuses to start unless `EXPLORER_ENV_FILE`
points at a dotenv file, which the config sources into the spawned
`next dev` (nothing else changes: same personas, same wall detection,
same report). This is the parameterized seam for a future test-mode run
against sandbox credentials — **this repo does not ship such a file and
nothing here should ever populate one with real keys.** When that day
comes, the file lives outside the repo, holds sandbox/test-mode values
only, and is sourced like so:

```bash
EXPLORER_ENV_FILE=/path/outside/repo/sandbox.env npm run test:explore:env
```
