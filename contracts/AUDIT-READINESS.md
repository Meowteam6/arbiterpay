# Contract Audit-Readiness Gate

Internal pre-audit review of the GoHealthMe settlement contracts. This is the Phase-2
entry gate that must clear before engaging a paid smart-contract auditor. It is an
internal readiness assessment, not a substitute for that audit.

- Scope: `contracts/src/HealthPools.sol`, `contracts/src/HealthVerdict.sol`
- Method: expanded Foundry invariant + fuzz suite (balance-delta assertions only),
  Slither 0.11.6 static analysis, and a manual security pass.
- Contracts were treated as immutable and were not modified. All remediation notes
  below target the creation/config layer, an off-chain guard, or a future audited
  redeploy, never an edit to the deployed bytecode.

## Verdict: CONDITIONAL PASS

The money-safety core is sound. Across 51,200 stateful invariant calls and 10,000 fuzz
runs per property, the contract never paid out more than it held, never desynced its
ledger from real USDC holdings, and never created or destroyed value. No fund-theft or
insolvency path was found.

One High-severity defect (F-1) and the known-and-accepted centralization/permissionless
surface below must be written into the auditor's scope brief before Phase 2 opens. F-1 is
a live production defect (three of five deployed pools), not a latent one.

---

## Remediation status (this pass)

Each finding is closed in exactly one of three ways, never conflated:

- **app-guarded-live** — the deployed bytecode is immutable, so the finding is *prevented*
  at the creation/config layer on the live contract, not *fixed* in it.
- **fixed-in-V2** — a mechanical fix lands in the remediation candidate
  `contracts/src/HealthPoolsV2.sol` (banner: UNAUDITED, NOT DEPLOYED). It closes the finding
  only once that audited contract is deployed; on the live contract the finding stands.
- **decision-gated** — a posture the founders (and the auditor) must rule on. V2 leaves it
  functionally identical to v1 on purpose; changing it is a governance/product call, not a
  code defect.

`HealthPools.sol` and `HealthVerdict.sol` were not touched (empty git diff). The suite is now
**117 tests** (76 v1 baseline unchanged + 41 new V2: 27 unit, 2 gas, 9 fuzz at 256 runs,
3 stateful-invariant), all green.

| ID | Severity | Resolution | Proof (guard / test) | On the live immutable contract |
|---|---|---|---|---|
| F-1 | High | app-guarded-live **and** fixed-in-V2 | app: `isEconomicallyDeadConfig` in `app/lib/pool-lifecycle.ts`, enforced at the `runUsdcDeposit` funnel (`app/lib/useUsdcDeposit.ts`, the chokepoint every USDC-pulling createPool passes) and again at the `CreatePool.tsx` submit; scripts: `scripts/assert-payable.sh` sourced by all five createPool scripts; app tests `pool-lifecycle.test.ts` (15). V2: `createPool` reverts `DEAD_CONFIG` — `test_finding_F1_deadConfigRevertsAtCreate`, `test_finding_F1_guardIsNarrow`, `testFuzz_F1_model0ZeroFeeAlwaysReverts` | **PREVENTED, not fixed.** No new dead pool can be created through the app or scripts. The three already-dead pools stay dead forever (`entryFee` is write-once); nothing off-chain can repair them. |
| F-2 | Medium | decision-gated | V2 `recordResult`/`_isAchiever` functionally identical to v1 (`onlyOracle`, registry as AND-gate), carrying an inline `DECISION-GATED (F-2)` comment | Unchanged. Founder/auditor posture: gate-on enforcement + oracle key custody. |
| F-3 | Medium (KNOWN) | decision-gated | V2 `settle()`/`settleStep()` both `external nonReentrant`, no auth — permissionless posture preserved; inline `DECISION-GATED (F-3)` comment. **NB: settle() body is rewritten for F-4, so it is not byte-identical to v1 — the access-control decision is what is unchanged.** | Unchanged and deliberate (zero-Solidity-change Circle settler). |
| F-4 | Medium | fixed-in-V2 (pagination) | V2 3-phase idempotent state machine + `settleStep(poolId, maxSteps)`. `test_F4_v1SingleSettleExceedsBlockLimit`, `test_F4_v2PaginatedSettleStaysUnderBlockLimit`, `test_F4_paginatedEqualsSingleCall`, `testFuzz_F4_paginationPaysSameAsAtomic`, `test_F4_settleFinishesAPartialSettleStep`, `test_F4_sweepBlockedUntilSettlementComplete` | **UNRESOLVED on live.** No app-layer mitigation exists — a pool grown to the caps with the gate ON is unsettleable and its funds lock. Measured below. Only the V2 redeploy closes it. |
| F-5 | Low | fixed-in-V2 (balance-delta) | V2 `_pull`/`_push` credit the measured delta; `test_finding_F5_feeOnTransferCreditsMeasuredDelta` | Assumption only for Arc USDC (standard 6-decimal). Live risk = zero unless the asset is ever swapped. |
| F-6 | Low | fixed-in-V2 (multiply-before-divide) | V2 `_achieverPayout` uses un-floored weights; `test_finding_F6_multiplyBeforeDivideKeepsPrecision` | Live rounds down, never overpays (dust to creator). Cosmetic. |
| F-7 | Low | fixed-in-V2 (constructor code check) | V2 constructor `require(token.code.length > 0)`; `test_finding_F7_constructorRejectsNonContractToken` | Deploy-time only. Live `usdc` is the canonical Arc contract — non-issue. |
| F-8 | Info | reviewed non-exploitable | No change. `nonReentrant` + per-iteration CEI + USDC has no callback (V2 preserves all three) | No action. |
| F-9 | Info | decision-gated | V2 `setOracle`/`setHealthVerdict(0)`/`transferOwnership` functionally identical to v1, inline `DECISION-GATED (F-9)` comment | Unchanged trusted-owner posture. Timelock/multisig is a governance call. |

