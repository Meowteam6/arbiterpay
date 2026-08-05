# Circle Agentic Economy Prize — gap audit

Read-only audit of this repo against the prize's three mandatory proofs and its
four judging criteria. No runtime behaviour was changed to produce it.

**Audited at:** commit `a30718c`, 2026-08-04. **Deadline:** 2026-08-17, 1:00pm PT.

**How to read the citations.** Every claim below is anchored to a `file:line` in
this repo, or is explicitly labelled **UNVERIFIED** with the reason it could not
be checked from the repo tree. Nothing here was inferred from a commit message.

**Two things this audit structurally cannot verify**, and both matter more than
anything in the code:

1. **Deployment and env state.** Every integration below is verified as *code*.
   Whether the deployed application has `CIRCLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`,
   `X402_PRIVATE_KEY` or `CRON_SECRET` set is not knowable from a repo tree, and
   every one of those variables has a silent-degradation path (see "Missing").
2. **The test suite was not executed.** `app/node_modules` is absent from this
   worktree and installing it was not permitted in this session, so the 40 test
   files (14 of them covering the agent, ~4,700 lines) were read, not run. Test
   *existence* below is verified; test *pass state* is **UNVERIFIED**.

---

## 1. What already qualifies

### Proof 1 — public repo showing Circle Agent Stack integration: **SUBSTANTIALLY MET**

Two Circle Agent Stack packages are real dependencies and both are load-bearing,
not decorative.

| Element | Evidence |
|---|---|
| Circle developer-controlled wallet as the agent identity | `app/package.json:18` (`@circle-fin/developer-controlled-wallets`), `app/lib/server/agent/wallet.ts:47` |
| Wallet provisioned on `ARC-TESTNET`, the Circle CLI default agent chain | `app/lib/server/agent/wallet.ts:14`, `:54` |
| The agent signs contract calls from that wallet | `app/lib/server/agent/spotter.ts:276` (`createContractExecutionTransaction` -> `settle(uint256)`) |
| x402 service purchases over Circle Gateway | `app/package.json:19` (`@circle-fin/x402-batching`), `app/lib/server/agent/x402.ts:23`, `:185` (`gw.pay`) |
| A live marketplace endpoint wired as a default, not a placeholder | `app/lib/server/agent/x402.ts:42` — QuickNode's Arc-testnet x402 offer |

The CLI-session-cannot-run-headless constraint recorded in `CLAUDE.md` is
honoured in code: the static API-key client is the always-on actor and the
comment at `app/lib/server/agent/wallet.ts:1-6` says why.

The repo does **not** vendor `circlefin/agent-stack-starter-kits`; it uses the
SDKs directly. That is a presentation question, not a compliance one — the
packages are the Agent Stack.

### Proof 3 — wallet address plus a clickable explorer URL: **CODE PATH MET, ARTEFACT MISSING**

The product surface exists and is correct:

- `app/app/api/agent/wallet/route.ts` returns `address`, live `balanceUsd`, and
  `explorerUrl`.
- `app/lib/chains.ts:38` builds `https://testnet.arcscan.app/address/<addr>`.
- `app/components/AgentConsole.tsx:132-150` renders the address in mono at
  display size with the explorer link beside it, at `/agent`
  (`app/app/agent/page.tsx:11`).

What is met is the *screen*. The *submission artefact* is not — see Missing 3.1.

### Centrality to the business: **STRONG, AND DEFENSIBLE ON READING**

The strongest part of the submission, and it survives a code read rather than
depending on the pitch:

- `contracts/src/HealthPools.sol:291` — `settle()` is `external nonReentrant`,
  gated only on time and `!settled`. The Circle wallet becomes the settler with
  no Solidity change, exactly as `CLAUDE.md` records.
- `app/lib/server/agent/run.ts` is the whole economy in one file: plan -> buy ->
  attester -> reason -> record -> settle. Remove the agent and there is no
  payout path at all.
- `app/app/api/agent/sweep/route.ts` plus `app/vercel.json:2` (a two-minute
  cron) is what makes "no human manual checkout" literally true: a participant
  who closes the tab is still paid, because settlement is driven by a cron over
  the ledger rather than by an open browser.

