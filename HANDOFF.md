# GoHealthMe — Handoff

Onboarding doc for anyone (human or AI agent) picking up this build. Read this top to bottom first.
Built at ETHGlobal New York 2026 by Andre Chuabio + Nikki Hu.

> **2026-07 update (Circle build): World ID has been removed entirely.** Entry
> is one wallet, one entry, enforced by `joinPool`'s on-chain dedupe; the
> World verify routes, the idkit widget, and the WORLD_* env vars are gone,
> and server gates now read pool membership from the contract
> (`app/lib/server/pools.ts`). References to World ID below describe the
> ETHGlobal build and are kept as history — do not re-wire them.

## What it is

Sponsor-funded USDC reward pools for verified health goals. A sponsor (insurer, employer, brand)
funds a pool with published bounties ("sleep score >= 75 for 3 nights = $X"); a participant joins
(one human, one entry, via World ID), their wearable/health data is verified, and USDC settles
instantly to achievers. Optional layers: stake on your own streak for a multiplier, or back someone
else's goal. The pitch: the UnitedHealthcare rewards model, but instant, transparent, and sybil-proof.

Why crypto: programmable escrow that pays the instant a verified behavior happens, a rewards pool no
one can sybil-farm (World ID), and portable health reputation. Insurers already pay for this through
opaque points and slow gift cards; we make it trustless and instant.

## Submitted partner picks (the 3-pick cap)

Arc + World + Chainlink. (ENS was dropped — Sepolia ENS is mid-migration to v2 and registration was
unreliable; see "Open items".) Other sponsors may be integrated for the demo but only these 3 are
submitted. The submit decision is final at the Sunday form.

## Repo layout

- `contracts/` — Foundry. `src/HealthPools.sol` (pools, joinPool w/ World ID nullifier, recordResult,
  settle, backGoal, multipliers) and `src/HealthVerdict.sol` (Chainlink verdict registry + onReport
  receiver). Tests in `test/`. `scripts/Deploy.s.sol`.
- `app/` — Next.js App Router (TypeScript, Tailwind). Frontend + API routes. THIS is the Next project
  root — env loads from `app/.env.local`, NOT the repo-root `.env` (see "Env").
- `cre/` — Chainlink CRE goal-verification workflow (Confidential AI Attester callback pattern).
- `scripts/` — `demo-reset.sh` (clean-slate redeploy+seed), `happy-path-test.sh` (live end-to-end proof).
- `DEPLOYMENTS.md` — canonical on-chain addresses. `AI_ATTRIBUTION.md` — required AI-assist log.

## Live on-chain (Arc testnet, chain id 5042002, USDC is the gas token)

