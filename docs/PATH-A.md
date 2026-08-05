# Path A — the oracle-signed settlement path

Path A is the settlement path that works today. A trusted server key decides the verdict off-chain
and writes it straight to two contracts on Arc testnet; `settle()` then pays USDC to whoever the
registry clears. It is the path behind every live demo and both end-to-end proof scripts.

Path B is the Chainlink CRE path: a DON-signed report arrives at `HealthVerdict.onReport` through
the KeystoneForwarder. Path B is wired (the forwarder is set and `onReport` is live) but nothing
flows through it yet, because the workflow is not deployed to a DON and `authorizedKeys` is still
empty. See `HANDOFF.md`, section 2026-07-27, for that status. Everything below is Path A.

The two paths share their destination — the `HealthVerdict` registry and the `settle()` gate — so
Path B, when it lands, replaces the writer without touching the settlement half.

---

## 1. Canonical deployment

Arc testnet, chain id `5042002`. Native gas token is USDC. Addresses from `DEPLOYMENTS.md`
(2026-07-27 reset).

| Role | Address |
| --- | --- |
| HealthPools | `0xc4274eF2cBe28f77Af31b980055Cc1171818390C` |
| HealthVerdict registry | `0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042` |
| Oracle signer / registry attester | `0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D` |
| KeystoneForwarder (Path B receiver) | `0x76c9cf548b4179F8901cda1f8623568b58215E62` |
| USDC | `0x3600000000000000000000000000000000000000` |

Explorer: <https://testnet.arcscan.app/address/0xc4274eF2cBe28f77Af31b980055Cc1171818390C>

Settlement gate: **ON**. `HealthPools.setHealthVerdict` points at the registry above, so
`settle()` pays a participant only when `HealthVerdict.canSettle(goalId)` is true.

Seeded pools: `sleep` (Dreamwell), `recovery` (Vitality), `steps` (Iron Gym), `flu-shot` `[doc]`,
`screening` `[doc]`. The `[doc]` prefix on a pool's `goalSpec` is what routes it to the document
flow; everything else is a wearable pool (`app/lib/contract.ts`, `evidenceTypeOf`).

Every address above is superseded by `DEPLOYMENTS.md` if the two ever disagree — that file is
appended to by `scripts/demo-reset.sh` on every redeploy, and this one is not.

---

## 2. The shape of Path A

```
evidence (off-chain, never on-chain)
   -> verdict decided off-chain
      -> HealthPools.recordResult(poolId, user, verdict, multiplierBps)   [oracle-only]
      -> HealthVerdict.recordVerdict(goalId, verified, confidence, ...)   [attester-only]
         -> settle(poolId) pays USDC to every participant where
            resultRecorded && verdict && canSettle(goalId)
```

**Both writes are required.** `recordResult` alone is not enough. With the gate on,
`_isAchiever` (`contracts/src/HealthPools.sol:364`) reads:

```solidity
if (!(part.resultRecorded && part.verdict)) return false;
if (healthVerdict == address(0)) return true;
return IHealthVerdict(healthVerdict).canSettle(computeGoalId(poolId, user));
```

A passing result with no registry verdict settles to zero. The transaction still succeeds and
`AchieverPaid` never fires. This is why every proof in this repo asserts on the USDC balance
delta, never on transaction success.

### goalId

```
goalId = keccak256(abi.encode(address pools, uint256 poolId, address participant, uint64 periodStart))
```

The pool contract address domain-separates the shared registry; `periodStart` scopes a verdict to
one pool period. Four layers must agree on this formula: both contracts, the CRE workflow, and the
app. The app does **not** re-derive it — `app/lib/server/verdict.ts:129` reads it from
`HealthPools.computeGoalId(poolId, participant)` so there is exactly one source of truth. Keep it
that way.

### Who signs

