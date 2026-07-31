#!/usr/bin/env bash
#
# Seed one demo pool that structurally CAN pay: entry fee 0 forces the
# split-pot model (a fixed bounty is a multiple of the entry fee, so model 0
# at fee 0 settles to zero for everyone - the zero-payout defect this script
# exists to avoid). The [doc] marker puts the pool on the document-evidence
# path the demo is built on.
#
# PERIOD defaults to 75 seconds so settle()'s block.timestamp > periodEnd gate
# does not make a one-take video impossible; override for longer-lived pools:
#   PERIOD=86400 ./scripts/seed-demo-pool.sh
#
# Reads HEALTH_POOLS_ADDRESS and DEPLOYER_PRIVATE_KEY from the repo-root .env.
# Echoes the new poolId and never rewrites env files or DEPLOYMENTS.md.
#
# Usage (from repo root):  ./scripts/seed-demo-pool.sh
# Optional overrides: PERIOD (seconds), FUND (micro-USDC pot),
#                     INITIATIVE, GOAL (goal text, marker added here).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"
set -a; source .env; set +a

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
USDC="${ARC_USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"
POOLS="$HEALTH_POOLS_ADDRESS"
DK="$DEPLOYER_PRIVATE_KEY"

PERIOD="${PERIOD:-75}"
FUND="${FUND:-50000000}"    # 50 USDC pot by default
INITIATIVE="${INITIATIVE:-preventive-care}"
GOAL="${GOAL:-Upload proof of a completed preventive-care visit (flu shot, screening, or lab work)}"
GOAL_SPEC="[doc] ${GOAL}"

DEPLOYER="$(cast wallet address --private-key "$DK")"

echo "== Seeding demo pool on $POOLS =="
echo "deployer   $DEPLOYER"
echo "pot        $FUND uUSDC"
echo "period     ${PERIOD}s"
echo "goal       $GOAL_SPEC"

NOW="$(date +%s)"; END=$((NOW + PERIOD))

# entryFee 0 REQUIRES bountyModel 1 (split pot); see header.
echo "-> approve + createPool (model 1, entry 0)"
cast send "$USDC" "approve(address,uint256)" "$POOLS" "$FUND" \
  --private-key "$DK" --rpc-url "$RPC" >/dev/null
cast send "$POOLS" "createPool(string,string,uint256,uint64,uint64,uint8,uint256)" \
  "$INITIATIVE" "$GOAL_SPEC" 0 "$NOW" "$END" 1 "$FUND" \
  --private-key "$DK" --rpc-url "$RPC" >/dev/null

PID="$(cast call "$POOLS" "poolCount()(uint256)" --rpc-url "$RPC")"; PID="${PID%% *}"
echo "== Seeded pool =="
echo "poolId = $PID"
echo "ends   = $(date -r "$END" 2>/dev/null || date -d "@$END")"
