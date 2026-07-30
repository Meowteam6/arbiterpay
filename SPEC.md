# GoHealthMe x Circle — build spec

**Status: draft for markup.** Andre and Nikki, edit freely. Anything you disagree with, strike it and say why — the "Rejected" section at the bottom exists so we do not relitigate the same ideas twice.

Target: Circle Agentic Economy Prize, $50,000. Deadline **2026-08-17, 1:00pm PT**.

---

## TL;DR

Not a pivot. Same GoHealthMe. One change: an agent called **SPOTTER** gets its own Circle wallet and a budget, buys the verification it needs per claim, decides, and settles the payout itself.

Today settlement is a human running a shell script. Nothing in the app calls `settle()`. So "instant USDC rewards" is currently only true when Andre remembers.

---

## Verified defects (facts, not proposals)

These were confirmed by reading the code, not inferred. Fix before anything else.

### 1. Three of five live pools cannot pay anyone

`contracts/src/HealthPools.sol` `_payAchievers`, fixed-bounty branch:

```solidity
totalOwed += (p.entryFee * participants[poolId][plist[i]].multiplierBps) / BPS;
if (totalOwed == 0) return 0;
```

With `bountyModel == 0` and `entryFee == 0`, `owed` is zero for everyone and it returns early. Nobody is paid.

| pool | entry | model | pays? |
|---|---|---|---|
| sleep | 0.25 | 0 | yes |
| recovery | 0.25 | 1 | yes |
| **steps** | **0** | **0** | **zero** |
| **flu-shot** | **0** | **0** | **zero** |
| **screening** | **0** | **0** | **zero** |

Both `[doc]` preventive-care pools — the document-evidence flow the demo is built on — settle to nothing. In `app/components/CreatePool.tsx`, all three `DOC_TEMPLATES` set `entryFee: "0.00"` (lines 51, 59, 67) while `bountyModel` defaults to `0` (line 120) and `applyTemplate` never touches it. Any user picking the flu-shot template creates a pool that structurally cannot pay.

Never caught because every working demo used model 1 or a non-zero entry — `scripts/tier1-gate-proof.sh` passes model `1`, which is why it paid 2 USDC.

**How it fails is the dangerous part:** the agent settles, the verdict is valid, `canSettle` is true, the transaction succeeds — and `AchieverPaid` never fires because `payout == 0` hits the `continue`. A green transaction and no money, on camera.

**Fix:** force `bountyModel 1` whenever `entryFee` is 0, in `CreatePool.tsx` and in the agent's `createPool` call. Re-seed. Frontend only, no redeploy. Always assert on the USDC delta, never on transaction success.

### 2. Photo evidence cannot be submitted at all

`app/components/PoolDetail.tsx:213` gates the evidence upload on `isDocGoal && hasJoined`, where `isDocGoal` is `evidenceType === "document"`. A wearable pool therefore has **no evidence path anywhere in the UI** — a gym selfie or scale photo literally cannot be submitted. Change to `hasJoined`.

### 3. The payment animation is fake

`app/components/EvidenceUpload.tsx` lines 300, 302, 306 are literal `await sleep(600)` / `sleep(400)` / `sleep(300)` driving the "Settling on Arc" and "Paid" steps while nothing settles. A fake payment animation in a repo Circle reads for proof of integration is a liability. Delete on day one.

### 4. Stale copy on screen for the whole video

`app/app/layout.tsx:45` still reads "ETHGlobal New York 2026. Arc testnet, World ID, ENS."

---

## Fixed product decisions

Do not reopen these without a conversation.

1. **Self-goals are the umbrella.** Headline is "set your own goal, get paid when you hit it." Backing a friend (`backGoal`) still exists but lives underneath, not as the lead. Cleaner regulatory story.
2. **The goal is self-set; the money is sponsor-funded.** If a user funds their own goal and gets their own money back there is no economy and the agent is expensive escrow. Sponsor deposits, agent disburses.
3. **Degen wrapper, honest core.** Brand copy, empty states, failures and celebrations go full degen. Amounts, verdicts and health readouts render through primitives with no slot for an adjective. The app is loud; SPOTTER is deadpan. The contrast is the joke.

---

## North star

You say the thing you have been putting off, somebody else's USDC gets put on it, and a machine called SPOTTER pays you the second it can prove you did it.

SPOTTER has its own Circle wallet, a budget, and no boss. It buys the checks it needs from the Circle Agent Marketplace with real USDC, decides, and calls `settle()` itself with nobody awake. Every cent it spends prints on screen as a line item, because an agent you cannot watch spend is just a backend claim.

**Landing copy (draft):**

