# GoHealthMe

Verified health goals with instant USDC rewards. Built at ETHGlobal New York 2026.

Insurers already pay people for healthy behaviors — through opaque points systems and gift cards that arrive weeks later. GoHealthMe puts that model on-chain: sponsor-funded USDC pools pay out the instant a verified behavior happens, with the verification done by a confidential, decentralized oracle rather than a company, and the settlement run by an agent named SPOTTER from its own Circle wallet.

Partners: Arc (USDC settlement chain), Circle (agent wallet + service payments), Chainlink (CRE + Confidential AI Attester verification).

## How it works

1. Anyone funds an initiative pool (sleep, workouts, preventive care) with USDC and published bounties
2. Participants join with their wallet — one wallet, one entry, enforced by the pool contract
3. Health data is verified off-chain (wearables via Junction — WHOOP/Oura/Fitbit/Garmin — or a Chainlink Confidential AI Attester judging the goal inside a TEE); only the verdict ever touches the chain
4. SPOTTER, the settlement agent, buys the verification it needs per claim, decides, and settles the pool from its own Circle wallet: achievers get paid (optionally to a private Unlink account derived from their own wallet signature, with no on-chain link to the goal), forfeits roll back into the pool
5. Optional: stake on your own streak for a multiplier, back someone else's goal, or top up USDC in one tap via Blink

## Architecture

```
Next.js (frontend + API) -- Dynamic embedded wallets + Unlink private payouts
   |          |
   |          +-- Junction Link (WHOOP/Oura/Fitbit/Garmin) -> health summary
   |                               |
   |              verdict path A (live demo): oracle signer
   |              verdict path B (Chainlink):
   |                Confidential AI Attester (TEE inference)
   |                  -> CRE workflow callback
   |                  -> DON-signed report
   |                  -> HealthVerdict.onReport
   |                               |
   |                               v
   |                    HealthPools.sol (Arc testnet)
   |                    USDC escrow / settle / multipliers / backing
   |                    settle() gates on HealthVerdict.canSettle() when enabled
```

Chains: Arc testnet (chain id 5042002, USDC-native) for the product and settlement. Chainlink CRE runs the off-chain goal-verification workflow. (ENS was evaluated as an identity/registry layer but dropped — Sepolia ENS was mid-migration to v2 during the event.)

Privacy invariant: raw health data never touches the chain — the Confidential AI Attester judges it inside a TEE and only the signed verdict (verified / confidence / digest) is recorded on-chain.

## Repo layout

- `contracts/` — Foundry: `HealthPools.sol` (pools, one-entry nullifier dedupe, settle, backing, multipliers) and `HealthVerdict.sol` (Chainlink verdict registry + `onReport` receiver); tests; deploy script
- `app/` — Next.js App Router: frontend and API routes (evidence, agent run, oracle signer)
- `cre/` — Chainlink CRE goal-verification workflow (Confidential AI Attester callback pattern)
- `scripts/` — `demo-reset.sh` (clean redeploy + seed) and `happy-path-test.sh` (live end-to-end proof)
- `docs/PATH-A.md` — how the oracle-signed settlement path works end to end, plus a manual QA runbook

See `HANDOFF.md` for run steps, on-chain addresses, env setup, and open items.

## Team

Andre Chuabio, Nikki Hu
