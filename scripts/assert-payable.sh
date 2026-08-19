# Shared createPool guard (audit finding F-1). Source this and call
# assert_payable_pool_config <entryFee> <bountyModel> immediately before any
# createPool cast send.
#
# The one config that structurally cannot pay an achiever is a fixed bounty
# (bountyModel 0) with a zero entry fee: HealthPools._payAchievers derives each
# fixed-bounty payout as entryFee * multiplier / BPS, so at entryFee 0 the owed
# sum is zero, settle() returns early, AchieverPaid never fires, and the whole
# pot is reclaimable only by the creator via sweep(). entryFee is write-once, so
# the pool can never be repaired. The deployed contract is immutable and does
# not enforce this, so this guard is what keeps a dead pool off it from a script.
#
# Mirrors app/lib/pool-lifecycle.ts isEconomicallyDeadConfig. Returns non-zero
# (and, under set -e, aborts the caller) when the config would settle to zero.
assert_payable_pool_config() {
  local entry_fee="$1" bounty_model="$2"
  if [ "$bounty_model" = "0" ] && [ "$entry_fee" = "0" ]; then
    echo "ABORT: refusing to create a fixed-bounty (model 0) pool with entryFee 0 -- it settles to zero for every achiever and the pot only returns to the creator via sweep(). Use bountyModel 1 (split pot) or set an entry fee above zero." >&2
    return 1
  fi
  return 0
}