### F-4 measured gas ceiling (the single most important number)

Profiled at `MAX_PARTICIPANTS` (200) x `MAX_BACKERS_PER_GOAL` (50) with the verdict gate ON,
against a 30,000,000-gas block:

| Path | Gas | Verdict |
|---|---|---|
| v1 single `settle()` (the live contract) | **76,964,345** | ~2.57x a 30M block — the maxed pool cannot settle in one transaction; funds lock. The fund-lock risk is real, not theoretical. |
| V2 `settleStep(poolId, 2)`, worst single step | **881,127** | Comfortably under a block. |
| V2 full drain of the same pool | **300 steps** | Every step < 30M; all achievers paid (asserted on the aggregate USDC delta), remaining balance < rounding dust, contract solvent throughout. |

So the audit's flagged fund-lock is reproduced on the immutable contract and closed in V2 —
but only closed in production when the audited V2 is deployed.

### Overclaims caught and corrected in this pass

Two claims from the build summaries were imprecise and are corrected here:

1. *"F-2 / F-3 / F-9 are byte-for-byte identical to v1."* True for **F-2 and F-9** (their
   function bodies are unchanged bar an added comment). **False for F-3:** V2's `settle()` is
   fully rewritten for the F-4 pagination fix, and V2 adds a new permissionless `settleStep()`.
   What is preserved is F-3's **access-control decision** (both entry points are permissionless,
   no auth) — the decision is not silently changed, but the code is not byte-identical.
2. *"V2's single-call settle() is numerically identical to v1 for every pool v1 can settle."*
   True for pot-split and fully-funded fixed-bounty pools. **The underfunded multi-achiever
   fixed-bounty branch deliberately differs** — F-6 multiplies the un-floored weight before
   dividing, so per-achiever payouts round more precisely than v1. It never overpays the pot
   (`testFuzz_fixedBounty_neverExceedsOwedOrPot`), but it is an intended improvement, not
   parity.

### Decision-gated items the founders must still rule on

No `Mainnet-Roadmap.md` exists yet; the V2 inline comments forward-reference one. These are the
rulings that doc should capture (do not treat any as resolved):

- **F-3 permissionless `settle()`** — keep it permissionless (what makes the Circle agent a
  zero-Solidity-change settler) versus the authorized-settler + public-grace-fallback redesign.
  This is the reward-vs-wager / custodial call and is intentionally NOT made in V2.
