# GoHealthMe — Circle Agentic Economy build

Verified health goals with instant USDC rewards. Sponsors fund pools; you hit the goal; you get paid the second it is verified. Raw health data never touches the chain.

This repo is GoHealthMe's architecture adapted for the **Circle Agentic Economy Prize ($50,000)**, deadline **2026-08-17, 1:00pm PT**. It is the same product. The change is that an agent now runs the money.

## Read SPEC.md first

`SPEC.md` is the build spec — verified defects with file:line, fixed product decisions, screens, build order, video beat sheet, and a rejected-ideas list so settled arguments are not reopened. Read it before proposing anything.

**Four verified defects live there and the first one blocks everything else:** three of the five live pools settle to ZERO. `_payAchievers` computes `entryFee * multiplierBps / BPS`, and both `[doc]` preventive-care pools were created with `entryFee = 0` and `bountyModel = 0`, so `totalOwed` is zero and it returns early. The transaction succeeds, `AchieverPaid` never fires, nobody is paid. Do not build on pools that cannot pay. Always assert on the USDC delta, never on transaction success.

The agent is named **SPOTTER**. One name across every surface.

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

## Who owns this — Meowteam6

This repo belongs to **Meowteam6**, the two-founder company run by Andre Chuabio and Nikki Hu. GitHub org is `Meowteam6`; this repo is `Meowteam6/arbiterpay`. Anything written here is read by both founders, so write for that audience.

Five repos, and this one does not stand alone:

| Repo | Role |
|---|---|
| `claudemeow` | Plugin, guards, executor, Telegram bridge — the substrate the others run on |
| `MeritAI` | **Main XPRIZE entry** (Build with Gemini, $2M pool, Professional Services Access) |
| `arbiterpay` | **This repo. Circle Agentic Economy entry** ($50k, one winner, stacks on the main prize) |
| `gohealthme` | The ancestor. Frozen ETHGlobal NY 2026 artifact — never modify it from here |
| `synapse` | Dormant |

**Both prize tracks submit against the same deadline: 2026-08-17, 1:00 PM PT.** MeritAI is the main entry; this is the bonus that stacks on it. Work here competes for hours with MeritAI, so scope creep in this repo costs the $2M track, not just this one.

Operating model: work is queued through a Telegram group and the MeowConcierge bot into GitHub Issues, then executed by launchd executors on an always-on M4 Mac mini, one git worktree per ticket, ending in a draft PR. Nobody codes on the mini directly.

