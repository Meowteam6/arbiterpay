# GoHealthMe — Circle Agentic Economy build

Verified health goals with instant USDC rewards. Sponsors fund pools; you hit the goal; you get paid the second it is verified. Raw health data never touches the chain.

This repo is GoHealthMe's architecture adapted for the **Circle Agentic Economy Prize ($50,000)**, deadline **2026-08-17, 1:00pm PT**. It is the same product. The change is that an agent now runs the money.

## Read SPEC.md first

`SPEC.md` is the build spec — verified defects with file:line, fixed product decisions, screens, build order, video beat sheet, and a rejected-ideas list so settled arguments are not reopened. Read it before proposing anything.

**Four verified defects live there and the first one blocks everything else:** three of the five live pools settle to ZERO. `_payAchievers` computes `entryFee * multiplierBps / BPS`, and both `[doc]` preventive-care pools were created with `entryFee = 0` and `bountyModel = 0`, so `totalOwed` is zero and it returns early. The transaction succeeds, `AchieverPaid` never fires, nobody is paid. Do not build on pools that cannot pay. Always assert on the USDC delta, never on transaction success.

The agent is named **SPOTTER**. One name across every surface.

## This repo is part of the claudeMeow fleet

This repository is one of several worked by **claudeMeow**, a shared automation
system owned by the `Meowteam6` org (the org name is why there are six repos).
The system is defined in [`Meowteam6/claudemeow`](https://github.com/Meowteam6/claudemeow);
this section is the short version an agent working *here* needs.

### How work arrives

**GitHub Issues are the queue.** An issue labelled `queued` is a work order. An
always-on executor on Andre's M4 Mac mini polls every 60s, claims the issue by
swapping `queued` for `in-progress` (the label *is* the mutex — that is how two
machines share one queue safely), creates a git worktree, and runs a headless
Claude session against the ticket.

The run ends in exactly one of two ways:

- **A draft PR**, which waits for a human.
- **`blocked`**, with the agent's own explanation in a comment.

The executor is denied `gh pr merge`, `gh pr ready`, and `gh pr close` at the
tool level. It physically cannot merge its own work or take a PR out of draft.
**A human merges. Always.**

### What this means for you

- **Write tickets, not prose.** A `queued` issue is executed literally. Give it a
  Problem, a What to build, and acceptance criteria. Vagueness becomes a wasted
  run.
- **Keep tickets small.** The inner session runs under `MAX_TURNS=150`. A run
  that hits the cap **commits nothing and leaves no summary** — the work is lost
  and the money is spent. If a ticket looks like it may run long, split it and
  say so in the body.
- **At most three sessions run at once** across the whole machine (memory-bound,
  16 GB). Filing ten tickets does not make them go faster.
- **Never assume a PR was reviewed** because it exists. Draft is the default
  state, not a signal.

### Conventions this fleet enforces

- **Branches:** `type/IS-NNN-description` (IS = the GitHub Issue number)
- **Commits:** Conventional Commits — `type(scope): description`
- **No ticket refs in code or comments** — CHANGELOG only
- **Never `--no-verify`.** Fix the hook, not the flag.

### Talking to the fleet

**MeowConcierge** (`@mewoteam_bot` on Telegram) is the human front-end. It files
tickets (`/queue`), reports per-repo state (`/status`), scopes work out loud
(`/design`), researches into docs (`/study`), and runs scheduled rounds
(`/loop`). It is **read-only** when answering questions — it can create work but
never performs it. Everything it files lands in the same GitHub queue described
above, so nothing here depends on Telegram being up.

The fleet spans more than one machine (Andre's Mac mini and Nikki's laptop), so
an issue may be claimed by either. Stale claims are swept and requeued
automatically after 30 minutes.

## The product does not change

GoHealthMe stays GoHealthMe. Sponsor-funded health pools, one-wallet-one-entry enforced on-chain by `joinPool` (World ID was removed in the Circle build), confidential AI verification in a TEE, instant USDC settlement on Arc.

**Do not rewrite this as a generic "autonomous underwriting agent" or "claims automation platform."** That framing was tried and rejected — it is what every B2B fintech entrant calls themselves, it is forgettable, and it throws away the thing that makes this memorable. Judges see hundreds of submissions. "Get paid in USDC the instant you hit your sleep streak, verified so nobody ever sees your health data" lands. "Autonomous underwriting" does not.

The brand voice is deliberate and Andre owns it: degen energy, direct, a bit funny, founder as the persona. Do not sand it into enterprise copy.

## What is actually new for Circle

One thing: **the agent becomes an economic actor inside GoHealthMe** rather than a script someone runs.

```
sponsor funds a pool
   -> agent BUYS the verification it needs, per claim
      (x402 / nanopayments via the Circle Agent Marketplace)
   -> agent decides who hit the goal
      (Chainlink Confidential AI Attester verdict + Gemini reasoning)
   -> agent PAYS the achievers from its own Circle wallet
      (settle() on Arc)
```

The agent has a budget, real costs, and real payouts. That is Circle's stated thesis — agents as economic actors that hold money and operate under guardrails — expressed through GoHealthMe's existing mechanics, not bolted onto them.

Why this is strong for their **centrality** criterion: GoHealthMe has no business at all if settlement is manual. The payout is the product. Most entrants will be adding a payment to something that worked fine without one.

Honest about the payee: this is agent-to-service on the buy side and agent-to-human on the pay side. Do not pretend it is agent-to-agent. An agent paying real people for real behaviour is a better story than two bots trading API calls.

## Repo name

`arbiterpay` is a leftover from the rejected reframe and is almost certainly wrong. This is GoHealthMe. Rename before the repo goes public — GitHub redirects make it free. Andre decides.

## Relationship to the original gohealthme repo

Full-history clone of `AndreChuabio/gohealthme` taken at `pre-circle-pivot` (2026-07-30).

**Never modify the `gohealthme` repo, its Vercel project, or `gohealthme.vercel.app` from here.** That deployment won the Chainlink Confidential AI Attester prize at ETHGlobal NY 2026 and must keep serving that build. Tags there: `ethglobal-submission` (`0b5b17e`, the judged state) and `pre-circle-pivot` (`767c8f1`, the fork point).

**Never link this repo to the existing Vercel project.** There is deliberately no `.vercel/` here. Create a brand new project when deploying. Linking to `gohealthme` would overwrite the winning demo.

## What Circle is judging

Creativity, **centrality to the business**, technical depth and autonomy, customer experience.

Three mandatory proofs, all required:
1. Public GitHub repo showing **Circle Agent Stack** integration
2. Recorded demo of at least one real, verifiable USDC transaction
3. The agent's **Circle wallet address** plus a clickable block-explorer URL

The bar is *"genuinely agent-driven — no human manual checkout."*

## Eligibility gates — blockers, not features

**No Gemini call exists anywhere in this codebase.** Zero hits for gemini/vertex/googleapis in `app/lib` and `app/app`; the judge runs `gemma4` through the Chainlink attester (`app/lib/server/judge.ts`). Base rules require a Gemini API call in the deployed application, and Circle's page requires meeting all base rules. **No Gemini means no prize.** Route the agent's reasoning through Gemini on Vertex AI — satisfies the Gemini rule and the Google Cloud rule in one integration.

**Arc has no mainnet before Aug 17.** Circle's docs say never target Arc mainnet, so every transaction available is testnet while the prize's example explorers are mainnet. Circle confirmed on the 2026-07-30 briefing that agents transacting on testnet is normal and widely done, which de-risks it, but that is not a formal ruling. Written clarification outstanding. If unanswered by Aug 8, hedge with one small agent-driven USDC transfer on Base mainnet for a Basescan link — do **not** migrate settlement off Arc.

## Verified facts — do not re-derive

- **`settle()` is permissionless.** `contracts/src/HealthPools.sol` — `external nonReentrant`, gated only on `block.timestamp > periodEnd` and `!settled`. A Circle wallet can become the settler with zero Solidity changes and no redeploy. It is also a known griefing vector; **do not "fix" it before submission** — it is what makes the integration cheap. Revisit immediately after.
- **ARC-TESTNET is Circle CLI's `DEFAULT_AGENT_CHAIN_TESTNET`**, chain id 5042002 — already the settlement chain. No migration needed.
- **Agent Wallet sessions cannot run headless.** The CLI strips the refresh token before persisting and secrets live in the OS keychain, so a Vercel function cannot re-authenticate. Use `@circle-fin/developer-controlled-wallets` (static API key plus entity secret) as the always-on settler; use the CLI-provisioned Agent Wallet as the named agent identity for proof 3. Never put a CLI session on the critical path.
- Live contracts (Arc testnet, gate ON): HealthPools `0xc4274eF2cBe28f77Af31b980055Cc1171818390C`, HealthVerdict `0x9bf5e4b54361DEAca4314c1d8de3aeB30111F042`, KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62`.
- `goalId` is `keccak256(abi.encode(pools, poolId, participant, periodStart))`. Four layers must agree: both contracts, the CRE workflow, and `app/lib/server/verdict.ts` (which reads it from the contract rather than re-deriving — keep it that way).
- The settlement gate is ON: `settle()` pays only where `canSettle(goalId)` is true. A missing registry write means a successful transaction that pays nobody. Assert on the USDC delta, never on transaction success alone.

## Build on Circle's own scaffold

- `circlefin/agent-stack-starter-kits` — the **`vercel-ai`** kit matches this stack. `packages/circle-tools` wraps the CLI for wallets, balances, service discovery, and x402 payments.
- `circlefin/skills` — Circle's skill files for AI-assisted development.
- Circle Agent Marketplace: `agents.circle.com/services`.

Using their scaffold makes the integration read as native, which matters for proof 1.

## Hard rules

- **Never send raw health data to Gemini or any marketplace service.** Only derived verdicts and pool state. The TEE privacy boundary in `app/lib/server/judge.ts` is the product's core claim.
- **Cap the agent's verification spend per pool.** Circle emphasised guardrails heavily on the briefing. Few lines, demos well, maps to their technical-depth criterion.
- **No silent failures on any money path.** Report success only when funds actually moved.
- **Never commit key material.** `*.pem` and `*-recovery-file.json` are gitignored. The Circle entity-secret recovery file must never live in the repo tree — there is no recovery if both it and the entity secret are lost.
- **This repo becomes public before Aug 17.** Unfixed money-path security findings exist and are deliberately undocumented here for that reason. Ask Andre for the private triage before touching payout routes or funding the agent wallet meaningfully.
- No AI-tool credit in commits, code comments, or docs. No emojis. No exclamation marks in code or documentation.

## Out of scope until Aug 17

Every hour here is an hour not spent on the three mandatory proofs.

- Selling into the Circle Marketplace as a provider (99.9% uptime vetting; we are a buyer)
- Chainlink CRE path B deployed end to end; `authorizedKeys` and the DON deployment
- Mainnet contract audit and real-money settlement (contracts are unaudited)
- Junction wearables expansion, Blink, Unlink payout work, new pool types
- Chasing arms-length revenue. Report zero honestly; do not build a sales motion.

## Research-first

Read before changing: this file, `HANDOFF.md`, `DEPLOYMENTS.md`, and the specific route or contract. Map the flow end to end (evidence -> attester verdict -> HealthVerdict registry -> agent decision -> settle) before touching any link. Expand existing code; do not duplicate. Check existing branches before implementing a fix — work has been duplicated that way before.

## Stack

Next.js App Router + TypeScript, wagmi/viem, Foundry, Upstash Redis. Arc testnet for settlement. Circle Agent Stack for the agent wallet and service payments. Gemini via Vertex AI for the agent's reasoning step.

## Progress logging

Append dated entries to `/Users/andrechuabio/Documents/Claude_Brain/01 - Hackathons/ETHGlobal NY 2026.md` after each significant milestone. Consider a dedicated note for this prize once the build is underway.