> **FREE MONEY WITH EXTRA STEPS. THE STEPS ARE THE POINT.**
> # Your goal. Somebody else's money.
> Say what you are going to do. A sponsor puts up the USDC. An agent buys whatever it needs to check your proof, decides, and pays you out of its own wallet. No human in the loop, and nobody ever sees your health data.

---

## The moment the submission hangs on

Two claims, same code path, different prices.

**Claim one** — clean scale photo. SPOTTER pre-prints its plan, buys one `$0.02` OCR read, resolves, stops.

**Claim two** — blurry gym-mirror selfie. The cheap OCR returns nothing, and a row prints that was not in the plan:

```
☑ document read (OCR)        $0.02 paid
  ↳ no readable text returned
  escalating. i can't read this and i'm not paying out
  50.00 USDC on something i can't read.
☑ vision judge (Gemini)      $0.35 paid
─────────────────────────────────────────
Spent 0.37 USDC of a 1.00 USDC cap on this claim.
```

Fifteen times the spend on messier evidence, decided live, under a visible ceiling. That is the difference between an agent and a script, and it is the only thing in the build that proves it.

---

## Screens

| screen | new? | purpose | files |
|---|---|---|---|
| `/` goal box landing | mod | Inverts away from a cold-start grid of strangers' pools | `app/app/page.tsx`, `app/components/GoalIntent.tsx` |
| `/goal` match screen | new | Turns "nothing matches" into the second place the agent spends | `app/app/goal/page.tsx`, `GoalMatch.tsx`, `api/goals/match` |
| `/pools/[id]` | mod | Shortest path to a claim; fixes defects 1 and 2 | `PoolDetail.tsx`, `JoinPool.tsx`, `BackGoal.tsx` |
| **AgentReceipt** | new | **Most protected surface in the build** | `AgentReceipt.tsx`, `EvidenceUpload.tsx`, `lib/server/agent/ledger.ts` |
| PayoutMoment | new | The product promise, kept, visibly | `PayoutMoment.tsx` |
| `/agent` SPOTTER page | new | Circle mandatory proof 3 as a product page | `app/app/agent/page.tsx`, `AgentConsole.tsx` |
| AgentStrip in header | mod | Agent's falling balance beside a rising human balance | `AgentStrip.tsx`, `Header.tsx` |
| `/dashboard` | mod | Copy-only, near-zero risk | `DashboardContent.tsx` |

**AgentReceipt is not droppable.** Without it the Circle integration is a README claim with no screen behind it.

Notable copy:

- Join button: *I'm in* — caption: *One quick check that you are a real human. Costs you nothing.*
- Evidence empty state: *Prove it.* — *Scale photo, gym selfie, lab PDF, screenshot of your watch at 2am. SPOTTER works out what it is looking at and buys what it needs. Messy is fine. Fake is not.*
- Receipt footer: *Your document never left the secure enclave. SPOTTER only ever saw the verdict.*
- Payout: *+50.00 USDC — SPOTTER paid you.* Degen chaser on a separate line: *Absolute unit. Run it back.*
- Agent strip, broke state: *SPOTTER · 0.00 USDC · out of budget. not verifying anything until topped up.*
- `/agent` empty feed: *SPOTTER has done nothing yet. Give it something to verify.*

---

## Build order

| # | what | effort | droppable |
|---|---|---|---|
| 1 | SPOTTER becomes the on-chain actor. Wire `@circle-fin/developer-controlled-wallets`. Then **`setOracle(address)` at `HealthPools.sol:153`** — one owner call makes the Circle wallet both the oracle and the settler. Zero Solidity changes, no redeploy. | 2d | no |
| 2 | Agent run + append-only ledger keyed by goalId on existing `store.ts`. `/api/agent/run/[goalId]`: plan → buy → attester → reason → record → settle-when-settleable. Emit `plan` before any `spend`. | 3d | no |
| 3 | AgentReceipt. Delete `StatusTimeline` and both `sleep()` fakes first. Plan-then-price rendering, running total vs cap. Raise `MAX_POLLS`, drop interval to 800ms. | 2d | no |
| 4 | Real x402 purchases against the Marketplace. `@circle-fin/x402-batching` is already in `package.json`, unused. Cheap-first-then-escalate as real control flow, not UI theatre. | 2d | no |
| 5 | **Gemini via Vertex AI. ELIGIBILITY BLOCKER** — no Gemini call exists anywhere today; base rules require one in the deployed app. Satisfies the Google Cloud rule in the same integration. Derived verdicts only, never document bytes. | 1d | no |
| 6 | Honest-core primitives (`<Money>`, `<Verdict>`) + **the zero-payout fix** + `PoolDetail.tsx:213`. | 1d | no |
| 7 | `/agent` page and AgentStrip. Identity card first. Delete the mainnet ENS client from `Header.tsx` in the same pass. | 1.5d | no |
| 8 | PayoutMoment + split the failure branch into evidence-failure (fixable, joke lands on the photo) and goal-missed (bit fully dropped). | 1d | partly |
| 9 | Landing goal box, `/goal` matcher, keyword ranking. | 1.5d | **yes** |
| 10 | Demo assets and shoot. Real `.jpg` evidence (a `.txt` on camera reads as fake). `scripts/seed-demo-pool.sh` with `PERIOD=75` so `settle()`'s `block.timestamp > periodEnd` does not make a one-take video impossible. Fix `layout.tsx:45`. Record with `DEMO_MODE` **off**. | 1.5d | no |

