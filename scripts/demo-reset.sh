#!/usr/bin/env bash
#
# Demo seed/reset for GoHealthMe.
#
# Default: deploys a FRESH HealthPools on Arc testnet, seeds three branded pools,
# then syncs the new address into .env, app/.env.local, and DEPLOYMENTS.md so the
# whole app points at the clean contract. Run before a demo run.
#
# Uses forge create + cast send (NOT forge script): Arc's native USDC delegatecalls
# a blocklist precompile that forge's local simulation can't execute, so script-based
# seeding reverts at simulation. cast/forge-create broadcast directly and work fine.
#
# Also deploys the HealthVerdict registry, points it at the Arc KeystoneForwarder
# (so the Chainlink CRE onReport path is live, not just simulated), and turns the
# settlement gate ON — settle() then requires canSettle(goalId) for every
# achiever. Both verdict paths land in the same registry storage:
#   path A: oracle EOA -> recordVerdict()   (app/lib/server/verdict.ts)
#   path B: CRE DON    -> onReport()        (via the KeystoneForwarder)
#
# Usage (from repo root):
#   ./scripts/demo-reset.sh                         # fresh deploy + gate ON + seed
#   GATE=off ./scripts/demo-reset.sh                # oracle-only, no verdict registry
#   EXISTING_POOLS=0x.. ./scripts/demo-reset.sh     # seed into the current contract
#   EXISTING_VERDICT=0x.. ./scripts/demo-reset.sh   # reuse a deployed registry
#   SEED_FUNDING=2000000 ./scripts/demo-reset.sh    # 2 USDC per wearable pool (default 1 USDC)
#   FLU_FUNDING=10000000 SCREENING_FUNDING=50000000 ./scripts/demo-reset.sh  # real $10/$50 preventive pools
#
# Requires: foundry on PATH, funded DEPLOYER_PRIVATE_KEY + ORACLE_SIGNER_PRIVATE_KEY
# in .env. Gas on Arc is native USDC: top up at https://faucet.circle.com.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"
source "$ROOT/scripts/assert-payable.sh"

[ -f .env ] || { echo "error: .env not found at repo root" >&2; exit 1; }
set -a; source .env; set +a

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
USDC="${ARC_USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"
FUND="${SEED_FUNDING:-1000000}"          # 1 USDC per wearable pool (6 decimals)
# Document-verified preventive-care pools. Inspired by UnitedHealthcare's
# preventive-care incentives ("get your flu shot", "biometric screening"). The
# real demo funds these at $10 / $50; we default to 1 USDC each so a thin
# testnet-USDC deployer can still seed a full clean slate. Override per pool:
#   FLU_FUNDING=10000000 SCREENING_FUNDING=50000000 ./scripts/demo-reset.sh
FLU_FUNDING="${FLU_FUNDING:-1000000}"           # demo: 1 USDC  (real demo: 10000000 = $10)
SCREENING_FUNDING="${SCREENING_FUNDING:-2000000}" # demo: 2 USDC  (real demo: 50000000 = $50)
KEY="$DEPLOYER_PRIVATE_KEY"
DEPLOYER="$(cast wallet address --private-key "$KEY")"
ORACLE="${ORACLE:-$(cast wallet address --private-key "$ORACLE_SIGNER_PRIVATE_KEY")}"
# Chainlink CRE KeystoneForwarder on Arc testnet — the only address allowed to
# call HealthVerdict.onReport. Source: Chainlink CRE forwarder directory
# https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts
ARC_FORWARDER="${ARC_FORWARDER:-0x76c9cf548b4179F8901cda1f8623568b58215E62}"

# Budget check: gas (native USDC) + all five fundings must fit.
TOTAL_FUND=$((FUND * 3 + FLU_FUNDING + SCREENING_FUNDING))
BAL="$(cast call "$USDC" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC")"
BAL="${BAL%% *}"
if [ "$BAL" -lt "$TOTAL_FUND" ]; then
  echo "error: deployer USDC ($BAL) < seed funding ($TOTAL_FUND). Top up: https://faucet.circle.com" >&2
  exit 1
fi

# 1. Deploy fresh, or reuse an existing contract.
if [ -n "${EXISTING_POOLS:-}" ]; then
  POOLS="$EXISTING_POOLS"
  echo "==> Seeding into existing HealthPools $POOLS"