- **F-2 oracle trust** — confirm the verdict gate is ON in production and set the oracle
  key-custody posture to match the treasury.
- **F-9 owner privileges** — trusted-owner (current) versus a timelock/multisig for
  `setOracle` / `setHealthVerdict(0)` / `overrideVerdict` / `transferOwnership`.

---

## What was added to the suite

New file: `contracts/test/HealthPoolsInvariant.t.sol` (11 tests). Config: `[fuzz]` and
`[invariant]` profiles added to `foundry.toml`. This raised the v1 suite from 65 to 76
tests. The remediation candidate then added `contracts/src/HealthPoolsV2.sol` and its
41-test suite `contracts/test/HealthPoolsV2.t.sol`, for **117 total, all green** (see
Remediation status above for the finding-by-finding mapping).

Stateful invariants (Handler-driven random lifecycle: create -> join -> back/fund ->
record -> warp -> settle -> sweep):

| Invariant | Asserts |
|---|---|
| `invariant_ledgerMatchesTokenBalance` | sum of every pool's `balance` == USDC the contract actually holds |
| `invariant_tokenConservation` | no USDC minted or burned across the whole lifecycle |
| `invariant_noPoolExceedsHoldings` | no single pool claims more than the contract holds |

Fuzz properties (every assertion is a USDC delta or the `paid + remaining == pot`
conservation identity, never tx success):

| Test | Invariant covered |
|---|---|
| `testFuzz_potSplit_conservesAndNeverOverpays` | pot-split pays <= pot, conserves ledger, leaves only sub-unit dust |
| `testFuzz_fixedBounty_neverExceedsOwedOrPot` | fixed bounty pays <= min(owed, pot); exact when fully funded |
| `testFuzz_backerBonus_capped` | backer gets stake + <= 20%, never loses principal on a winner, aggregate <= stakes + affordable bonus |
| `testFuzz_gate_noVerdictNoPayout` | verdict gate ON with no verdict -> achiever paid zero |
| `testFuzz_gate_withVerdictPays` | verdict gate ON with passing verdict -> sole achiever paid the pot |
| `testFuzz_nullifier_cannotBeReused` | one-wallet-one-entry: reused nullifier reverts; double-join reverts |
| `testFuzz_settle_idempotent` | second `settle()` reverts and moves zero USDC |
| `test_finding_fixedBountyZeroFeeStrandsFunding` | pins F-1 below |

Reproduce:

```
cd contracts && export PATH="$HOME/.foundry/bin:$PATH"
forge test                                          # full suite, 117 pass
forge test --fuzz-runs 10000 --match-contract HealthPoolsFuzzTest
FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=200 \
  forge test --match-contract HealthPoolsInvariantTest
forge test --match-contract HealthPoolsV2GasTest -vv # F-4 gas profile at 200 x 50
```

---

## Findings (severity-ranked)

| ID | Severity | Contract:line | Blocks real money | Title |
|---|---|---|---|---|
| F-1 | High | HealthPools.sol:446-489 (with :195, :312) | Yes | Model-0 + entryFee 0 accepts funding but pays achievers zero; creator sweeps it all |
| F-2 | Medium | HealthPools.sol:75, :233-247 | Trust-gated | Oracle is fully trusted for pass/fail and multiplier |
| F-3 | Medium | HealthPools.sol:291-303 | Griefing | Permissionless `settle()` can be front-run to forfeit late/pending verdicts (KNOWN) |
| F-4 | Medium | HealthPools.sol:291-303, :364-372, :68-69 | Liveness | `settle()` gas is unbounded enough that a maxed pool may be unsettleable, locking funds |
| F-5 | Low | HealthPools.sol:494-503 | Assumption | Accounting assumes a standard non-fee, non-rebasing ERC-20; no balance-delta measurement |
| F-6 | Low | HealthPools.sol:468-469 | No | Divide-before-multiply in the underfunded fixed-bounty scaling (rounds down, favors pool) |
| F-7 | Low | HealthPools.sol:494-503 | No | `_pull`/`_push` do not check the token address has code |
| F-8 | Info | HealthPools.sol:426-442, :176-205 | No | Slither reentrancy-no-eth: reviewed non-exploitable (nonReentrant + per-iteration CEI + USDC has no callback) |
| F-9 | Info | HealthVerdict.sol:225-246, HealthPools.sol:153-170 | Trust-gated | Owner can override verdicts, swap the oracle, and disable the verdict gate |