- HealthPools (canonical): `0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064` — has 3 seeded pools.
- Oracle signer: `0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D` (funded ~0.5 USDC).
- Deployer / contract owner: `0xc278e8e4621A0Ba02bACB6291E595ecd168A04e1` (~1.3 USDC left — top up at
  https://faucet.circle.com before heavy work).
- HealthVerdict: built + tested but NOT yet deployed (deploy Saturday alongside the Chainlink booth).
- Arc RPC: https://rpc.testnet.arc.network | Explorer: https://testnet.arcscan.app | USDC ERC-20:
  0x3600000000000000000000000000000000000000 (6 decimals).

## How to run

- Frontend: `cd app && npm install && npm run dev` -> http://localhost:3000. Needs `app/.env.local`
  (see Env). Pages: `/`, `/pools`, `/pools/[id]`, `/pools/create`, `/dashboard`.
- Contracts: `cd contracts && forge test` (62 tests, all green). foundry at ~/.foundry/bin.
- Demo reset (fresh deploy + seed 3 pools + sync env): `./scripts/demo-reset.sh` from repo root.
- Happy-path proof (live on Arc, ~90s): `./scripts/happy-path-test.sh`.
- CRE dry-run (offline, no auth): `cd cre && bun run dry-run`. Live sim needs Chainlink CLI auth (see Open items).

## Env (IMPORTANT gotcha)

The Next app reads env from `app/.env.local` (its project root is `app/`), NOT the repo-root `.env`.
The repo-root `.env` is used by the shell scripts (deploy, happy-path, demo-reset). When you add a
secret, put app-needed vars in `app/.env.local`. Both files are gitignored. NEXT_PUBLIC_* vars must be
in `app/.env.local` to reach the browser (e.g. the World ID widget needs NEXT_PUBLIC_WORLD_APP_ID /
NEXT_PUBLIC_WORLD_ACTION_ID, which are aliases of the server WORLD_APP_ID / WORLD_ACTION_ID).

Currently set: Privy (NEXT_PUBLIC_PRIVY_APP_ID, PRIVY_APP_SECRET), World ID (WORLD_APP_ID,
WORLD_ACTION_ID + NEXT_PUBLIC aliases), Arc/oracle (ORACLE_SIGNER_PRIVATE_KEY, HEALTH_POOLS_ADDRESS,
ARC_RPC_URL, ORACLE_API_SECRET), Chainlink attester (CONFIDENTIAL_AI_API_KEY), CRE (CRE_ETH_PRIVATE_KEY,
CRE_TARGET=staging-settings). MISSING: WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET (Nikki's).

## Architecture (data flow)

Next.js (frontend + API routes) with Privy embedded wallets ->
- World ID proof verified in `app/api/world/verify` -> nullifier stored per-pool in `joinPool` (one
  human, one entry; product is sybil-farmed without it = World Track B).
- WHOOP OAuth (`app/api/whoop/*`) -> derived health summary -> verdict.
- Verdict path A (today's demo): `app/lib/server/oracle.ts` server signs `recordResult` to HealthPools.
- Verdict path B (Chainlink): `cre/` workflow receives a Confidential AI Attester callback (TEE
  inference over the health doc) -> DON-signed report -> `HealthVerdict.onReport` -> HealthPools.settle()
  gates on `HealthVerdict.canSettle(goalId)` when the gate is enabled.
- Settlement on Arc in USDC. Privacy invariant: raw health data never goes on-chain — only verdicts.

## Open items / next steps

1. WHOOP creds (Nikki): add WHOOP_CLIENT_ID + WHOOP_CLIENT_SECRET to `app/.env.local` -> the full live
   happy path (real wearable data -> oracle -> settle) works end to end.
2. Chainlink CLI auth: `cre workflow simulate` (v1.20) needs `cre login` or a CRE_API_KEY. Login email
   codes were not arriving; resolve via Andrej/Chainlink booth (he hands out keys) OR try CLI v1.19.0
   (`curl -sSL https://cre.chain.link/install.sh | bash -s -- v1.19.0`) which did not enforce login.
   Then `cd cre && npm run simulate`. CLI simulation = the qualifying Chainlink prize artifact.
3. Deploy HealthVerdict to Arc + (optional) flip the gate: deploy it (forge create, not forge script —
   see gotcha), `pools.setHealthVerdict(addr)` to enable Chainlink-gated mode. Leave gate OFF
   (address(0)) to keep the proven oracle-only demo working.
4. Booth (for a LIVE on-chain DON write): get the real KeystoneForwarder address on Arc, call
   `HealthVerdict.setForwarder(addr)`, confirm Arc chain selector.
5. Submission: finalize `notes/Submission Draft.md` (in the eth/ workspace, not this repo), record demo
   video, complete the 3 partner feedback forms.

## Rules (do not violate — these can cost the prize)

- From-scratch: only code written after Fri 9:00pm EDT. Commit continuously (sponsors audit git history).
- EASEeHealth (Darbease/EASEeHealth) is a PRE-EVENT, UNLICENSED repo — REFERENCE ONLY, never copy.
- The Chainlink Confidential AI Attester demo (smartcontractkit/chainlink-confidential-ai-attester-demo)
  is MIT + official — safe to reference/adapt WITH attribution (done in AI_ATTRIBUTION.md). Reimplement.
- Keep `AI_ATTRIBUTION.md` current. Never commit secrets (.env / app/.env.local are gitignored).

## Gotchas learned (save yourself the pain)

- Arc's native USDC delegatecalls a blocklist precompile that forge's script simulation can't execute,
  so `forge script` reverts on anything moving USDC. Use `forge create` + `cast send` instead (that's
  why demo-reset.sh and happy-path-test.sh use cast). View calls and `forge test` (with MockUSDC) are fine.
- Next env location (above) — the #1 "why isn't my key working" cause.
- Sepolia ENS is mid-migration to v2; public docs + ens-contracts point at an unauthorized controller;
  the live registration UI app.ens.dev is v2 and warns names may be reset. That's why ENS was dropped.

## Demo spine (no MediaPipe — shelved as gimmicky)

Real WHOOP sleep streak -> oracle/attester verdict -> USDC lands live on Arc (the WOW) -> audience backs
a goal via World ID QR. Settlement is the punchline. Keep one clean happy path; everything else is gravy.

---

# PLAN: Multi-modal evidence + goal-creation agent (2026-06-13 pivot)

This section supersedes the WHOOP-only framing above. Read it before starting work.

## Why the pivot

We don't have real WHOOP data, and tying the demo to a live WHOOP OAuth account is a fragile dependency.
Instead: **mocked, multi-modal health evidence** judged by a real AI judge into an on-chain verdict. This
also kills the WHOOP-creds blocker and makes the product strictly stronger — the story becomes "ANY
verifiable health goal (labs, wearable, a lift on video, weight loss) runs through the same trustless
verdict pipeline," not "we read sleep scores." WHOOP code stays as one optional wearable source; the demo
runs on mocks.

EASEeHealth (Darbease/EASEeHealth) is REFERENCE-ONLY/unlicensed — we took the *data-discipline concepts*
(no PHI on-chain, hashes/commitments only, deterministic IDs, nullifiers) and rebuild everything ourselves.

## Locked decisions

- Modalities (all mocked): **clinical/blood work, wearable series, video lift (240 lbs), weight/biometric**.
- **Real judge across ALL modalities** (Claude, vision-capable for video frames). No canned verdicts.
- **Both settle paths** — A (oracle, proven on Arc) drives the live demo; B (Chainlink CRE + Confidential
  AI Attester, now UNBLOCKED) runs the same judge logic in a TEE -> DON report -> HealthVerdict -> gated settle.
- Goal creation via an **AI agent, BOTH personas**: sponsor (insurer/employer/gov) and participant (self-goal/stake).

## Core idea: one schema, four modalities, one judge

Normalize every input into a generic evidence doc + a goal rubric; the judge decides; only the verdict +
hashes go on-chain. Raw evidence (blood panel, video, readings) NEVER touches the chain.

```
goal (rubric)        mocked evidence (raw, off-chain)        real judge (Claude / TEE attester)
  any health goal  <-- blood panel JSON  ─┐
                       weight/sleep series ┼─> normalize (text or video frames) ──> judge(rubric, evidence)
                       lift video (frames)─┘                         │
                                          { verified, confidence, reasonBitmap, inputDigest }
                       path A: oracle signs ──┐                      │
                       path B: CRE attester (TEE) → DON report ──> HealthVerdict ──> settle USDC on Arc
```

Symmetry worth pitching: **one model writes the rubric (creation), another judges against it (verification).**

## Shared schemas — FREEZE THESE FIRST (the contract between app, CRE, and chain)

Challenge is **rubric-centric**: a natural-language objective criterion is ALWAYS present; the numeric
predicate is an OPTIONAL machine-checkable shortcut. This is what lets ANY goal be entered.

```
Challenge {
  id, title, description           // human-facing; description shows on the pool card
  createdBy:    "sponsor" | "participant"
  sponsorType?: "insurer" | "employer" | "gov" | "individual"
  evidenceTypes: string[]          // free-form: ["clinical_lab","wearable","video","photo","document"]
  predicate?: {                    // OPTIONAL — only when cleanly numeric
    metric: string                 // ANY string: "fasting_glucose_mgdl","deadlift_lbs","weight_lbs"
    comparator: ">=" | "<=" | "==" | "trend_to"
    target: number, unit: string
    aggregation: "single" | "streak" | "average" | "count"
    periodDays?: number
  }
  rubric: string                   // ALWAYS present — the objective criterion the JUDGE evaluates
  reward: { totalUsdc, perAchieverUsdc, maxAchievers?, deadline? }
}

Verdict {
  goalId:       bytes32            // keccak256(poolId, participant, periodStart, metric) — deterministic
  verified:     bool
  confidence:   uint8              // 0–100
  reasonBitmap: uint256            // bit0 predicate-met, bit1 evidence-plausible, bit2 in-period, bit3 confident
  inputDigest:  bytes32            // keccak256 of canonical evidence bytes
  modality:     enum
}
```

On-chain posture: store only `challengeHash = keccak256(canonical(Challenge))` at pool creation and the
`Verdict` (+ inputDigest) at settle. Full Challenge AND raw evidence live off-chain.

## Goal-creation agent (both personas)

NL goal + persona -> agent drafts a structured `Challenge` -> editable preview in `/pools/create` ->
confirm -> `createPool(challengeHash, reward)` on-chain. The agent's job is to make the rubric objective,
time-bound, and not gameable, and to flag when the chosen evidence types can't actually prove the goal.
- Sponsor flow = the enterprise/payer headline (stand up a trustless incentive in ~60s).
- Participant flow = personal goal + optional self-stake multiplier.
- Reuses Andre's `judge.ts` Claude plumbing.

OPEN DECISION (Nikki to confirm): agent depth = **one-shot draft (recommended MVP)** vs multi-turn
interview (stretch; more wow, more live-demo risk).

## 12-hour split

FIRST 30 MIN TOGETHER: freeze the Challenge + Verdict schemas above. Nothing parallelizes cleanly until then.

Nikki — evidence + frontend + demo:
- Mock evidence generators: blood panel JSON, weight series, wearable series (tunable to pass/fail).
- Goal-creation agent UX (both personas) wired into `/pools/create`; editable Challenge preview.
- Modality/challenge picker -> submit evidence -> show verdict (confidence + reasons) -> "USDC landed".
- Video modality: short deadlift clip + extract 2–3 frames (or curated frames) for the vision judge.
- Demo script: multi-modal "any health goal, raw data never on-chain" narrative. Delete dead ENS code.

Andre — judge + contracts + Chainlink:
- `app/lib/server/judge.ts`: shared real judge (Claude vision, structured `Verdict`, refuses to invent data).
- `HealthVerdict.sol`: add inputDigest + confidence + reasonBitmap + deterministic goalId + per-period
  nullifier; deploy to Arc (forge create, not forge script — see gotcha). NOTE: forge not currently
  installed on this machine — reinstall foundry first, re-confirm 62 tests green.
- CRE path B (unblocked): generalize attester prompt to multi-modal evidence -> DON report -> onReport -> gated settle.
- Wire path A oracle to sign the judge's verdict.

Sync points: after schema freeze, after first live verdict, after first on-chain settle, final rehearsal.

## New files to create (rebuilt from scratch)

- `app/lib/evidence/types.ts` — Challenge + Verdict + EvidencePacket schemas (the frozen contract).
- `app/lib/evidence/mock/{clinical,wearable,video,weight}.ts` — mock evidence generators.
- `app/lib/server/judge.ts` — generic real judge (shared by path A and conceptually mirrored in CRE).
- `app/lib/server/digest.ts` — canonical serialization + keccak256 (challengeHash, inputDigest).
- `app/lib/server/goalAgent.ts` — NL goal + persona -> structured Challenge draft.
- `app/api/evidence/submit/route.ts` — run judge over submitted mock evidence -> verdict -> path A sign.
- `app/api/goals/draft/route.ts` — goal-creation agent endpoint.

## Scope guardrails

- MVP must-have: schemas frozen; 2–3 modalities mocked + judged live; goal agent one-shot draft;
  path A live settle with inputDigest on-chain.
- Stretch: 4th modality; path B TEE attester live; multi-turn agent; reasonBitmap UI; fraud nudges.
- The goal agent and extra modalities must NOT sit on the live settlement critical path — they can't break the demo.

---

# Dynamic + Unlink (non-custodial private payments) — setup, run & login troubleshooting (2026-06-13)

Supersedes the Privy notes above. Wallets now use **Dynamic**; private USDC reward payouts use
**Unlink** (non-custodial — each user's Unlink account is derived from their OWN wallet signature).
The existing oracle public settle is untouched. On `main`.

## 1. Env setup (the #1 cause of "it's not working")

The Next app reads `app/.env.local`. Repo-root `.env` is ALSO loaded server-side (via
`next.config.ts` `loadRootEnv`) — BUT `NEXT_PUBLIC_*` vars are inlined into the **browser** ONLY
from `app/.env.local`. So the browser-exposed vars MUST be in `app/.env.local`:

```
# browser (NEXT_PUBLIC_* MUST be in app/.env.local)
NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID=...      # Dynamic dashboard env id
NEXT_PUBLIC_UNLINK_APP_ID=...               # Unlink Project ID (dashboard.unlink.xyz -> project -> Project ID)
NEXT_PUBLIC_HEALTH_POOLS_ADDRESS=0x72D3...  # = HEALTH_POOLS_ADDRESS
NEXT_PUBLIC_WORLD_APP_ID=app_...            # = WORLD_APP_ID
NEXT_PUBLIC_WORLD_ACTION_ID=join-pool       # = WORLD_ACTION_ID
# server (can be in app/.env.local or repo-root .env)
UNLINK_API_KEY=...                          # dashboard.unlink.xyz -> API Keys (SECRET, server only)
UNLINK_ENVIRONMENT=arc-testnet
# engine URL is OPTIONAL — pass EITHER environment OR engineUrl, never both (0.3.0 rejects both).
# "arc-testnet" resolves the URL internally. If you set it explicitly it is:
UNLINK_ENGINE_URL=https://arc-testnet-production-api.unlink.xyz
UNLINK_TREASURY_PRIVATE_KEY=<32-byte hex>   # EVM wallet that funds payouts. MUST be 64 hex chars.
                                            # For the demo, reuse the DEPLOYER key (funded ~13 USDC).
UNLINK_TREASURY_MNEMONIC="<12-word BIP-39>" # treasury's Unlink shielded account (you generate this)
WORLD_SIGNER_PRIVATE_KEY=0x...              # World ID 4.0 RP signer (World portal). /api/world/rp-context needs it.
WORLD_RP_ID=rp_...                          # World ID 4.0 RP id
```
`UNLINK_USER_MASTER_MNEMONIC` is GONE (non-custodial — user accounts derive client-side).

## 2. Run
```
cd app && npm install && npm run dev   # -> http://localhost:3000
```
If the build errors with `@next/swc-darwin-arm64` "content extends beyond end of file" (corrupt
native binary from a churny install): `rm -rf node_modules/@next/swc-darwin-arm64 && npm install`.

## 3. Login troubleshooting (Andre's issue)
Login is Dynamic's wallet/email handshake — it runs BEFORE any of our code, so failures don't hit
the server log; it's the browser/wallet, not the app.
- **"Message signature denied" / MetaMask sign never completes / console `StreamMiddleware - Unknown
  response id`** = MULTIPLE wallet extensions (Phantom + Coinbase + MetaMask) fighting over
  `window.ethereum`. FIX: use **email login**, OR disable Phantom & Coinbase at `chrome://extensions`
  (keep only MetaMask) and hard-reload (Cmd-Shift-R).
- **MetaMask popup didn't appear**: the request is queued in the extension — click the 🦊 icon to find
  the pending Connect/Signature request. Unlock MetaMask first (locked wallet silently fails).
- **Two steps**: MetaMask first asks to **Connect** (click Connect), THEN **Sign** (click Sign). Both required.
- **RECOMMENDED for demos: email login** — top field -> Continue -> 6-digit code -> Dynamic embedded
  wallet on Arc. No popup, no extension conflict.

## 4. "Insufficient funds" when joining/claiming
Even a free join needs a little Arc gas (USDC is the gas token, ~0.0014 USDC). A fresh connected
wallet has $0. FIX: send a bit of Arc USDC to the connected wallet's address — from the deployer
wallet `0xc278e8e4621A0Ba02bACB6291E595ecd168A04e1` (holds ~13 USDC) or Circle faucet
https://faucet.circle.com. The treasury (= deployer) funds the actual payouts.

## 5. Non-custodial flow (what happens)
sign in -> **Join with World ID** (needs WORLD_SIGNER_PRIVATE_KEY) -> **Claim privately**: user signs
ONE message -> `account.fromEthereumSignature` derives their Unlink account client-side -> server
treasury deposits + privately transfers the reward to that address -> user **withdraws** client-side
to their wallet. Routes: `/api/unlink/{register,authorization-token,payout}`. SDK: `@unlink-xyz/sdk@0.3.0-canary.598`.

## 6. Known non-blocking noise
`DynamicWagmiConnector WARN: Chain Sepolia not in Dynamic config` + `UnknownRpcError: Transport
request timed out` = leftover Sepolia chain in the wagmi config (from dropped ENS). Harmless console
noise; safe to remove Sepolia from `app/app/providers.tsx` + `app/lib/chains.ts` (Arc-only app).

---

# 2026-06-14 — Production persistence (Redis), deploy, Blink top-up, treasury funding

Picks up from the Dynamic + Unlink section. All on `main`.

## Persistence moved to Upstash Redis (fixes the prod payout 403)
`app/lib/server/store.ts` used to write per-instance JSON files under `os.tmpdir()`. On Vercel that
broke cross-request state: `/api/world/verify` wrote the World-ID record on one serverless instance,
`/api/unlink/payout` read it on another, so `getVerification()` returned null and the payout always
**403'd ("No verified World ID record for <addr> in pool N")** in prod — while working locally (one
process, one tmpdir). The same flaw hit claim idempotency (`isClaimed`/`markClaimed`).

Fix: `store.ts` now reads/writes **Upstash Redis** (REST, serverless-safe) when its env vars are set,
falling back to the file store for local dev/tests. `readJson`/`writeJson` signatures are unchanged,
so `claims.ts` and `world.ts` were untouched.
- Provisioned via the **Vercel "Upstash for Redis"** Marketplace integration → injects
  `KV_REST_API_URL` + `KV_REST_API_TOKEN` (also `KV_URL`, `REDIS_URL`) into all envs. The code accepts
  `KV_REST_API_*` or `UPSTASH_REDIS_REST_*`. It's one shared DB across Prod/Preview/Dev.
- Records written before this change (to the old ephemeral store) are gone. For an already-joined pool
  whose World-ID proof can't be re-issued (one proof per pool), seed the record directly:
  `redis.set("gohealthme:world-verifications.json", { "<lowercase addr>": { "<poolId>": { nullifierHash, poolId, verifiedAt } } })`.

## MetaMask "message signature denied" (4001) — usually a STALE PROD BUILD, not a regression
The sign-in fix is `useMetamaskSdk: false` + `initialAuthenticationMode: "connect-only"` in
`app/app/providers.tsx` (skips Dynamic's MetaMask multichain SDK and the SIWE verify signature). When
prod asks MetaMask to "sign in to verify" again (Dynamic logs at `https://logs.dynamicauth.com/api/v1/<envId>`
show `authOrigin: wallet-verify`, `errorCode: 4001`), prod is running an OLD build that predates the fix.
Verify by grepping the live JS bundle for `useMetamaskSdk:!1` (=false, fix present) vs `!0`. Fix: clean
redeploy (below) + hard-refresh the browser (it caches the old chunks).

## Deploying (the reliable path)
From repo root or `app/` (both link to the same Vercel project, root dir = `app/`):
```
vercel --prod --force      # --force skips the build cache; a dashboard "Redeploy" can reship stale code
```
- A git push to `main` also auto-deploys, but has reshipped stale/old-commit builds before — prefer the
  `--force` CLI deploy when it matters, then verify the live bundle.
- **Env gotcha:** `NEXT_PUBLIC_*` vars are inlined at build time. This app reliably bakes them from the
  uploaded `app/.env.local` (the CLI uploads it); setting them only in the Vercel dashboard has NOT
  reliably inlined them here — keep `NEXT_PUBLIC_*` in `app/.env.local` too, then `--force` redeploy.
- `vercel env pull` shows `""` for sensitive/encrypted vars even when set — don't trust it to read values
  back; grep the live bundle instead.

## Blink one-tap USDC top-up (PR #6) — required env
Add to Vercel (all envs) AND `app/.env.local` (the `NEXT_PUBLIC_*` ones must be in `app/.env.local`):
```
NEXT_PUBLIC_BLINK_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
NEXT_PUBLIC_BLINK_MERCHANT_ADDRESS=0x8a39a5160Bad34713169ad7eEf9bd779b32c6141
BLINK_MERCHANT_ADDRESS=0x8a39a5160Bad34713169ad7eEf9bd779b32c6141
BLINK_MERCHANT_ID=<uuid>
BLINK_MERCHANT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"  # PEM PKCS8 ECDSA P-256; normalizePem() converts literal \n at runtime
TREASURY_PRIVATE_KEY=0x...    # Blink treasury EVM key -> address 0xd3f3c7813d88946E255005E1b7B49d4995Bd87a5
```
`TREASURY_PRIVATE_KEY` (Blink) is a DIFFERENT account from `UNLINK_TREASURY_PRIVATE_KEY` (the payout
treasury, `0xc278…04e1`). Don't mix them up.

## Unlink payout needs a SHIELDED treasury balance
`runPrivatePayout` does `deposit -> transfer` from the Unlink treasury (`0xc278…04e1`). If the
treasury's *shielded* balance is 0 you get `transfer.prepare failed: invalid amount: insufficient
balance: have 0, need 250000`, even with plenty of *public* USDC. Fund the shield once:
`treasuryUnlinkClient().depositWithApproval({ token: ARC_USDC_ADDRESS, amount: "5000000" })` → `.wait()`;
verify with `balanceOf(ARC_USDC_ADDRESS)`. The balance lives on the Unlink engine (account-scoped), so
funding once covers local + prod.
- KNOWN BUG (follow-up): `runPrivatePayout` calls plain `deposit()` (needs the ERC-20 approval that
  `depositWithApproval` handles) and `settle()` awaits `.wait()` but ignores the result status — so a
  failed deposit is swallowed and the transfer hits an empty shield. Fix = use `depositWithApproval` +
  check terminal status. Until then, keep a standing shielded balance.

## Wearables = Junction (not raw WHOOP OAuth)
Health data links via **Junction Link** (WHOOP/Oura/Fitbit/Garmin) — `/api/junction/{link,data,progress}`,
keyed by wallet address. The dashboard shows a **Connect health data** button when unlinked and a
**Connect / switch provider** (relink) button when linked. A `400` on the progress feed = no linked
provider for that wallet yet (or a Junction env/param issue), not a code bug.

---

# 2026-07-27 — Path B (Chainlink CRE) wired live + goalId schema change

Supersedes the addresses in "Live on-chain" and open items 2-4 above. Productionization
priority 3 ("production runs on the Chainlink confidential path, deployed not CLI-simulated")
is now most of the way there.

## The booth dependencies were never actually blockers

Both values the hackathon notes deferred to the Chainlink booth are public documentation:

- Arc testnet KeystoneForwarder: `0x76c9cf548b4179F8901cda1f8623568b58215E62`
  (CRE forwarder directory). Verified: 17KB of live code at that address on Arc.
- Arc testnet chain selector: `3034092155422581607` (CCIP directory).

**Bug this surfaced:** `cre/wf-goal-verification/config.json` had
`chainSelector: "5042002"` — that is Arc's **chain id**, not its Chainlink **chain
selector**. Different namespaces. `EVMClient(BigInt(chainSelector))` would not have
resolved a chain, so every live `writeReport` would have failed. Any earlier attempt to
"just turn on path B" would have died here with a confusing error.

## New canonical deployment (old one is dead)

- HealthPools: `0xc4274eF2cBe28f77Af31b980055Cc1171818390C` (gate ON)
- HealthVerdict: `0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042` (forwarder SET)
- Old prod `0x72D3…2064` is abandoned: it predates the gate selectors, so `healthVerdict()`
  reverts on it and it can never consult the registry. It held 119.25 USDC across 15 demo
  pools (max 1 participant each, names like `e2e-test`) — demo residue, not migrated.

## goalId schema changed — BREAKING

```
old: keccak256(abi.encode(uint256 poolId, address participant))
new: keccak256(abi.encode(address pools, uint256 poolId, address participant, uint64 periodStart))
```

`pools` domain-separates the registry. HealthVerdict is a standalone contract that several
HealthPools may share; keyed on `(poolId, participant)` alone, pool id 1 on two deployments
collides, so a verdict earned against one would satisfy `canSettle` on the other. Redeploying
HealthPools is exactly what triggers that, so it had to be fixed in the same pass.
`periodStart` scopes a verdict to one pool period.

`metric` from the original frozen schema was deliberately dropped: a pool has one goalSpec, so
poolId already pins the metric, and hashing a free-form string would force identical
canonicalization across Solidity and two TypeScript call sites for no disambiguation gain.

Four layers must agree. They are pinned by tests, and the app no longer duplicates the formula:
- `HealthVerdict.computeGoalId(pools, poolId, participant, periodStart)` — canonical, pure
- `HealthPools.computeGoalId(poolId, participant)` — view, reads periodStart from storage
- `cre/wf-goal-verification/main.ts` + `cre/src/dry-run.ts` — from config.json
- `app/lib/server/verdict.ts` — now **reads** the id from HealthPools instead of re-deriving it

## Verified

- 65/65 Foundry tests (3 new: domain separation across deployments, distinct-per-period,
  registry/pools agreement). CRE + app typecheck clean.
- Three-way live agreement on Arc: CRE dry-run goalId == live `HealthPools.computeGoalId`
  == live `HealthVerdict.computeGoalId` = `0x819ca618…ea692`.
- On-chain gate proof re-run against the new registry: two participants, identical passing
  oracle results, only the verdict-backed one paid (+2.00 USDC vs +0).
  Settle tx `0xfdaff54d7a38d0c38a2ac94048086ef95b4475566dc7e9084b48d20bc34d28f6`.

## What is still NOT done (path B is wired, not yet flowing)

1. **`authorizedKeys` is still `[]`.** Empty is valid only for `cre workflow simulate`; the CRE
   gateway rejects a *deployed* HTTP trigger with no keys, so it fails closed — this is a
   deploy blocker, not an open hole. It needs the EVM address whose key signs the Confidential
   AI Attester's `cre_callback` POST, as
   `{ "type": "KEY_TYPE_ECDSA_EVM", "publicKey": "0x…" }`. That value comes from the Attester
   service and is the one genuinely external unknown left.
2. **The workflow is not deployed to a DON.** Until it is, nothing ever calls the forwarder, so
   `onReport` stays unused even though it is now enabled.
3. **Path A and path B are still the same trust root.** The registry's `attester` is the oracle
   EOA `0xA56e…F7F2D`, the same key that signs `recordResult`. Until the DON is the writer, the
   gate proves the pipeline works but does not add an independent party.