The company brain is the **MI6 Obsidian vault** at `/Users/andrechuabio/Documents/Meow_Intelligence_6(MI6)` — company decisions, repo dossiers, and the sprint ledger live there, not in this repo. It is shared with Nikki and multi-writer, and the Obsidian MCP server cannot reach it (use absolute shell paths; mind the literal parentheses). Notes for this build: `Projects/GoHealthMe-Circles.md`; repo dossier: `Repos/ArbiterPay.md`; deadline ledger: `Org/XPRIZE-Sprint.md`; append-only decision log: `Org/Decisions.md`. Never put secrets in the vault.

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
- **The "nothing was listening to `setShowAuthFlow`" theory is FALSE — do not re-derive it.** Verified against the installed SDK (`@dynamic-labs/sdk-react-core@4.88.6`): `DynamicContextProvider` renders `DynamicAuthFlow` itself, and `DynamicConnectButton`'s onClick is literally `setSelectedWalletConnectorKey(null); setShowAuthFlow(true);` — the same call the old hand-rolled button made. The flag always had a listener. The real fix is the `primaryWallet ?? userWallets[0]` resolution below. `components/Header.tsx` uses `DynamicConnectButton` anyway (it also clears a stale connector key and gates on `projectSettings` loading), but note `login()` is still the sign-in path in nine other components — if the bare-button theory were true the app would still be broken everywhere else.
- **MetaMask is filtered out of the login modal** via `walletsFilter` in `app/app/providers.tsx`. It matches on the `metamask` key *prefix*, because the SDK also ships a `metamaskevm` key that an exact `RemoveWallets(["metamask"])` would miss. Email, Coinbase, WalletConnect and Trust remain. Verified in-browser: the shortlist omits it and searching the full 585-wallet list returns "Wallet not available". `useMetamaskSdk: false` is now inert but harmless.
- **The Arc RPC reorder from PR #29 only landed in `app/lib/chains.ts`.** `app/lib/dynamic.ts` still lists the demoted `rpc.testnet.arc.network` as its sole RPC, and `app/app/providers.tsx` still leads with it and still includes the drpc endpoint that answers 400. This matters because Dynamic builds the `wallet_addEthereumChain` payload from the `dynamic.ts` descriptor, so external-wallet users get the known-bad endpoint written into their wallet. One line in each file, still unfixed.
- **`primaryWallet` is null for external wallets under connect-only.** Email sign-in populates it (the turnkey embedded wallet), but a MetaMask/Coinbase connection lands in `useUserWallets()` with no authenticated session to promote a primary. Reading `primaryWallet` alone meant a wallet user connected successfully and the header never left "Sign in". `lib/wallet.ts` now resolves `primaryWallet ?? userWallets[0]`. Verified end to end on production: a real email login flips the header to "Sign out" plus the wallet address.
- **Keep `initialAuthenticationMode: "connect-only"` in `app/app/providers.tsx`.** It skips the SIWE ownership signature, which is what surfaces as "Message signature denied" in the modal for MetaMask users. It was never the reason sign-in was dead, and measured on production it does NOT cost the email view — the modal shows email and the wallet list together. Removing it re-introduces the signature failure. `lib/wallet.ts` already treats a connected wallet as authenticated precisely because connect-only never sets `isLoggedIn`.
- **These CSP / CORS / allowed-origin theories are all disproved. Do not re-derive them.** The app serves no CSP on any surface (no header, no meta tag, no `middleware.ts`); the policy seen in DevTools comes from Vercel's SSO login page and the MetaMask extension frame. All three Arc RPCs return correct CORS from the browser origin, so PR #29's premise is stale. Dynamic returns a correct `access-control-allow-origin` for production, preview, and localhost, so Allowed Origins was never the blocker. Note `curl` ignores CORS — a `200` proves nothing unless you check the ACAO header.
- **Vercel SSO protection is ON** (`all_except_custom_domains`), so every preview and `*.vercel.app` URL sits behind a Vercel login wall. Test on the production alias, never a preview URL. A custom domain is exempt — which is also the escape from Blockaid flagging `*.vercel.app` (3,705 of its siblings are on MetaMask's blocklist; this app is on none).

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

## Reporting a bug fix — do not hand back a status report

When Andre reports something broken, the deliverable is the **fixed, verified thing** — not an analysis of it. Drive it to done in one pass:

1. **Reproduce it in a real browser first.** Notes and prior diagnoses in this file, in memory, and in commit messages have all been wrong about this app before. A premise older than a few days is a hypothesis, not a fact — re-measure it.
2. **Verify in the running app, not by reading code.** Check the live DOM, network, and console. Shadow DOM hides things: Dynamic renders into `.dynamic-shadow-dom`, so an empty accessibility tree or a clean screenshot does not mean nothing rendered.
3. **Browser-automation clicks are not real clicks.** The harness's `left_click` does not fire the full pointer sequence React needs, and it silently no-ops on some handlers. Before concluding a control is broken, dispatch `pointerdown/mousedown/pointerup/mouseup/click` or call `.click()` directly. A fix was nearly abandoned as failed over exactly this.
4. **Do not stack fixes.** If a fix does not work, return to evidence. Three failed fixes means the architecture is wrong, not that the fourth attempt will land.
5. Report only once it works, with the verification. Interim theories waste his time and read as excuses.

## Stack

Next.js App Router + TypeScript, wagmi/viem, Foundry, Upstash Redis. Arc testnet for settlement. Circle Agent Stack for the agent wallet and service payments. Gemini via Vertex AI for the agent's reasoning step.

## Progress logging

Append dated entries to `/Users/andrechuabio/Documents/Claude_Brain/01 - Hackathons/ETHGlobal NY 2026.md` after each significant milestone. Consider a dedicated note for this prize once the build is underway.