### F-1 (High) — Economically dead pool config drains to the creator

`_payAchievers` bounty model 0 owes each achiever `entryFee * multiplierBps / BPS`
(line 468). With `entryFee == 0` the owed sum is 0, `totalOwed == 0` returns early
(line 464), and `AchieverPaid` never fires. The transaction still succeeds. Every USDC
in the pool then remains as `p.balance` and is fully reclaimable by the pool creator via
`sweep()` (line 312), which takes the entire remaining balance.

This is the exact production defect in SPEC.md: both `[doc]` preventive-care pools were
created with `entryFee = 0, bountyModel = 0`, so three of five live pools settle to zero.

- Failure scenario (footgun): a sponsor funds a preventive-care pool, participants hit
  the goal and are verified, `settle()` succeeds, and nobody is paid.
- Failure scenario (adversarial): a creator deliberately opens a model-0, entryFee-0
  pool, attracts sponsor funding, lets it settle paying zero, and sweeps the whole pot.
- Pinned by `test_finding_fixedBountyZeroFeeStrandsFunding`: a 3x achiever in a
  1,000 USDC-funded pool receives 0; the creator sweeps the full 1,000.

The contract is arithmetically correct per the documented model-0 formula. The gap is the
absence of an on-chain invariant `bountyModel == 0 => entryFee > 0`, and the absence of any
create-time check that a funded pool can pay. Because the deployed contract is immutable,
remediation is: (a) block this config at the createPool call site / product layer now, and
(b) add the guard to the audited redeploy. Do not build on model-0 pools with entryFee 0.

### F-2 (Medium) — Oracle trust

`recordResult` (lines 233-247, `onlyOracle`) is the sole source of pass/fail and the payout
multiplier (capped at 3x). A compromised or faulty oracle key can mark any participant an
achiever at up to 3x. This is by design and is partially mitigated when the HealthVerdict
gate is enabled (both the oracle result AND a passing registry verdict are required, per
`_isAchiever`, lines 364-372). Auditor should confirm the gate is ON in production and that
the oracle key custody matches the treasury posture.

### F-3 (Medium, KNOWN) — Permissionless settle front-running

`settle()` (lines 291-303) is `external nonReentrant`, gated only on
`block.timestamp > periodEnd` and `!settled`. Anyone may call it the instant the period
ends. A participant whose verdict has not yet been recorded (oracle path) or written to the
registry (gate path) is treated as a non-achiever and forfeits; their backers forfeit too.
An adversary can therefore front-run legitimate settlement to deny late-arriving verdicts.
This is documented as a deliberate, accepted tradeoff (it is what makes the Circle wallet a
zero-Solidity-change settler) and is on the roadmap to revisit post-submission. Listed here
so the auditor scopes it, not to re-litigate it.

### F-4 (Medium) — settle() liveness at maximum pool size

`settle()` iterates all participants (bounded 200, line 68) and, per achiever, all backers
(bounded 50, line 69), and re-invokes `_isAchiever` in several passes; when the verdict gate
is ON each `_isAchiever` is an external `canSettle` staticcall inside the loop (line 371).
A pool at 200 participants x 50 backers implies on the order of 10,000 token transfers plus
hundreds of registry calls in a single transaction. This can exceed the block gas limit.
Because `sweep()` requires `settled == true`, a pool whose `settle()` can never fit in a
block would have its funds permanently locked. The `MAX_*` caps bound the loop but may not
bound it below the gas limit. Auditor should gas-profile `settle()` at the caps with the
gate ON and confirm a real-world ceiling, or add pagination in the redeploy.

### F-5 (Low) — Non-standard ERC-20 assumption

`_pull`/`_push` (lines 494-503) are SafeERC20-style (tolerate no-return, revert on false or
call failure) but credit `p.balance += amount` without measuring the actual received delta.
A fee-on-transfer or rebasing token would leave `p.balance` overstated and eventually make a
`_push` revert on insolvency. Arc-testnet USDC is a standard 6-decimal token, so this is an
assumption to document rather than a live bug. Auditor should confirm the settlement asset
can never be swapped to a non-standard token.

