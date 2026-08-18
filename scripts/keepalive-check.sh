#!/usr/bin/env bash
#
# Keep-alive health check for the live GoHealthMe / SPOTTER demo through
# judging (~2026-09-25). Read-only: touches no private keys. Prints a
# PASS / WARN / FAIL line per check and exits non-zero if anything is FAIL.
#
# Usage:  ./scripts/keepalive-check.sh
# Cron-friendly: pipe the output somewhere or check the exit code.

set -uo pipefail
export PATH="$PATH:$HOME/.foundry/bin"

APP="https://gohealthme-circle.vercel.app"
RPC="https://rpc.blockdaemon.testnet.arc.network"
POOLS="0xc4274eF2cBe28f77Af31b980055Cc1171818390C"
USDC="0x3600000000000000000000000000000000000000"
SPOTTER="0xd0d23b4ade9f55ca10e9c8a4e5b1e135f72c824d"
DEPLOYER="0xc278e8e4621A0Ba02bACB6291E595ecd168A04e1"
ATTESTER="https://35-225-10-254.sslip.io"

# Thresholds
DAYS_WARN=7           # warn if the soonest payable pool expires within N days
USDC_FLOOR=500000     # 0.5 USDC (6dp)
GAS_FLOOR_WEI=100000000000000000  # 0.1 native token

NOW=$(date +%s)
rc=0
echo "GoHealthMe keep-alive check  $(date -u +%FT%TZ)"
echo "----------------------------------------------"

# 1. App reachable on the production alias
code=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$APP" 2>/dev/null)
if [ "$code" = "200" ]; then echo "PASS  app         $APP -> 200"
else echo "FAIL  app         $APP -> ${code:-no-response}"; rc=1; fi

# 2. At least one OPEN + payable pool, and its runway
CNT=$(cast call --rpc-url "$RPC" "$POOLS" "poolCount()(uint256)" 2>/dev/null); CNT=${CNT%% *}
payable_open=0; soonest=0
for i in $(seq 1 "${CNT:-0}"); do
  H=$(cast call --rpc-url "$RPC" "$POOLS" "getPool(uint256)" "$i" 2>/dev/null); H=${H#0x}
  [ -z "$H" ] && continue
  w(){ echo "${H:$((64*$1)):64}"; }
  bm=$(cast --to-dec 0x$(w 2) 2>/dev/null); settled=$(cast --to-dec 0x$(w 3) 2>/dev/null)
  pe=$(cast --to-dec 0x$(w 5) 2>/dev/null); bal=$(cast --to-dec 0x$(w 7) 2>/dev/null)
  # payable = split-pot model with a funded balance, unsettled, not expired
  if [ "$bm" = "1" ] && [ "${bal:-0}" -gt 0 ] && [ "$settled" = "0" ] && [ "${pe:-0}" -gt "$NOW" ]; then
    payable_open=$((payable_open+1))
    if [ "$soonest" -eq 0 ] || [ "$pe" -lt "$soonest" ]; then soonest=$pe; fi
  fi
done
if [ "$payable_open" -eq 0 ]; then
  echo "FAIL  pools       no OPEN payable pool exists (judge has no completable payout)"; rc=1
else
  days=$(( (soonest - NOW) / 86400 ))
  if [ "$days" -lt "$DAYS_WARN" ]; then
    echo "WARN  pools       $payable_open payable open; soonest expires in ${days}d ($(date -u -r "$soonest" +%F)) -- re-seed soon"
  else
    echo "PASS  pools       $payable_open payable open; soonest expires in ${days}d ($(date -u -r "$soonest" +%F))"
  fi
fi

# 3. Wallet funding (SPOTTER settles; DEPLOYER seeds)
check_wallet() {
  local label=$1 addr=$2
  local u=$(cast call --rpc-url "$RPC" "$USDC" "balanceOf(address)(uint256)" "$addr" 2>/dev/null); u=${u%% *}
  local g=$(cast balance --rpc-url "$RPC" "$addr" 2>/dev/null); g=${g%% *}
  local tag=PASS
  if [ "${u:-0}" -lt "$USDC_FLOOR" ] || [ "${g:-0}" -lt "$GAS_FLOOR_WEI" ]; then tag=WARN; rc=$((rc==1?1:0)); fi
  printf "%s  %-11s USDC=%s.%06d  gas_wei=%s\n" "$tag" "$label" "$(( ${u:-0} / 1000000 ))" "$(( ${u:-0} % 1000000 ))" "${g:-0}"
}
check_wallet "spotter" "$SPOTTER"
check_wallet "deployer" "$DEPLOYER"

# 4. Attester (informational -- expected offline when the VM is paused).
# /healthz answers 200 unauthenticated; /v1/attestation needs the API key (401).
acode=$(curl -sk -o /dev/null -w "%{http_code}" -m 10 "$ATTESTER/healthz" 2>/dev/null)
if [ "$acode" = "200" ]; then echo "PASS  attester     live (/healthz 200) -- full upload->verdict->settle works"
else echo "INFO  attester     offline (VM paused) -- browse+proofs live; restart VM for live verification"; fi

echo "----------------------------------------------"
[ "$rc" -eq 0 ] && echo "OK" || echo "ATTENTION NEEDED"
exit "$rc"
