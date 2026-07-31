#!/usr/bin/env bash
#
# Tier 1 gate proof — the Chainlink HealthVerdict registry gates HealthPools
# settlement. Deploys a FRESH gated HealthPools (prod 0x72D3...2064 is left
# untouched), wires it to the live HealthVerdict registry, then runs TWO
# participants through IDENTICAL oracle results. The only difference: one has a
# verdict in the registry (canSettle), the other does not. Only the verdict-
# backed participant gets paid -> the Chainlink verdict is load-bearing.
#
# Roles:
#   deployer 0xc278  = creator / funder / owner (deploys, funds, settles)
#   participant A    = treasury 0x9bC9  -> gets a HealthVerdict verdict -> PAID
#   participant B    = oracle  0xA56e   -> NO verdict -> gated out -> 0
#   oracle 0xA56e    = records results for BOTH + the verdict for A only

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
export PATH="$PATH:$HOME/.foundry/bin"

RPC=https://rpc.testnet.arc.network
USDC=0x3600000000000000000000000000000000000000
# Registry to gate against. Synced into .env by scripts/demo-reset.sh, so this
# proof always runs against the currently-wired HealthVerdict rather than a
# stale hardcoded one.
HV=$(grep '^HEALTH_VERDICT_ADDRESS=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')
[ -n "$HV" ] || { echo "ABORT: HEALTH_VERDICT_ADDRESS not set in .env — run ./scripts/demo-reset.sh first" >&2; exit 1; }
echo "registry under test: $HV"

DPK=$(grep '^DEPLOYER_PRIVATE_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')
OPK=$(grep '^ORACLE_SIGNER_PRIVATE_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')
APK=$(grep '^UNLINK_TREASURY_PRIVATE_KEY=' app/.env.local | head -1 | cut -d= -f2- | tr -d '"' | tr -d ' ')

DEPLOYER=$(cast wallet address --private-key "$DPK")
ORACLE=$(cast wallet address --private-key "$OPK")
A=$(cast wallet address --private-key "$APK")
B="$ORACLE"

echo "creator/funder: $DEPLOYER"
echo "A (verdict -> paid): $A"
echo "B (no verdict -> gated out): $B"
echo ""

# 1) Deploy a fresh GATED HealthPools (constructor: token, oracle)
echo "== deploy fresh gated HealthPools =="
cd contracts
NEWPOOLS=$(forge create src/HealthPools.sol:HealthPools --rpc-url "$RPC" --private-key "$DPK" --broadcast --constructor-args "$USDC" "$ORACLE" 2>&1 | grep -i "Deployed to:" | awk '{print $3}')
cd "$ROOT"
[ -n "$NEWPOOLS" ] || { echo "ABORT: deploy failed"; exit 1; }
echo "   HealthPools (gated) = $NEWPOOLS"

# 2) Turn on the gate -> settle now requires canSettle(goalId)
cast send "$NEWPOOLS" 'setHealthVerdict(address)' "$HV" --private-key "$DPK" --rpc-url "$RPC" >/dev/null
echo "   gate ON: healthVerdict = $(cast call "$NEWPOOLS" 'healthVerdict()(address)' --rpc-url "$RPC")"

# 3) Create + fund a short split-pot pool (entry 0, 2 USDC pot, 120s window)
NOW=$(date +%s); END=$((NOW + 120))
cast send "$USDC" 'approve(address,uint256)' "$NEWPOOLS" 2000000 --private-key "$DPK" --rpc-url "$RPC" >/dev/null
cast send "$NEWPOOLS" 'createPool(string,string,uint256,uint64,uint64,uint8,uint256)' \
  "tier1-gate-proof" "[doc] total cholesterol under 200 mg/dL" 0 "$NOW" "$END" 1 2000000 \
  --private-key "$DPK" --rpc-url "$RPC" >/dev/null
PID=$(cast call "$NEWPOOLS" 'poolCount()(uint256)' --rpc-url "$RPC"); PID=${PID%% *}
echo "   pool $PID created (2 USDC pot, split-pot, ends in ~120s)"

# 4) Both join (synthetic nullifiers; joinPool only dedupes them on-chain)
cast send "$NEWPOOLS" 'joinPool(uint256,uint256)' "$PID" 111 --private-key "$APK" --rpc-url "$RPC" >/dev/null && echo "   A joined"
cast send "$NEWPOOLS" 'joinPool(uint256,uint256)' "$PID" 222 --private-key "$OPK" --rpc-url "$RPC" >/dev/null && echo "   B joined"

# 5) Oracle records IDENTICAL passing results for BOTH (the AI judged both as pass)
cast send "$NEWPOOLS" 'recordResult(uint256,address,bool,uint16)' "$PID" "$A" true 20000 --private-key "$OPK" --rpc-url "$RPC" >/dev/null && echo "   recordResult A = pass"
cast send "$NEWPOOLS" 'recordResult(uint256,address,bool,uint16)' "$PID" "$B" true 20000 --private-key "$OPK" --rpc-url "$RPC" >/dev/null && echo "   recordResult B = pass"

# 6) The ONLY difference: a Chainlink HealthVerdict for A, none for B
GOAL_A=$(cast call "$NEWPOOLS" 'computeGoalId(uint256,address)(bytes32)' "$PID" "$A" --rpc-url "$RPC")
GOAL_B=$(cast call "$NEWPOOLS" 'computeGoalId(uint256,address)(bytes32)' "$PID" "$B" --rpc-url "$RPC")
DIGEST=$(cast keccak "tier1-proof:A")
cast send "$HV" 'recordVerdict(bytes32,bool,uint8,bytes32,uint16)' "$GOAL_A" true 2 "$DIGEST" 6 --private-key "$OPK" --rpc-url "$RPC" >/dev/null
echo "   recordVerdict A only"
echo "   canSettle A = $(cast call "$HV" 'canSettle(bytes32)(bool)' "$GOAL_A" --rpc-url "$RPC")  |  canSettle B = $(cast call "$HV" 'canSettle(bytes32)(bool)' "$GOAL_B" --rpc-url "$RPC")"

# 7) Wait out the period, snapshot, settle, snapshot
echo "   waiting for period to end..."
sleep $(( END - $(date +%s) + 6 ))
A_BEF=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$A" --rpc-url "$RPC"); A_BEF=${A_BEF%% *}
B_BEF=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$B" --rpc-url "$RPC"); B_BEF=${B_BEF%% *}
SETTLE_TX=$(cast send "$NEWPOOLS" 'settle(uint256)' "$PID" --private-key "$DPK" --rpc-url "$RPC" --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("transactionHash",""))' 2>/dev/null || echo "")
A_AFT=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$A" --rpc-url "$RPC"); A_AFT=${A_AFT%% *}
B_AFT=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$B" --rpc-url "$RPC"); B_AFT=${B_AFT%% *}

echo ""
echo "================= RESULT ================="
echo "A (HAS Chainlink verdict): $A_BEF -> $A_AFT   gain = $((A_AFT - A_BEF)) uUSDC"
echo "B (NO  Chainlink verdict): $B_BEF -> $B_AFT   gain = $((B_AFT - B_BEF)) uUSDC"
echo "settle tx: ${SETTLE_TX:-<run failed>}"
echo "gated HealthPools: $NEWPOOLS"
if [ "$((A_AFT - A_BEF))" -gt 0 ] && [ "$((B_AFT - B_BEF))" -eq 0 ]; then
  echo "PASS: identical oracle results, but ONLY the verdict-backed participant was paid."
  echo "      The Chainlink HealthVerdict is load-bearing: no verdict -> no payout."
else
  echo "CHECK: inspect the gains above."
fi
