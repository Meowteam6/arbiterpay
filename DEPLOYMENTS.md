HealthPools (Arc testnet, chain 5042002)

## CURRENT (canonical) — gated, 2026-07-27
- HealthPools: 0xc4274eF2cBe28f77Af31b980055Cc1171818390C
- HealthVerdict: 0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042
- Explorer: https://testnet.arcscan.app/address/0xc4274eF2cBe28f77Af31b980055Cc1171818390C
- Oracle signer / registry attester: 0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D
- KeystoneForwarder: 0x76c9cf548b4179F8901cda1f8623568b58215E62 (Arc testnet, from Chainlink's
  CRE forwarder directory) — HealthVerdict.onReport is LIVE, not simulation-only.
- Settlement gate: ON. settle() requires HealthVerdict.canSettle(goalId) per achiever.
- Seeded via scripts/demo-reset.sh: sleep (Dreamwell), recovery (Vitality), steps (Iron Gym),
  flu-shot [doc], screening [doc]
- Re-seed / clean slate: run ./scripts/demo-reset.sh (deploys both, wires forwarder + gate,
  syncs env, appends this file). GATE=off for the oracle-only path.

### goalId schema changed here (breaking)
goalId is now `keccak256(abi.encode(address pools, uint256 poolId, address participant,
uint64 periodStart))` — previously `keccak256(abi.encode(poolId, participant))`. The pool
contract address domain-separates the shared registry (without it, pool id 1 on two
HealthPools deployments produce the same goalId, so a verdict earned on one would satisfy
canSettle on the other); periodStart scopes a verdict to one pool period. Verdicts recorded
against the OLD registry 0x4E65…1c51 are not valid under the new formula — that registry and
every pre-2026-07-27 HealthPools are dead.

## Superseded
- 0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064 (was canonical through 2026-07-27; predates the
  gate selectors — `healthVerdict()` reverts on it, so it can never consult the registry.
  Held 119.25 USDC across 15 demo pools at cutover; abandoned, not migrated.)
- 0x4527e4b2ee489282fb01fe890487149f9f1aaa46 (first deploy; had the now-shelved pushups pool)
- 0xEA46F189860AC7d07801ed25E4ABD246a3a31A02 (empty, deploy-path debug)
- HealthVerdict 0x4E65F11b65b53A328713B40C02A1BC1F421E1c51 (old goalId schema, forwarder never set)

## Demo reset 2026-06-13T02:42:17Z
- HealthPools: 0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064
- Explorer: https://testnet.arcscan.app/address/0x72D3E2E46eb7f7aC70DcaF27426D7f3aA5cf2064
- Seeded: sleep (Dreamwell), recovery (Vitality), steps (Iron Gym)

## HealthVerdict registry (Tier 1 — Chainlink verdict gate) 2026-06-13
- HealthVerdict: 0x4E65F11b65b53A328713B40C02A1BC1F421E1c51
- Explorer: https://testnet.arcscan.app/address/0x4E65F11b65b53A328713B40C02A1BC1F421E1c51
- Owner: 0xc278e8e4621A0Ba02bACB6291E595ecd168A04e1 (deployer) | Attester: 0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D (oracle) | Forwarder: unset (onReport/DON path is Tier 2)
- canSettle(goalId) gates HealthPools._isAchiever when HealthPools.setHealthVerdict points here.
- NOTE: the canonical prod HealthPools (0x72D3...2064) predates the gate selectors, so it cannot consult the registry. Wiring it requires a redeploy.

## Gated HealthPools (Tier 1 gate proof instance) 2026-06-13
- HealthPools (gated): 0x5bf7CD46d1f6D8AE8889ea63C65AF54DFCB22cF4 — setHealthVerdict -> 0x4E65...1c51
- Proof: scripts/tier1-gate-proof.sh — two identical participants, only the verdict-backed one paid (2 USDC vs 0).
- Settle tx: 0x3e26d9a0e9fb71339323b7bb0754e0bca614ff392ae8cfca72bf17605c8c8c53
- Separate from prod on purpose (prod demo untouched).

## Demo reset 2026-07-27T22:21:45Z
- HealthPools: 0xc4274eF2cBe28f77Af31b980055Cc1171818390C
- Explorer: https://testnet.arcscan.app/address/0xc4274eF2cBe28f77Af31b980055Cc1171818390C
- Seeded: sleep (Dreamwell), recovery (Vitality), steps (Iron Gym),
          flu-shot [doc], screening [doc] (preventive-care, document-verified)
- HealthVerdict: 0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042 (attester 0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D)
- Forwarder: 0x76c9cf548b4179F8901cda1f8623568b58215E62 (Arc KeystoneForwarder — CRE onReport path LIVE)
- Settlement gate: ON (settle requires canSettle(goalId))

## Gate proof against the new registry 2026-07-27
- Gated HealthPools (proof instance): 0x474F61Fffd27e17F3c702982c84291567368925d -> 0x9bf5...F042
- Proof: scripts/tier1-gate-proof.sh (now reads HEALTH_VERDICT_ADDRESS from .env, not a hardcoded address)
- Two participants, IDENTICAL passing oracle results; only the one with a HealthVerdict was paid:
  A (verdict) 6993004 -> 8993004 = +2.00 USDC | B (no verdict) 478608 -> 478608 = +0
- Settle tx: 0xfdaff54d7a38d0c38a2ac94048086ef95b4475566dc7e9084b48d20bc34d28f6
- Confirms the new goalId schema and the gate are load-bearing on chain: no verdict -> no payout.

## Demo reset 2026-07-31T06:36:20Z
- HealthPools: 0xc4274eF2cBe28f77Af31b980055Cc1171818390C
- Explorer: https://testnet.arcscan.app/address/0xc4274eF2cBe28f77Af31b980055Cc1171818390C
- Seeded: sleep (Dreamwell), recovery (Vitality), steps (Iron Gym),
          flu-shot [doc], screening [doc] (preventive-care, document-verified)
- HealthVerdict: 0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042 (attester 0xA56eAD3A32b6261bDE6C2A45495C9250084F7F2D)
- Forwarder: 0x76c9cf548b4179F8901cda1f8623568b58215E62 (Arc KeystoneForwarder — CRE onReport path LIVE)
- Settlement gate: ON (settle requires canSettle(goalId))