`scripts/set-agent-oracle.sh` can hand both roles (`HealthPools.setOracle`,
`HealthVerdict.setAttester`) to SPOTTER's Circle wallet. The agent run loop reads both roles from
the chain on every run and dispatches to whichever key currently holds them
(`app/lib/server/agent/run.ts:1077` and `:1100`), so the cutover needs no app deploy in either
direction. `settle()` is permissionless and always callable by SPOTTER.

Consequence worth knowing before you debug anything: after `set-agent-oracle.sh` has run, the
legacy `ORACLE_SIGNER_PRIVATE_KEY` no longer holds the oracle role, and anything that signs
`recordResult` with it directly — including `POST /api/oracle/record` and
`scripts/happy-path-test.sh` — reverts. `scripts/demo-reset.sh` deploys with the legacy oracle, so
re-run `set-agent-oracle.sh` after every reset if you want SPOTTER to hold the roles.

---

## 3. The wearable flow

Two entry points reach the same on-chain writes.

### 3a. `POST /api/oracle/record` — the operator-triggered oracle path

`app/app/api/oracle/record/route.ts`. Authenticated by a shared secret, not a wallet.

- **Auth:** `x-oracle-secret` header, compared against `ORACLE_API_SECRET` with a length check and
  `timingSafeEqual`. Anything else is a 401.
- **Body:** `{ poolId, address, goalDays?, threshold? }`. `goalDays` defaults to 7, `threshold` to
  75; both must be integers in `1..100`.
- **Membership gate:** `participantJoined(poolId, address)` reads `getParticipant` on-chain. A
  wallet that never called `joinPool` gets a 403. `joinPool` enforces one wallet, one entry.
- **Provider gate:** `isConnected(address)` against Junction. No linked provider is a 404 pointing
  at `POST /api/junction/link`.
- **Verdict:** `getProgress(address, threshold, goalDays)` returns `streakDays`, the count of days
  in the window whose best sleep score met `threshold`. Days over threshold are counted rather
  than required consecutive, so one missing day of wearable data does not reset progress.
  `verdict = streakDays >= goalDays`.
- **Multiplier:** base `10000` bps, plus `2500` when the preceding week (days 8-14 back) averaged
  under 60, capped at `30000` (`deriveMultiplierBps`, `app/lib/server/oracle.ts:53`).
- **Write 1 — `recordResult`:** simulated first so revert reasons surface readably. An
  `ALREADY_RECORDED` revert is treated as success and falls through, otherwise a retry could never
  reach write 2.
- **Write 2 — `recordVerdict`:** only on a PASS, and only when `HEALTH_VERDICT_ADDRESS` is set.
  Confidence is `high` (a threshold check against provider data is deterministic, not a
  probabilistic judgement); the reference is `junction:<address>:<n>d`; the facet bitmap is
  `wearable` (bit 0), never `AI_ATTESTED` — tagging a deterministic streak check as TEE-attested
  would write a false provenance claim to a chain anyone can read back.
  A failure here returns **502**, not 200: the result is on-chain but the goal cannot pay out.
  Retrying the same request is safe and is the fix.
- **Never written on a FAIL.** `recordVerdict` is one-shot, so recording a failing verdict would
  permanently block a later passing one for the same goal.
- **Response:** `{ txHash, verdict, multiplierBps, streakDays }`.

### 3b. The browser wearable path

`app/components/WearableCheck.tsx` posts to `/api/agent/run/[goalId]` with no `attesterId`. The
server refuses a caller-supplied reference and synthesizes `wearable-<periodStart>` from the chain,
so one claim cannot be split across two ledger keys. `wearableEvidenceSource`
(`app/lib/server/agent/wearable.ts`) reads Junction scoped to the pool period and derives the same
streak verdict; `parseWearableGoal` pulls the day count and score threshold out of the pool's own
goal text, falling back to 7 days at 75. SPOTTER then records and settles.

Only the derived streak count crosses that boundary. Raw sleep records stay inside `junction.ts`
and never reach the ledger, the reasoning step, or the chain.

---

## 4. The document flow

Two routes, because TEE inference is asynchronous.

### Step 1 — `POST /api/evidence/submit`