else
  echo "==> Deploying fresh HealthPools (oracle $ORACLE)"
  # Run from contracts/; --constructor-args MUST be last (the flag is greedy and will
  # otherwise swallow trailing flags as extra constructor args).
  POOLS="$( ( cd contracts && forge create src/HealthPools.sol:HealthPools \
    --rpc-url "$RPC" --private-key "$KEY" --broadcast \
    --constructor-args "$USDC" "$ORACLE" ) | awk '/Deployed to:/ {print $3}')"
  [ -n "$POOLS" ] || { echo "error: deploy failed (no address)" >&2; exit 1; }
  echo "    deployed at $POOLS"
fi

# 1b. Deploy / reuse the HealthVerdict registry, wire the Chainlink CRE path,
#     and turn the settlement gate on.
VERDICT=""
if [ "${GATE:-on}" = "off" ]; then
  echo "==> GATE=off: skipping HealthVerdict (oracle-only settlement)"
else
  if [ -n "${EXISTING_VERDICT:-}" ]; then
    VERDICT="$EXISTING_VERDICT"
    echo "==> Reusing HealthVerdict $VERDICT"
  else
    echo "==> Deploying fresh HealthVerdict (attester $ORACLE)"
    VERDICT="$( ( cd contracts && forge create src/HealthVerdict.sol:HealthVerdict \
      --rpc-url "$RPC" --private-key "$KEY" --broadcast \
      --constructor-args "$ORACLE" ) | awk '/Deployed to:/ {print $3}')"
    [ -n "$VERDICT" ] || { echo "error: HealthVerdict deploy failed (no address)" >&2; exit 1; }
    echo "    deployed at $VERDICT"
  fi

  # Chainlink CRE ingestion. Until this is set, forwarder == address(0) and every
  # onReport call reverts NOT_FORWARDER, so path B cannot write on chain at all.
  echo "==> setForwarder -> $ARC_FORWARDER (Arc KeystoneForwarder)"
  cast send "$VERDICT" "setForwarder(address)" "$ARC_FORWARDER" \
    --private-key "$KEY" --rpc-url "$RPC" >/dev/null

  # Gate ON: settle() now requires a passing verdict per achiever.
  echo "==> setHealthVerdict -> $VERDICT (settlement gate ON)"
  cast send "$POOLS" "setHealthVerdict(address)" "$VERDICT" \
    --private-key "$KEY" --rpc-url "$RPC" >/dev/null
fi

# 2. Approve USDC for the three fundings.
echo "==> Approving $TOTAL_FUND USDC"
cast send "$USDC" "approve(address,uint256)" "$POOLS" "$TOTAL_FUND" \
  --private-key "$KEY" --rpc-url "$RPC" >/dev/null

# 3. Seed branded pools. The first three are wearable-verifiable (the demo spine).
#    The last two are DOCUMENT-verified preventive-care goals: their goalSpec is
#    prefixed with the "[doc]" marker that app/lib/contract.ts uses to route a
#    pool to the upload-evidence flow instead of the wearable flow.
NOW="$(date +%s)"
# seed_pool <initiative> <goal> <entry> <days> <model> <funding>
# <funding> is optional; defaults to $FUND so existing wearable calls are unchanged.
seed_pool() {
  local initiative="$1" goal="$2" entry="$3" days="$4" model="$5" funding="${6:-$FUND}"
  local end=$((NOW + days * 86400))
  # F-1 guard: never seed a fixed bounty (model 0) at a zero entry fee -- it
  # settles to zero for every achiever. Aborts the whole reset before any tx.
  assert_payable_pool_config "$entry" "$model"
  cast send "$POOLS" \
    "createPool(string,string,uint256,uint64,uint64,uint8,uint256)" \
    "$initiative" "$goal" "$entry" "$NOW" "$end" "$model" "$funding" \
    --private-key "$KEY" --rpc-url "$RPC" >/dev/null
  echo "    seeded: $initiative"
}

# Bounty model rule: model 0 (fixed bounty) pays entryFee * multiplier, so an
# entry-0 pool on model 0 structurally pays ZERO — settle succeeds, nobody is
# paid. Every entry-0 pool MUST use model 1 (pro-rata pot split).
echo "==> Seeding pools"
seed_pool "sleep"    "Sleep performance score 75 or higher for 3 consecutive nights (sponsored by Dreamwell Mattress)" 250000 3 0
seed_pool "recovery" "WHOOP recovery 60 percent or higher on 5 of 7 days (sponsored by Vitality Insurance)"          250000 7 1
seed_pool "steps"    "10,000 steps daily for 5 days (sponsored by Iron Gym)"                                         0      5 1

