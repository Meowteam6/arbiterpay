#!/usr/bin/env bash
#
# Full document-evidence chain proof (on-chain, agent-driven):
#   create doc pool -> join -> upload cholesterol doc -> attester verdict ->
#   SPOTTER's run loop records + settles -> USDC lands with the achiever.
#
# Proves the multimodal/preventive-care path end to end THROUGH THE AGENT:
# after /api/evidence/submit the script only polls POST /api/agent/run/<goalId>
# (the same door the frontend uses); SPOTTER does the recording, the registry
# write, and the settlement. Uses a short-period throwaway pool so settle runs
# in ~90s. Needs the dev server (APP_URL, default :3000) with the SPOTTER env
# configured, and a funded deployer. Run from repo root.
#
# PASS is asserted on the USDC delta, never on transaction success alone.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"
source "$ROOT/scripts/assert-payable.sh"
set -a; source .env; set +a

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
USDC="${ARC_USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"
POOLS="$HEALTH_POOLS_ADDRESS"
KEY="$DEPLOYER_PRIVATE_KEY"
ME="$(cast wallet address --private-key "$KEY")"
APP="${APP_URL:-http://localhost:3000}"
GOAL="[doc] Upload a lab report showing total cholesterol under 200 mg/dL"
FUND=1000000   # 1 USDC pot
PERIOD=90

echo "== doc-evidence agent-run test on $POOLS (participant $ME, app $APP) =="

NOW="$(date +%s)"; END=$((NOW + PERIOD))
assert_payable_pool_config 0 1
echo "-> approve + create short-period doc pool (model 1 split-pot)"
cast send "$USDC" "approve(address,uint256)" "$POOLS" "$FUND" --private-key "$KEY" --rpc-url "$RPC" >/dev/null
cast send "$POOLS" "createPool(string,string,uint256,uint64,uint64,uint8,uint256)" \
  "cholesterol-test" "$GOAL" 0 "$NOW" "$END" 1 "$FUND" --private-key "$KEY" --rpc-url "$RPC" >/dev/null
PID="$(cast call "$POOLS" "poolCount()(uint256)" --rpc-url "$RPC")"; PID="${PID%% *}"
echo "   poolId = $PID"

echo "-> join pool $PID (synthetic nullifier; joinPool dedupes it on-chain)"
cast send "$POOLS" "joinPool(uint256,uint256)" "$PID" "$NOW" --private-key "$KEY" --rpc-url "$RPC" >/dev/null

# Snapshot BEFORE any agent run: the participant sends no transactions after
# this point (SPOTTER settles from its own wallet), so the final delta is
# exactly the payout even if the agent settles earlier than expected.
BEFORE="$(cast call "$USDC" 'balanceOf(address)(uint256)' "$ME" --rpc-url "$RPC")"; BEFORE="${BEFORE%% *}"

echo "-> submit cholesterol doc to the attester via /api/evidence/submit"
B64="$(base64 -i app/public/demo-evidence/cholesterol-panel.txt | tr -d '\n')"
SUB="$(curl -s -m 30 -X POST "$APP/api/evidence/submit" -H 'Content-Type: application/json' \
  -d "{\"poolId\":\"$PID\",\"address\":\"$ME\",\"goalSpec\":\"$GOAL\",\"fileBase64\":\"$B64\",\"fileName\":\"cholesterol-panel.txt\",\"contentType\":\"text/plain\"}")"
AID="$(echo "$SUB" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("attesterId",""))')"
[ -n "$AID" ] || { echo "ABORT: no attesterId from /api/evidence/submit: $SUB" >&2; exit 1; }
echo "   attesterId = $AID"

# The run route requires the path goalId to equal the chain-derived id.
GOALID="$(cast call "$POOLS" "computeGoalId(uint256,address)(bytes32)" "$PID" "$ME" --rpc-url "$RPC")"
GOALID="${GOALID%% *}"
echo "   goalId = $GOALID"

BODY="{\"attesterId\":\"$AID\",\"poolId\":\"$PID\",\"address\":\"$ME\",\"goalSpec\":\"$GOAL\"}"
run_agent() {
  curl -s -m 60 -X POST "$APP/api/agent/run/$GOALID" -H 'Content-Type: application/json' -d "$BODY"
}
status_of() {
  echo "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null
}

echo "-> poll POST /api/agent/run/$GOALID until SPOTTER records the verdict"
ST=""
for i in $(seq 1 15); do
  sleep 4
  R="$(run_agent)"; ST="$(status_of "$R")"
  echo "   poll $i: status=${ST:-<unparseable: $R>}"
  case "$ST" in
    recorded|paid) break ;;
    verifying|"") ;;  # still working (or transient parse error) — keep polling
    *) echo "ABORT: agent run ended in status '$ST': $R" >&2; exit 1 ;;
  esac
done
[ "$ST" = "recorded" ] || [ "$ST" = "paid" ] || { echo "ABORT: verdict never recorded (last status '$ST')" >&2; exit 1; }

echo "-> waiting out the period, then let the AGENT settle"
sleep $((PERIOD + 10))
for i in $(seq 1 10); do
  R="$(run_agent)"; ST="$(status_of "$R")"
  echo "   settle poll $i: status=${ST:-<unparseable: $R>}"
  [ "$ST" = "paid" ] && break
  case "$ST" in error|no-pay|blocked|cap-exceeded) echo "ABORT: agent run ended in status '$ST': $R" >&2; exit 1 ;; esac
  sleep 5
done
AFTER="$(cast call "$USDC" 'balanceOf(address)(uint256)' "$ME" --rpc-url "$RPC")"; AFTER="${AFTER%% *}"

echo ""
echo "final agent status: ${ST:-<none>}"
echo "USDC before settle $BEFORE -> after $AFTER (gain $((AFTER - BEFORE)) uUSDC)"
if [ "$ST" = "paid" ] && [ "$AFTER" -gt "$BEFORE" ]; then
  echo "PASS: full document-evidence chain proven on-chain, agent-driven (create -> join -> doc -> attester verdict -> SPOTTER record -> SPOTTER settle -> paid)"
else
  echo "CHECK: agent status=${ST:-none}; settle gain=$((AFTER-BEFORE)). Inspect above."
fi