### Technical depth and autonomy: **STRONG**

- **Cheap-first-then-escalate is real control flow**, not UI theatre. The plan
  carries only the cheap read (`run.ts:844-855`); the vision-judge row is bought
  solely when the cheap read returns low confidence (`run.ts:959-988`). This is
  the moment the SPEC hangs the submission on and it is implemented as branching,
  not animation.
- **Guardrails are layered and enforced before money moves.** Per-claim cap
  frozen into the plan (`run.ts:359-371`, default `1.00` at `ledger.ts:44`,
  overridable via `AGENT_CLAIM_CAP_USD` at `ledger.ts:223`); global and
  per-wallet daily caps
  committed with an atomic `INCRBY` *before* `pay()` and reconciled after
  (`budget.ts:167-222`, defaults `5.00` and `1.00` at `budget.ts:32-34`).
  Reserve-then-reconcile is the correct ordering and the file says why
  (`budget.ts:16-23`).
- **No silent failures on the money path.** A purchase that throws is converted
  into a ledger-visible refusal rather than a bare 500 (`run.ts:461-479`), and
  a spend-intent marker is written before `pay()` so a crash leaves a trace
  (`run.ts:382-396`).
- **Payout is asserted on the USDC delta, never on transaction success.**
  `spotter.ts:298-306` throws if `AchieverPaid` carries no amount for the
  participant: "a green transaction is not money; do not report this as paid".
  This is the single most important line in the repo relative to the defect that
  blocked everything else.
- **Concurrency is handled**, which serverless makes non-optional: a per-goal
  Redis lock plus a pool-scoped settle lock so racing claims burn no gas
  (`run.ts:804-812`, `spotter.ts:246-263`).
- **The model cannot mint a payout.** `run.ts:1048-1051` overrules a `pay`
  decision that is not backed by a verified attester verdict, so a hijacked or
  broken completion can only veto.

### Eligibility gate — Gemini: **CODE PATH MET**

The blocker recorded in `CLAUDE.md` is closed in code.
`app/lib/server/agent/reason.ts` calls `gemini-2.5-flash` through Vertex AI
(`:16` `@google/genai`, `:20` model, `:108-126` `vertexai: true` client,
`:183` `generateContent`) as the agent's decision step. Two supporting details
are right: the privacy boundary holds (only derived verdicts and pool state
reach the prompt, `:128-153`), and every failure falls back to the deterministic
rule with a loud ledger note rather than killing the claim (`:173-210`).

**UNVERIFIED:** whether the *deployed* application has `GOOGLE_CLOUD_PROJECT`
set. Without it `vertexClient()` returns `null` at `reason.ts:110` and no Gemini
call is ever made — the eligibility gate silently reopens with no error anywhere
except one ledger note. This is the highest-consequence unverifiable in the
audit.

### The four SPEC defects: **ALL FOUR FIXED**

| # | Defect | State |
|---|---|---|
| 1 | Zero-payout pools (`entryFee 0` + `bountyModel 0`) | **FIXED** — `app/components/CreatePool.tsx:207` forces model `1` when the fee is zero; `:148-154` and `:402`/`:421` carry the reasoning and the UI. |
| 2 | Photo evidence ungated for wearable pools | **FIXED** — the claim surface now gates on `hasJoined` alone (`app/components/PoolDetail.tsx:259`), with an explicit "Upload proof instead" path for wearable pools (`:293-303`). |
| 3 | Fake payment animation | **FIXED** — the only surviving `sleep()` in `app/components/EvidenceUpload.tsx` is the poll interval at `:290`; the `sleep(600)/sleep(400)/sleep(300)` settlement theatre is gone, and `AgentReceipt`/`PayoutMoment` render real ledger entries (`:569`, `:634`, `:640`). |
| 4 | Stale ETHGlobal copy | **FIXED** — `app/app/layout.tsx:45` now reads "GoHealthMe — settled by SPOTTER on Arc testnet". No `ETHGlobal`, `World ID` or `ENS` string remains in shipped app code. |