### F-6 (Low) — Divide-before-multiply precision

In the underfunded fixed-bounty branch, `owed = (entryFee * mult) / BPS` (line 468) is
floored before `payout = (owed * pot) / totalOwed` (line 469). This loses precision versus a
single combined expression. It always rounds down and never overpays (confirmed by
`testFuzz_fixedBounty_neverExceedsOwedOrPot`); the residual is swept by the creator. Impact
is a few wei of achiever fairness, not solvency.

### F-7 (Low) — No token-code existence check

`_pull`/`_push` low-level `call` a token address that is never checked for `code.length > 0`.
A call to an address with no code returns `ok == true, data.length == 0`, which passes the
require. If `usdc` were ever set to a non-contract address, transfers would silently no-op
while the ledger advanced. `usdc` is immutable and constructor-checked non-zero, so this is a
deploy-time concern only. Verify the constructor argument at deploy.

### F-8 (Info) — Slither reentrancy-no-eth, reviewed

Slither flags state writes after external calls in `_payBackersOf` (line 436 vs the push at
438, across loop iterations) and in `createPool` (line 201 after `_pull` at 200). Both are
non-exploitable: every state-mutating entry point is `nonReentrant` on a shared lock,
`_payBackersOf` zeroes each backer's stake before pushing (per-iteration CEI), `_payAchievers`
decrements `p.balance` before pushing, and Arc USDC has no transfer callback. Documented as
reviewed so the auditor is not surprised by the static-analysis noise.

### F-9 (Info) — Owner privileges

Owner can `setOracle`, `setHealthVerdict(address(0))` to disable the gate, and
`transferOwnership` on HealthPools (lines 153-170), and can `overrideVerdict` arbitrarily plus
`setAttester`/`setForwarder`/`transferOwnership` on HealthVerdict (lines 133-153, 225-246).
`overrideVerdict` intentionally has no prior-verdict requirement and emits a distinct event.
This is a trusted-owner design; the note is for the auditor's trust-model section, and the
`setHealthVerdict` missing-zero-check that Slither reports is intentional (zero disables the
gate), not a bug.

---

## Known roadmap items (acknowledged, not novel)

These are already tracked in the repo's roadmap and CLAUDE.md and are surfaced here only so
the auditor sees them acknowledged rather than re-reported as new discoveries:

- Permissionless `settle()` griefing vector (F-3 above) — deliberate, revisit post-submission.
- Treasury-key server routes and the always-on developer-controlled Circle wallet as settler —
  key custody, not a contract issue; audit the operational boundary.
- Unauthenticated money-path API routes in `app/` — out of scope for this contract review;
  flagged in the app-layer triage, not here.
- Contracts are unaudited and testnet-only; mainnet requires this Phase-2 audit to pass first.

---

## What an external auditor should scope

1. `settle()` gas ceiling at `MAX_PARTICIPANTS` x `MAX_BACKERS_PER_GOAL` with the verdict
   gate ON (F-4) — the fund-lock liveness question is the single most important item.
2. The permissionless settlement timing model versus verdict-arrival timing (F-3): can an
   honest achiever ever be settled out before their verdict lands?
3. The create-time economic-validity gap (F-1): confirm the redeploy guards
   `bountyModel == 0 => entryFee > 0` and, ideally, that a funded pool can pay someone.
4. The full backer-bonus arithmetic across multiple achievers and the headroom cap
   (`_payBackers` line 415, `_payBackersOf` line 435) for any pro-rata rounding that could
   over-allocate the bonus pot — invariant-tested here as safe, but worth a formal look.
5. Oracle and owner trust model (F-2, F-9): key custody, gate-on enforcement, and the
   `overrideVerdict` escape hatch.
6. Settlement-asset immutability and standardness (F-5, F-7).

## Most important single item for the auditor

**Gas-profile `settle()` at the maximum participant and backer caps with the verdict gate
enabled (F-4).** Every other finding is either trust-model or a create-time guard; this one
is the only path found to permanently locked funds in an otherwise solvent contract, and it
is reachable through normal, non-adversarial growth of a popular pool.
