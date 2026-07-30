#!/usr/bin/env bash
#
# Hand HealthPools' oracle role to SPOTTER's Circle wallet.
#
# One owner call, zero Solidity changes: after this, the Circle wallet is the
# only address that can recordResult(), and settle() stays permissionless, so
# the same wallet can settle. This is what makes SPOTTER the on-chain actor.
#
# DO NOT run this before the agent run loop exists. The app's oracle-signer
# path (ORACLE_SIGNER_PRIVATE_KEY -> recordResult) stops working the moment
# the oracle changes, and demo-reset.sh deploys fresh contracts with the old
# oracle, so re-run this after every reset.
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

echo "==> SPOTTER can now recordResult() and settle(). The old oracle signer cannot."