### Build items 1-9: **ALL PRESENT**

Every item has both an implementation and a test file. Item 9 (the droppable
one) shipped as well: `GoalIntent.tsx`, `GoalMatch.tsx`, `app/app/goal/`.

| Item | Implementation | Tests (existence verified, pass state UNVERIFIED) |
|---|---|---|
| 1 Circle wallet | `lib/server/agent/wallet.ts`, `scripts/set-agent-oracle.sh:56` | `wallet.test.ts` (205 lines) |
| 2 Run loop + ledger | `lib/server/agent/run.ts`, `ledger.ts` | `run.test.ts` (1,028), `ledger.test.ts` (305), route test (690) |
| 3 AgentReceipt | `components/AgentReceipt.tsx` | `AgentReceipt.test.ts` |
| 4 x402 purchases | `lib/server/agent/x402.ts` | `x402.test.ts` (141) |
| 5 Gemini on Vertex | `lib/server/agent/reason.ts` | `reason.test.ts` (241) |
| 6 Zero-payout fix + primitives | `components/CreatePool.tsx:207`, `components/ui.tsx` | covered in component tests |
| 7 `/agent` + AgentStrip | `app/agent/page.tsx`, `components/AgentStrip.tsx`, `Header.tsx:128` | `feed/route.test.ts` (140), `feed-view.test.ts` (236) |
| 8 PayoutMoment | `components/PayoutMoment.tsx` | via `EvidenceUpload` |
| 9 Goal box + matcher | `components/GoalIntent.tsx`, `GoalMatch.tsx` | — |

---

## 2. What is missing

Ordered by what loses the prize soonest.

### 2.1 Proof 2 — a recorded demo of a real, verifiable USDC transaction: **NOT MET**

No agent-driven settlement transaction is recorded anywhere in the repo.
`DEPLOYMENTS.md` records settle transactions, but both are from the gate-proof
script signed by the deployer (`DEPLOYMENTS.md:48`, `:65`), not from SPOTTER's
Circle wallet. There is no video, no transaction hash attributable to the agent,
and no demo asset directory.

This is the largest single gap and it is not a code gap. The code that would
produce the proof is in place; the proof has not been produced.

### 2.2 Proof 3 — the artefact, as opposed to the screen: **NOT MET**

No SPOTTER wallet address is written down anywhere a judge would look.
`DEPLOYMENTS.md` lists every contract and the oracle signer
(`0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D`) but has no Circle wallet entry;
`README.md` names SPOTTER twice (`:5`, `:14`) without an address; `HANDOFF.md`
has no Circle wallet section. `SPOTTER_WALLET_ADDRESS` exists only as an empty
key in `.env.example:92`.

Related, unresolved from `SPEC.md:185`: **which wallet is submitted** — the
CLI-provisioned Agent Wallet as the named identity, or the developer-controlled
wallet that actually signs. The code only knows the latter.

### 2.3 Five env vars the code reads and `.env.example` never mentions

`.env.example` is the operational contract for a deploy, and it is missing five
variables that live code depends on. Two of the five fail quietly, which is the
dangerous kind.

| Variable | Read at | Consequence when unset |
|---|---|---|
| `CRON_SECRET` | `app/app/api/agent/sweep/route.ts:96` (`requireEnv`) | **Hard failure.** Every cron tick 500s. The tab-closed settlement path — the thing that makes "no manual checkout" true — is dead, and nothing on the receipt says so. |
| `GOOGLE_CREDENTIALS_JSON` | `app/lib/server/agent/reason.ts:80` | **Silent.** `.env.example:117-119` documents only ADC via `GOOGLE_APPLICATION_CREDENTIALS`, and `reason.ts:70-78` states plainly that ADC fails on Vercel because there is no filesystem. Following `.env.example` as written produces a deployment where every claim's ledger says "gemini unavailable" — the eligibility gate, reopened. |
| `X402_CHAIN_READ_URL` | `app/lib/server/agent/x402.ts:225` | Silent; falls back to the QuickNode default, so low impact, but undocumented. |
| `AGENT_DAILY_CAP_USD` | `app/lib/server/agent/budget.ts:62` | Silent; defaults to `5.00`. The guardrail Circle is judging is undiscoverable to an operator. |
| `AGENT_WALLET_DAILY_CAP_USD` | `app/lib/server/agent/budget.ts:66` | Silent; defaults to `1.00`. Same. |