`app/app/api/evidence/submit/route.ts`. Returns `{ attesterId }`.

- **Body:** `{ poolId, address, fileBase64, contentType }`. `contentType` is one of `image/png`,
  `image/jpeg`, `application/pdf`, `text/plain`.
- **The caller does not choose the goal.** `goalSpec` in the body is accepted for wire
  compatibility with older clients and **ignored**; the pool's on-chain `goalSpec` is the only
  value that reaches the enclave. A mismatch is logged, never honored.
- **The caller does not choose the filename** either — it travels into the enclave request beside
  the prompt, so the server generates it.
- **File validation** happens first and is server-side: size, base64, and magic bytes against the
  declared content type. These checks are pure and cost nothing, so junk never reaches a chain read
  or the enclave.
- **Pool checks:** the pool must exist, must be a `[doc]` pool, and must not be settled (409).
- **Membership gate** before the enclave is touched, because TEE inference costs real money.
- **Job attribution:** `rememberAttesterJob(attesterId, poolId, address)` is written *before* the
  id is handed out. Everyone in a pool shares its `goalSpec`, so an unattributed job id would let
  one participant collect on another's evidence. If that write fails the route returns 503 rather
  than a dead id.
- **Prompt hardening:** untrusted text is sanitized and fenced in `<<<BEGIN ...>>>` markers, and the
  system prompt instructs the model never to follow instructions found inside them.

### Step 2 — `POST /api/agent/run/[goalId]`

`app/app/api/agent/run/[goalId]/route.ts`. The browser polls it; each poll resumes the run wherever
it stopped, because the ledger carries the state.

- **Path integrity:** the path `goalId` must equal the chain-derived `computeGoalId(poolId,
  address)`. The correct id is deliberately not echoed back on a mismatch.
- **Membership gate,** before the plan entry and therefore before any spend.
- **Evidence kind comes from the chain** (the `[doc]` marker), so a document pool cannot be claimed
  with wearable data or the reverse. A body that disagrees is rejected.
- **Job ownership:** the `attesterId` must be a job this claim submitted.
- **Run statuses** (`RunStatus`, `app/lib/server/agent/run.ts:135`): `verifying`, `cap-exceeded`,
  `no-pay`, `blocked`, `recorded`, `paid`, `error`. `recorded` means both on-chain writes landed;
  `paid` is derived only from a real `AchieverPaid` event.
- **Ledger visibility:** the run itself is unauthenticated by design and safe, because every step
  is idempotent, spends are deduped and capped, and the writes are gated by the verdict rather than
  by the caller. The *full* ledger carries model-authored prose about someone's medical document,
  so it is released only to a caller who proves control of the participant address with an EIP-191
  signature. Everyone else gets the redacted money-facts projection.

### Fail-closed

Non-negotiable: no failure mode of the attester client may produce `verified=true`.

| Situation | `submitInference` returns | `pollInference` resolves to |
| --- | --- | --- |
| Attester reachable | real job id | `verifying` then `completed` with the real verdict |
| No `CONFIDENTIAL_AI_API_KEY`, or submit errored, `DEMO_MODE` off | `fail-<random>` | `failed`, `verified=false`, never recorded |
| Same, `DEMO_MODE=true` | `mock-<random>` | `completed`, `verified=true` — **local demos only** |
| Mock id seen with `DEMO_MODE` off | — | `failed`, refuses to record |
| Transport failure while polling | — | `unavailable`, verdict **null** |

`unavailable` is not `failed`. "The attester says no" is a durable verdict; "we could not reach the
attester" is an outage. Recording the second as a verdict would permanently fail a claim that a
retry seconds later would have paid, so it resolves to a null verdict and the run loop re-polls.

`DEMO_MODE` is off by default and must stay off anywhere real money moves.

### Privacy boundary

Document bytes go to the attester for inference only. They are not persisted to disk, not written
to chain, and not logged. Only the verdict struct (`verified`, `confidence`, `reason`) comes back,
and only `verified` plus a confidence byte and an advisory digest reach the registry. This is the
product's core claim; do not route raw health data anywhere else.