# Document-verified preventive-care pools (UnitedHealthcare-style incentives).
# entry 0 (free to join), 30-day period, pot-split model (1) — see the bounty
# model rule above. Funding defaults to 1/2 USDC for a thin testnet wallet;
# real demo uses $10 / $50 (see top of file).
seed_pool "flu-shot"  "[doc] Get your flu shot — upload your influenza vaccination record (provider, date, lot)" 0 30 1 "$FLU_FUNDING"
seed_pool "screening" "[doc] Biometric screening — upload your results (blood pressure, BMI, glucose)"           0 30 1 "$SCREENING_FUNDING"

# 4. Sync the address into env files.
echo "==> Syncing addresses into .env, app/.env.local, DEPLOYMENTS.md"
python3 - "$POOLS" "$VERDICT" <<'PY'
import re, sys
addr, verdict = sys.argv[1], sys.argv[2]
def set_kv(path, key, value):
    try: s = open(path).read()
    except FileNotFoundError: s = ""
    if re.search(rf"^{re.escape(key)}=.*$", s, flags=re.M):
        s = re.sub(rf"^{re.escape(key)}=.*$", f"{key}={value}", s, flags=re.M)
    else:
        s = (s.rstrip("\n") + "\n" if s else "") + f"{key}={value}\n"
    open(path, "w").write(s)
set_kv(".env", "HEALTH_POOLS_ADDRESS", addr)
set_kv("app/.env.local", "HEALTH_POOLS_ADDRESS", addr)
set_kv("app/.env.local", "NEXT_PUBLIC_HEALTH_POOLS_ADDRESS", addr)
# HEALTH_VERDICT_ADDRESS drives the Tier 1 registry write in
# app/lib/server/verdict.ts. Unset => that write is skipped, and with the gate ON
# nothing would ever settle, so keep the two in lockstep.
if verdict:
    set_kv(".env", "HEALTH_VERDICT_ADDRESS", verdict)
    set_kv("app/.env.local", "HEALTH_VERDICT_ADDRESS", verdict)
PY

{
  echo ""
  echo "## Demo reset $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "- HealthPools: $POOLS"
  echo "- Explorer: https://testnet.arcscan.app/address/$POOLS"
  echo "- Seeded: sleep (Dreamwell), recovery (Vitality), steps (Iron Gym),"
  echo "          flu-shot [doc], screening [doc] (preventive-care, document-verified)"
  if [ -n "$VERDICT" ]; then
    echo "- HealthVerdict: $VERDICT (attester $ORACLE)"
    echo "- Forwarder: $ARC_FORWARDER (Arc KeystoneForwarder — CRE onReport path LIVE)"
    echo "- Settlement gate: ON (settle requires canSettle(goalId))"
  else
    echo "- Settlement gate: OFF (oracle-only)"
  fi
} >> DEPLOYMENTS.md

POOL_COUNT="$(cast call "$POOLS" "poolCount()(uint256)" --rpc-url "$RPC")"
echo ""
echo "===================================================================="
echo " Demo reset complete"
echo "   HealthPools : $POOLS"
echo "   poolCount   : ${POOL_COUNT%% *}"
echo "   Explorer    : https://testnet.arcscan.app/address/$POOLS"
if [ -n "$VERDICT" ]; then
echo "   HealthVerdict: $VERDICT"
echo "   forwarder   : $(cast call "$VERDICT" 'forwarder()(address)' --rpc-url "$RPC")"
echo "   gate        : $(cast call "$POOLS" 'healthVerdict()(address)' --rpc-url "$RPC")"
else
echo "   gate        : OFF (oracle-only)"
fi
echo "   Updated     : .env, app/.env.local, DEPLOYMENTS.md"
echo "   Restart the dev server so it reads the new address."
echo ""
echo "   NEXT: point cre/wf-goal-verification/config.json at the new"
echo "         poolsAddress + the pool's periodStart, then re-run"
echo "         'cd cre && bun run dry-run' and update the golden hex in"
echo "         contracts/test/HealthVerdict.t.sol."
echo "===================================================================="