### 2.4 Build item 10 — demo assets: **NOT STARTED**

- `app/public/demo-evidence/` holds three `.txt` files and no images
  (`biometric-screening.txt`, `cholesterol-panel.txt`, `flu-shot-record.txt`).
  `SPEC.md:147` is explicit that a `.txt` on camera reads as fake. There is no
  `.jpg`, `.jpeg` or `.png` anywhere under `app/public/` or `docs/`.
- No blurry gym-selfie asset exists, so **the escalation beat — the one moment
  the SPEC says the whole submission hangs on (`SPEC.md:86-104`, beat 4 at
  `SPEC.md:158`) — currently has nothing to shoot.**
- `scripts/seed-demo-pool.sh:30` already defaults `PERIOD=75`, so the one-take
  recording problem is solved.

### 2.5 `AI_ATTRIBUTION.md` is a fork-point artefact

The file is framed entirely under ETHGlobal rules (`AI_ATTRIBUTION.md:3-5`) and
its 32 rows stop at the pre-Circle codebase. **Not one line of the Circle build
is attributed**: no `wallet.ts`, `run.ts`, `ledger.ts`, `x402.ts`, `reason.ts`,
`budget.ts`, `lock.ts`, `spotter.ts`, `AgentConsole.tsx`, `AgentReceipt.tsx`,
`AgentStrip.tsx`, `PayoutMoment.tsx`, or the agent API routes. Three rows carry
parenthetical "removed in the Circle build" notes (`:21`, `:36`, `:38`), which
shows the file was touched during the pivot and then not extended.

### 2.6 Open questions still open (all four, unchanged from `SPEC.md:180-186`)

None of these are code problems and none can be closed from inside the repo:

1. **Does an Arc testnet transaction satisfy "real, verifiable USDC
   transaction"?** (`SPEC.md:183`) `CLAUDE.md` sets an **Aug 8** decision date
   for the Base-mainnet hedge. That date is four days out at the time of this
   audit, and no hedge code exists — `.env.example:4` has a
   `BASE_SEPOLIA_RPC_URL`, which is testnet, not the mainnet a Basescan link
   needs.
2. **GCP hosting vs. one Google Cloud product** (`SPEC.md:184`). Vertex AI is a
   Google Cloud product, so the Official Rules reading is satisfied by
   `reason.ts`. The Circle page's "hosting on Google Cloud Platform" reading is
   not, and would mean moving off Vercel — which `app/vercel.json` and the
   deployment guidance at `HANDOFF.md:355-366` are built around.
3. **Which wallet is proof 3** (`SPEC.md:185`). See 2.2.
4. **Money-path triage before the repo goes public** (`SPEC.md:186`,
   `CLAUDE.md`). Deliberately undocumented; held privately by Andre. This audit
   did not attempt to enumerate those findings and nothing here should be read
   as clearing them.

### 2.7 Presentation gaps a judge would notice in the first minute

- `README.md:3` still opens "Built at ETHGlobal New York 2026" and `:7` lists
  partners with Circle third. Circle is the prize being entered; the README
  reads as an ETHGlobal submission with Circle bolted on. The architecture
  diagram (`:19-35`) does not show SPOTTER, the agent wallet, or x402 at all,
  even though `:14` describes them in prose.
- The repo is still named `arbiterpay` — the name of the reframe that was
  rejected (`SPEC.md:170`, `SPEC.md:182`). Judges reach GitHub before they reach
  the video.

---

## 3. Shortest path to each

Ordered by hours-to-close against prize impact. The total of everything below is
well under the remaining calendar, which means the risk here is sequencing and
external answers, not engineering capacity.