---

## 5. The on-chain gate proof (2026-07-27)

The gate is not decorative, and this was proven on chain rather than argued.

`scripts/tier1-gate-proof.sh` deploys a fresh gated HealthPools (proof instance
`0x474F61Fffd27e17F3c702982c84291567368925d`), wires it to the canonical registry, and runs two
participants through **identical passing oracle results**. The only difference is that one has a
`HealthVerdict` verdict and the other does not.

```
A (verdict)     6993004 -> 8993004   = +2.00 USDC
B (no verdict)   478608 ->  478608   = +0
```

Settle tx: `0xfdaff54d7a38d0c38a2ac94048086ef95b4475566dc7e9084b48d20bc34d28f6`

That is the whole argument: no verdict, no payout. It also confirms the new `goalId` schema agrees
across all four layers — the live CRE dry-run id, `HealthPools.computeGoalId` and
`HealthVerdict.computeGoalId` all produced `0x819ca618…ea692` for the same inputs.

The proof instance is deliberately separate from the canonical deployment so the demo pools stay
untouched.

---

## 6. Manual QA runbook

Numbered steps to verify Path A works today. Steps 1 and 2 need only a phone. Steps 3 onward need a
laptop with `foundry` on `PATH` and a populated `.env`.

**The rule that governs all of it: assert on the USDC balance delta, never on transaction success.**
A settle that pays nobody still returns a successful receipt.

### The 15-minute path

Steps 1, 2 and 4. Step 4 is the complete end-to-end proof and takes about three minutes of
wall-clock once the dev server is up. Steps 3, 5 and 6 are optional depth.

### 0. Preflight

- `.env` at the repo root feeds the shell scripts. `app/.env.local` feeds the Next app — its
  project root is `app/`, so it does **not** read the repo-root `.env`. This is the single most
  common "why is my key not working" cause.
- Repo-root `.env` needs: `ARC_RPC_URL`, `HEALTH_POOLS_ADDRESS`, `HEALTH_VERDICT_ADDRESS`,
  `DEPLOYER_PRIVATE_KEY`, `ORACLE_SIGNER_PRIVATE_KEY`.
- `app/.env.local` additionally needs `ORACLE_API_SECRET` (step 3), `JUNCTION_*` (steps 3 and 5),
  `CONFIDENTIAL_AI_API_KEY` (step 4), and `CIRCLE_*` plus `SPOTTER_WALLET_ADDRESS` (step 4's settle
  leg, which SPOTTER pays for).
- The deployer needs roughly 1.5 USDC of headroom; gas on Arc is native USDC. Top up at
  <https://faucet.circle.com>.

### 1. Confirm the deployment is the gated one (phone, 1 min)

Open <https://testnet.arcscan.app/address/0xc4274eF2cBe28f77Af31b980055Cc1171818390C> and confirm
the contract exists and has recent transactions.

Expected: the address matches the CURRENT block in `DEPLOYMENTS.md`. If it does not, `DEPLOYMENTS.md`
wins and the rest of this section should be re-read against the address listed there.

### 2. Confirm the gate is on and pointed at the right registry (laptop, 1 min)

```bash
export PATH="$PATH:$HOME/.foundry/bin"
RPC=https://rpc.testnet.arc.network
POOLS=0xc4274eF2cBe28f77Af31b980055Cc1171818390C

cast call "$POOLS" "healthVerdict()(address)"  --rpc-url "$RPC"
cast call "$POOLS" "oracle()(address)"          --rpc-url "$RPC"
cast call 0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042 "attester()(address)" --rpc-url "$RPC"
cast call 0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042 "forwarder()(address)" --rpc-url "$RPC"
```

Expected:

- `healthVerdict()` returns `0x9bf5…F042`. A zero address means the gate is OFF and any passing
  result pays without a registry verdict.
