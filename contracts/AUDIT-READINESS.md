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

## What was added to the suite

New file: `contracts/test/HealthPoolsInvariant.t.sol` (11 tests). Config: `[fuzz]` and
`[invariant]` profiles added to `foundry.toml`. Baseline was 65 tests; suite is now 76,
all green.

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
forge test                                          # full suite, 76 pass
forge test --fuzz-runs 10000 --match-contract HealthPoolsFuzzTest
FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=200 \
  forge test --match-contract HealthPoolsInvariantTest
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