| # | Gap | Shortest path | Effort | Blocked by |
|---|---|---|---|---|
| 3.1 | **2.3** env vars | Add the five keys to `.env.example` with the `reason.ts:70-78` warning inline, then confirm `CRON_SECRET` and `GOOGLE_CREDENTIALS_JSON` are actually set in the deployed project. Documentation change; no code. | 30 min | nothing |
| 3.2 | **Gemini UNVERIFIED** | Hit the deployed `/api/agent/run/[goalId]` once and read the ledger's reason note. If it says "gemini unavailable", the gate is open. This is a five-minute check standing between the build and disqualification. | 15 min | a deployed instance |
| 3.3 | **2.2** proof-3 artefact | Run `npm run agent:provision` (`app/package.json:15`), then `scripts/set-agent-oracle.sh` (`:18`), then add a "SPOTTER (Circle agent wallet)" block to `DEPLOYMENTS.md` beside the existing addresses, with the `testnet.arcscan.app/address/...` link. | 1 h | Circle API key and entity secret |
| 3.4 | **2.4** demo assets | Shoot two real photos: one legible scale or lab document, one deliberately blurry gym-mirror selfie. Drop both in `app/public/demo-evidence/`. Nothing else in item 10 is outstanding — `PERIOD=75` already works. | 2 h | a phone camera |
| 3.5 | **2.1** proof 2 | With 3.3 and 3.4 done, run one claim end to end on a seeded pool and capture the settle transaction hash. Verify it by USDC delta, not by a green receipt — the assertion at `spotter.ts:298-306` already does this, so trust the ledger's `paidUsd`, not the explorer's status pill. That hash plus the recording is proof 2. | 3 h | 3.3, 3.4, a funded agent wallet |
| 3.6 | **2.5** attribution | Append one table row per Circle-build file. Mechanical, and the existing rows are the template. Also fix the ETHGlobal-only framing at `:3-5` so the file covers both events. | 1 h | nothing |
| 3.7 | **2.7** README | Rewrite `README.md:3-7` to lead with the agent, and add SPOTTER, the Circle wallet, and the x402 buy step to the diagram at `:19-35`. This is proof 1's front door. | 1 h | nothing |
| 3.8 | **2.6.1** Arc testnet ruling | Chase the written answer. If nothing by **Aug 8**, execute the hedge: one small agent-driven USDC transfer on Base mainnet from the Circle wallet for a Basescan link. Do not migrate settlement off Arc. Needs a `BASE_RPC_URL` — only `BASE_SEPOLIA_RPC_URL` exists today (`.env.example:4`). | 1 day if triggered | Circle's answer |
| 3.9 | **2.6.2** GCP hosting | Chase the written answer. If the strict reading holds, the cheapest response is a Cloud Run deployment of the same Next app rather than a rewrite. Assume Vercel survives until told otherwise, per `SPEC.md:184`. | unknown | Circle's answer |
| 3.10 | **2.7** repo rename | Andre's call (`SPEC.md:182`). GitHub redirects make it free. Do before the repo goes public. | 10 min | a decision |
| 3.11 | **2.6.4** money-path triage | Ask Andre for the private triage before funding the agent wallet meaningfully. This gates 3.5, since 3.5 requires a funded wallet. | unknown | Andre |

### The critical chain

`3.11 -> 3.3 -> 3.5` is the only sequence that produces proof 2 and proof 3, and
every link needs a person rather than a commit. Everything else on this list can
run in parallel. If one thing is done after reading this document, it should be
**3.2** — a fifteen-minute check on whether the deployed application is actually
calling Gemini, because a silent `null` at `reason.ts:110` costs the entire
prize and produces no error to notice.

---

## Audit method and limits

- Every `file:line` above was opened and read at commit `a30718c`. Nothing was
  taken from a commit message or a prior review.
- The pre-audit context supplied with this task was treated as claims. All four
  SPEC defects and all nine build items were re-checked against source; all
  thirteen claims held. The claim "with tests" holds for test *existence* only.
- **Not attempted:** running the test suite (no `node_modules`, install not
  permitted here), reading deployment or environment state, any network or
  on-chain call, and any enumeration of the private money-path findings.
- This repo has no `CHANGELOG.md`, no `changelog.d/`, and no `.changeset/`, so
  no changelog fragment accompanies this document.