- `oracle()` and `attester()` return the same address as each other — either the legacy oracle
  `0xA56e…F7F2D` or SPOTTER's Circle wallet. If they differ, `set-agent-oracle.sh` was half-applied
  and the record step is half-broken.
- `forwarder()` returns `0x76c9…5E62` (Path B's receiver, live but unused).

### 3. Wearable Path A by hand (laptop, 3 min, needs a linked provider)

Run the app with `cd app && pnpm dev`. Pick a wearable pool (one whose `goalSpec` has no `[doc]`
prefix), join it from the UI with a wallet, and link a health-data provider from the dashboard.

```bash
POOL=1
ADDR=0xYourJoinedWallet

curl -s -X POST http://localhost:3000/api/oracle/record \
  -H 'Content-Type: application/json' \
  -H "x-oracle-secret: $ORACLE_API_SECRET" \
  -d "{\"poolId\":\"$POOL\",\"address\":\"$ADDR\",\"goalDays\":7,\"threshold\":75}"
```

Expected outcomes:

| Response | Meaning |
| --- | --- |
| `401` | wrong or missing `x-oracle-secret` |
| `403` | that wallet never called `joinPool` on that pool |
| `404` | no health-data provider linked for that wallet |
| `200 {"verdict":false,…}` | streak short of the goal; nothing written to the registry, by design |
| `200 {"verdict":true,"txHash":"0x…"}` | both writes landed |
| `502` | result recorded, registry write failed — **not settleable yet**; retry the same request |

Then confirm the registry actually cleared the goal:

```bash
GOALID=$(cast call "$POOLS" "computeGoalId(uint256,address)(bytes32)" "$POOL" "$ADDR" --rpc-url "$RPC")
cast call 0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042 "canSettle(bytes32)(bool)" "${GOALID%% *}" --rpc-url "$RPC"
```

Expected: `true` after a `verdict:true` response. A `200` with `verdict:true` and `canSettle`
returning `false` is the exact failure mode the 502 exists to prevent — treat it as a bug.

### 4. Document Path A end to end, agent-driven (laptop, 3 min) — the real proof

With the dev server running:

```bash
./scripts/doc-evidence-test.sh
```

It creates a short-period `[doc]` pool, joins it, uploads `app/public/demo-evidence/cholesterol-panel.txt`
through `/api/evidence/submit`, then polls `POST /api/agent/run/<goalId>` — the same door the
frontend uses — until SPOTTER records the verdict, waits out the 90-second period, and lets SPOTTER
settle.

Expected final lines:

```
final agent status: paid
USDC before settle <N> -> after <M> (gain <positive> uUSDC)
PASS: full document-evidence chain proven on-chain, agent-driven (create -> join -> doc -> attester verdict -> SPOTTER record -> SPOTTER settle -> paid)
```

Anything else, read the status:

| Status | Meaning |
| --- | --- |
| `verifying` forever | attester still queued, or unreachable — check `CONFIDENTIAL_AI_API_KEY` |
| `no-pay` | the attester judged the document as not meeting the goal |
| `cap-exceeded` | the per-claim verification spend cap was hit |
| `blocked` | a sibling run or the sweep holds the claim lock; poll again |
| `error` | a write failed; the ledger entry names the stage |
| `paid` but zero gain | the pool has no pot, or a bounty-model-zero pool with `entryFee = 0` |

That last row is the one to watch. A pool created with `entryFee = 0` on bounty model 0 pays
`entryFee * multiplier / BPS` = zero. Settle succeeds, `AchieverPaid` never fires, nobody is paid.
Every entry-0 pool must use model 1 (pro-rata pot split); `scripts/demo-reset.sh` enforces this for
the pools it seeds.

### 5. `happy-path-test.sh` — read this before you run it

```bash
./scripts/happy-path-test.sh
```

It proves the leg the Foundry tests cannot cover: the oracle key signing a real `recordResult`
against the deployed contract on Arc. It creates a short-period split-pot pool, joins, records,
waits about 90 seconds, settles, and asserts on the USDC delta.

**It does not write a `HealthVerdict`.** Against the canonical gate-ON deployment it will therefore
settle to zero and print `FAIL: no USDC gain on settle` — correctly, because that is exactly what
the gate is for. Two ways to use it honestly:

- Point it at a gate-off deployment: `GATE=off ./scripts/demo-reset.sh` first. That is the
  oracle-only configuration the script was written against.
- Or treat step 4 as the gated end-to-end proof and use this script only for the ungated
  record-and-settle leg.

It also signs with `ORACLE_SIGNER_PRIVATE_KEY` directly, so it reverts if
`scripts/set-agent-oracle.sh` has handed the oracle role to SPOTTER.

The script creates a real pool on whatever `HEALTH_POOLS_ADDRESS` points at. Run
`./scripts/demo-reset.sh` afterwards to clear the residue before a demo.

### 6. Prove the gate is load-bearing (laptop, 4 min, optional)

```bash
./scripts/tier1-gate-proof.sh
```

Deploys a throwaway gated HealthPools, wires it to the `HEALTH_VERDICT_ADDRESS` currently in `.env`,
and runs two participants through identical passing results. Expected: the verdict-backed
participant gains USDC and the other gains exactly zero. This reproduces section 5 from scratch and
leaves the canonical deployment untouched.

### 7. Clean slate

```bash
./scripts/demo-reset.sh                     # fresh deploy, gate ON, seed five pools
GATE=off ./scripts/demo-reset.sh            # oracle-only, no registry
EXISTING_POOLS=0x… ./scripts/demo-reset.sh  # seed into the current contract
./scripts/set-agent-oracle.sh               # hand both roles to SPOTTER (re-run after every reset)
```

`demo-reset.sh` syncs the new addresses into `.env`, `app/.env.local`, and `DEPLOYMENTS.md`, which
keeps `HEALTH_VERDICT_ADDRESS` in lockstep with the on-chain gate. That lockstep is load-bearing:
`recordVerdict` no-ops when the env var is unset, and `verdictCanSettle` throws rather than waving a
payout through.

---

## 7. Failure modes worth memorizing

- **Successful transaction, nobody paid.** Either the registry verdict is missing (`canSettle`
  false) or the pool is entry-0 on bounty model 0. Always check the USDC delta.
- **502 from `/api/oracle/record`.** The result is on-chain, the registry write is not, and the
  participant cannot be paid until it succeeds. Retry the same request; `recordResult` will not be
  duplicated.
- **`recordVerdict` is one-shot per goal.** Only a passing verdict is ever written, because a
  failing one would permanently block a later pass. Only the registry owner can override.
- **`ALREADY_RECORDED` is success,** not failure — it is the end state both writes want.
- **A revert on `recordResult` after `set-agent-oracle.sh`.** The legacy signer no longer holds the
  role. Check `oracle()` on-chain.
- **`DEMO_MODE=true` mints verified verdicts.** Local demos only. Never anywhere money moves.
- **Verdicts recorded against the old registry `0x4E65…1c51` are dead** — they were written under
  the old `goalId` formula and satisfy nothing.

## 8. Source map

| Concern | File |
| --- | --- |
| Wearable oracle route | `app/app/api/oracle/record/route.ts` |
| Document submit route | `app/app/api/evidence/submit/route.ts` |
| Agent run route | `app/app/api/agent/run/[goalId]/route.ts` |
| `recordResult` + multiplier | `app/lib/server/oracle.ts` |
| `recordVerdict` + `computeGoalId` | `app/lib/server/verdict.ts` |
| Membership and `canSettle` reads | `app/lib/server/pools.ts` |
| Attester client, fail-closed rules | `app/lib/server/judge.ts` |
| Junction streak derivation | `app/lib/server/junction.ts` |
| Wearable evidence source | `app/lib/server/agent/wearable.ts` |
| SPOTTER run loop | `app/lib/server/agent/run.ts` |
| Settlement gate | `contracts/src/HealthPools.sol` |
| Verdict registry | `contracts/src/HealthVerdict.sol` |
