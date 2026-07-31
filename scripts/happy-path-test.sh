#!/usr/bin/env bash
#
# Happy-path proof for GoHealthMe — proves the full on-chain loop LIVE on Arc:
#   create pool -> join (synthetic nullifier, deduped on-chain) -> oracle records
#   verdict -> settle -> USDC lands with the achiever.
#
# This is the one leg the Foundry tests can't cover: the oracle key signing a real
# recordResult transaction against the DEPLOYED contract on Arc. Uses a dedicated
# short-period, split-pot pool so it settles ~80s after creation. Run demo-reset.sh
# afterwards to clear the test pool before a real demo.
#
# Usage (from repo root):  ./scripts/happy-path-test.sh
# Needs ~1.5 USDC of headroom on the deployer (gas is native USDC). Top up:
# https://faucet.circle.com

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"
set -a; source .env; set +a

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
USDC="${ARC_USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"
POOLS="$HEALTH_POOLS_ADDRESS"
DK="$DEPLOYER_PRIVATE_KEY"
OK="$ORACLE_SIGNER_PRIVATE_KEY"
DEPLOYER="$(cast wallet address --private-key "$DK")"
ORACLE="$(cast wallet address --private-key "$OK")"
FUND=500000          # 0.5 USDC pot
PERIOD=75            # seconds until the pool period ends

bal() { local b; b="$(cast call "$USDC" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC")"; echo "${b%% *}"; }

echo "== Happy-path proof on $POOLS =="
echo "deployer $DEPLOYER  ($(bal "$DEPLOYER") uUSDC)"
echo "oracle   $ORACLE  ($(bal "$ORACLE") uUSDC)"

# 0. Oracle needs gas (native USDC) to sign recordResult.
if [ "$(bal "$ORACLE")" -lt 200000 ]; then
  echo "-> funding oracle 0.5 USDC for gas"
  cast send "$USDC" "transfer(address,uint256)" "$ORACLE" 500000 --private-key "$DK" --rpc-url "$RPC" >/dev/null
fi

# 1. Create a dedicated short-period split-pot pool.
NOW="$(date +%s)"; END=$((NOW + PERIOD))
echo "-> approve + create test pool (model 1, entry 0, pot $FUND, ends in ${PERIOD}s)"
cast send "$USDC" "approve(address,uint256)" "$POOLS" "$FUND" --private-key "$DK" --rpc-url "$RPC" >/dev/null
cast send "$POOLS" "createPool(string,string,uint256,uint64,uint64,uint8,uint256)" \
  "e2e-test" "Happy-path proof pool (delete via demo-reset)" 0 "$NOW" "$END" 1 "$FUND" \
  --private-key "$DK" --rpc-url "$RPC" >/dev/null
PID="$(cast call "$POOLS" "poolCount()(uint256)" --rpc-url "$RPC")"; PID="${PID%% *}"
echo "   poolId = $PID"

# 2. Deployer joins as participant with a synthetic nullifier (joinPool
#    dedupes it on-chain: one wallet, one entry).
NULL="$NOW"
echo "-> join pool $PID (nullifier $NULL)"
cast send "$POOLS" "joinPool(uint256,uint256)" "$PID" "$NULL" --private-key "$DK" --rpc-url "$RPC" >/dev/null

# 3. Oracle posts the verdict (the off-chain -> on-chain plumbing under test).
echo "-> oracle records verdict=true, multiplier 1x"
cast send "$POOLS" "recordResult(uint256,address,bool,uint16)" "$PID" "$DEPLOYER" true 10000 \
  --private-key "$OK" --rpc-url "$RPC" >/dev/null

# 4. Wait out the period, then settle.
WAIT=$((PERIOD + 15)); echo "-> waiting ${WAIT}s for period to end"; sleep "$WAIT"
BEFORE="$(bal "$DEPLOYER")"
echo "-> settle pool $PID"
cast send "$POOLS" "settle(uint256)" "$PID" --private-key "$DK" --rpc-url "$RPC" >/dev/null
AFTER="$(bal "$DEPLOYER")"

# 5. Assert the achiever was paid.
GAIN=$((AFTER - BEFORE))
echo ""
echo "deployer USDC: before settle $BEFORE -> after $AFTER  (gain $GAIN uUSDC)"
if [ "$GAIN" -gt 0 ]; then
  echo "PASS: full happy path proven live on Arc. USDC settled to the achiever."
  echo "      pool $PID -> https://testnet.arcscan.app/address/$POOLS"
else
  echo "FAIL: no USDC gain on settle (gain $GAIN). Investigate before relying on this."
  exit 1
fi