Roughly 16 of 18 days. Internal freeze **Thursday Aug 14**.

---

## Video beat sheet (3 min)

1. **0:00–0:12** Cold open on `/agent`. No logo. SPOTTER's wallet address in mono at display size, balance, a payout timestamped four seconds ago. *"This wallet has 412 USDC in it. Nobody at my company can sign for it."*
2. **0:12–0:28** Landing. Type the goal, match screen, sponsor's USDC on screen. *"You set the goal. A sponsor puts up the money. Not you — that part matters."*
3. **0:28–0:55** Claim one. Legible scale photo so the judge reads the number before SPOTTER does. One `$0.02` OCR call. Verified.
4. **0:55–1:28** Claim two. Gym selfie. OCR returns nothing, escalation row prints, vision judge bought for `$0.35`. Hard cut and a full beat of silence on the escalate line.
5. **1:28–1:50** Countdown hits zero, hands visibly off the keyboard in frame. Agent balance drops, payout takes over, human balance rises.
6. **1:50–2:05** Arcscan. **Hold three full seconds** on the settle tx `from` address next to the app's wallet address. Different addresses, side by side. This is the "no human touched this" proof.
7. **2:05–2:35** Two receipts adjacent — `$0.02` on the clean claim, `$0.41` on the messy one. *"Same code. Two prices. It is deciding, not executing."*
8. **2:35–3:00** *"Two months ago this was me, remembering to run a shell script. There is no product if a human has to remember to pay you."* End card: wallet address, Arcscan URL, repo, chain id 5042002.

**Never show:** `DEMO_MODE` anything, raw attester model output, the World ID QR flow, an empty pool list, the create-pool form, `backGoal`, or an apologetic testnet paragraph. One factual chip and move on.

---

## Rejected (do not relitigate)

- **"Autonomous underwriting agent" reframe.** Generic B2B framing every entrant uses. Rejected by Andre. Adapt the architecture, never the product identity.
- **GAINS as the agent name.** SPOTTER does double duty — counts your reps, spots you cash — and is a character, which is what makes the deadpan-agent-versus-loud-app contrast work.
- **Sub-day pool durations in the create form.** Solves a recording problem by shipping product damage. `scripts/seed-demo-pool.sh` with `PERIOD=75` fixes it for free.
- **Count-up animation on the payout number.** A judge who has seen 200 submissions can smell a CSS keyframe. The takeover is the event; let the number be real.
- **Gemini semantic ranking in `/api/goals/match`.** The agent's reasoning step already satisfies the eligibility gate and is where the call is load-bearing. Keyword scoring ranks five demo pools identically for free.
- **A separate SPOTTER history page.** Same ledger at a third density. Folded into `/agent`.
- **x402 as a seller / paywall.** We are a buyer, not a merchant. A fake resource to sell is something Circle engineers scoring centrality would see through instantly.

---

## Open questions

1. **Repo name.** `arbiterpay` is a leftover from the rejected reframe. Suggest `gohealthme-circle`. Andre decides — rename is free.
2. **Does an Arc testnet transaction satisfy the "real, verifiable USDC transaction" proof?** Their explorer examples are mainnet. Circle said on the briefing that testnet agents are normal, so risk is low. Written clarification outstanding. One-day Base hedge if it comes back badly.
3. **GCP hosting.** Official Rules say "use at least one product from Google Cloud"; the Circle page says "hosting on Google Cloud Platform." Those are very different. Clarification outstanding. Assume Vercel survives until told otherwise.
4. **Which wallet is submitted as proof 3** — the CLI-provisioned Agent Wallet, or the developer-controlled wallet that actually signs? Ask Circle.
5. **Unfixed money-path findings exist** and are deliberately not documented here because this repo goes public. Ask Andre for the private triage before funding the agent wallet meaningfully.
