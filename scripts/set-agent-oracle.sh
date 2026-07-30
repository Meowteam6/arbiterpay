#!/usr/bin/env bash
#
# Hand the on-chain verification roles to SPOTTER's Circle wallet.
#
# Two owner calls, zero Solidity changes:
#   1. HealthPools.setOracle     - SPOTTER becomes the only recordResult caller
#   2. HealthVerdict.setAttester - SPOTTER becomes the only recordVerdict caller
# settle() stays permissionless, so the same wallet settles. Both roles flip
# together; flipping only one leaves the record step half-broken. The agent
# run loop (app/lib/server/agent/run.ts) reads both roles from the chain and
# dispatches to whichever key currently holds them, so this cutover needs no
# app deploy in either direction.
#
# demo-reset.sh deploys fresh contracts with the legacy oracle, so re-run
# this after every reset.
#
# Usage (from repo root):
#   ./scripts/set-agent-oracle.sh 0xSPOTTER_ADDRESS
#   ./scripts/set-agent-oracle.sh              # falls back to SPOTTER_WALLET_ADDRESS in .env
#
# Requires: foundry on PATH, DEPLOYER_PRIVATE_KEY (the contract owner) in .env.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"

[ -f .env ] || { echo "error: .env not found at repo root" >&2; exit 1; }
set -a; source .env; set +a

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
POOLS="${HEALTH_POOLS_ADDRESS:?HEALTH_POOLS_ADDRESS missing from .env}"
VERDICT="${HEALTH_VERDICT_ADDRESS:-}"
KEY="${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY missing from .env}"
NEW_ORACLE="${1:-${SPOTTER_WALLET_ADDRESS:-}}"

[ -n "$NEW_ORACLE" ] || {
  echo "error: pass the SPOTTER wallet address or set SPOTTER_WALLET_ADDRESS in .env" >&2
  exit 1
}

OWNER="$(cast wallet address --private-key "$KEY")"
CURRENT="$(cast call "$POOLS" "oracle()(address)" --rpc-url "$RPC")"

echo "==> HealthPools $POOLS"
echo "    owner:          $OWNER"
echo "    oracle now:     $CURRENT"
echo "    oracle after:   $NEW_ORACLE"

if [ "$(echo "$CURRENT" | tr '[:upper:]' '[:lower:]')" = "$(echo "$NEW_ORACLE" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "==> oracle already set to SPOTTER; nothing to do"
  exit 0
fi

cast send "$POOLS" "setOracle(address)" "$NEW_ORACLE" \
  --private-key "$KEY" --rpc-url "$RPC" >/dev/null

AFTER="$(cast call "$POOLS" "oracle()(address)" --rpc-url "$RPC")"
echo "==> oracle is now:  $AFTER"

if [ "$(echo "$AFTER" | tr '[:upper:]' '[:lower:]')" != "$(echo "$NEW_ORACLE" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "error: oracle readback does not match; investigate before trusting settlement" >&2
  exit 1
fi

if [ -n "$VERDICT" ]; then
  ATT_NOW="$(cast call "$VERDICT" "attester()(address)" --rpc-url "$RPC")"
  echo "==> HealthVerdict $VERDICT"
  echo "    attester now:   $ATT_NOW"
  if [ "$(echo "$ATT_NOW" | tr '[:upper:]' '[:lower:]')" = "$(echo "$NEW_ORACLE" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "==> attester already set to SPOTTER; nothing to do"
  else
    cast send "$VERDICT" "setAttester(address)" "$NEW_ORACLE" \
      --private-key "$KEY" --rpc-url "$RPC" >/dev/null
    ATT_AFTER="$(cast call "$VERDICT" "attester()(address)" --rpc-url "$RPC")"
    echo "==> attester is now: $ATT_AFTER"
    if [ "$(echo "$ATT_AFTER" | tr '[:upper:]' '[:lower:]')" != "$(echo "$NEW_ORACLE" | tr '[:upper:]' '[:lower:]')" ]; then
      echo "error: attester readback does not match; the record step is half-flipped" >&2
      exit 1
    fi
  fi
else
  echo "==> HEALTH_VERDICT_ADDRESS unset: skipping setAttester (oracle-only deployment)"
fi

echo "==> SPOTTER now holds recordResult and recordVerdict. The old oracle signer holds neither."
