# GoHealthMe reskin — design handoff

For a second Claude (Nikki's laptop) to pick up the UI reskin taste pass with full context.
Date: 2026-08-21 · Branch: `feat/ui-reskin-warm-light` · Owners: Andre + Nikki (Meowteam6).

## What we're doing

Iterating on the GoHealthMe UI reskin — "SPOTTER's world," a warm, otter-led look — to make it
genuinely good, not just clean. This is a taste pass, driven by looking at the live app together.

## Current design direction (set this session)

Fuse four references into one look: **clean + visual + gamified + trustworthy, mascot at the center.**

- **Duolingo** — chunky rounded components, the 3D press-button (solid face + darker bottom lip), mascot-led, gamified stat chips.
- **Habitica** — playful gamification energy, but cleaner (no pixel art).
- **BeeDone** (beedone.co) — clean light canvas, bold rounded display with a marker-highlight on keywords, floating XP / achievement cards, mascot, a device visual.
- **Kalshi** (kalshi.com) — confident, data-forward, restrained; numbers as heroes.

Target feel: "Kalshi had a baby with Duolingo." **Clean is the top priority; game delight second.**

## Live design exploration (v0)

- v0 chat (unlisted, generating the new Pools page in this style): **https://v0.app/chat/ucuTRp58HQv**
- It is briefed with our palette, mascot, and honesty rules. Open it to see the output and iterate by messaging in that chat. Output is portable React + Tailwind meant to port into `app/`.

## Surface review board (what's live now, annotated)

- Board (all 8 current surfaces + findings): **https://claude.ai/code/artifact/d9c2c06c-6a08-4d9e-802a-4983440cb3fd**
- Priority ledger:
  - **P1 bug** — landing hero: the gold "SPOTTER PAID YOU +50.00 USDC" badge overlaps and hides the "Meet SPOTTER" caption.
  - **P1 bug** — `/agent` console: the SPOTTER wallet address is oversized and wraps to a lone "d".
  - **P2** — two header systems: scenic otter header on Landing / Pools / Dashboard, flat on SPOTTER / Challenges / Sponsor / Feed. Biggest cohesion gap.
  - **P2** — "Why crypto" section has ~40% empty right column; natural home for the two-otters-holding-paws asset.
  - **P3** — cute per-category icons on the pool tags (Nikki's ask).
  - **P3** — Feed / Sponsor dead space + vertical rhythm.
  - **P3** — run-across otter easter egg clips the footer word "Arc" (z-index / timing, not a static bug).
  - **Note** — THE DROP payout moment (`app/components/PayoutMoment.tsx`) is not reachable in-app (dev preview removed before prod); restore it locally to review.

## Design tokens (source of truth: `app/app/globals.css`)

- Canvas cream `#faf6ee`; surfaces `#ffffff` / `#fffdf8`; edge `#ece3d2`
- Emerald (trust / brand) `#10b981`, strong `#059669`, deep `#064e3b`
- Coral (people / celebration) `#ff8a5c`, strong `#f06d3a`
- GOLD (money in motion only) `#f3b13c`, strong `#eaa11f`, deep `#a9760c`
- Amber warning, deliberately NOT gold `#b45309`
- Session addition for the gamified direction: water-blue `#35b7f0` for the streak element only (the otter is a water animal — no fire/flame streak)

## Honesty rules — compliance, not style (do not break)

- A self-reported win NEVER reads as "verified" anywhere. See `app/lib/proof-tier.ts` (`ProofTier`, `proofTierFromVerdict`, per-surface helpers). Restyle containers, do not fork the strings.
- GOLD = money in motion only, never decorative.
- SPOTTER never says a number (the mono verdict slot does).
- Reward, not a wager — no bet / odds / wager language.
- Testnet / play-money is always labeled.

## Mascot + assets

- Otter sprites: `app/public/spotter/*.png` — standing, lounging, cheer, payday, watching, neutral, peek, run, broke, verified, payout, nature. Backdrop: `app/public/spotter/backdrop.png`.
- Still to make (Nikki): `spotter-together.png` (two otters holding paws — family / community), a gold coin with tier rings, the 1200×630 share-card, per-goal-category icons.
- Voice engine: `app/lib/spotter-says.ts` + `app/lib/spotter-lines.ts` (+ honesty tests). Scenic header: `app/components/SceneHeader.tsx`. THE DROP: `app/components/PayoutMoment.tsx`.

## Run it locally

```bash
git checkout feat/ui-reskin-warm-light && git pull
cd app
npm install          # first time only
npm run dev          # or: ./node_modules/.bin/next dev
# open http://localhost:3000
```

Next.js 16 + Tailwind v4. Note `app/AGENTS.md`: this Next.js has breaking changes — read
`app/node_modules/next/dist/docs/` before writing Next code.

## Ownership split (from the prior handoff)

- Andre: landing copy + assets + category icons.
- Peer session: docs + the badge API (`GET /api/badges`, `iconKey` = badge id).

## Next actions

1. Watch the v0 Pools output and iterate in that chat toward the clean + gamified look.
2. In parallel, the two P1 bugs are safe, quick fixes in the current build.
3. Once the direction is picked, decide the header system (likely unify on the scenic otter header).
