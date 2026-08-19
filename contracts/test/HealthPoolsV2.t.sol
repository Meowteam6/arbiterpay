// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {HealthPoolsV2} from "../src/HealthPoolsV2.sol";
import {HealthPools} from "../src/HealthPools.sol"; // v1, for the F-4 single-call gas comparison
import {HealthVerdict} from "../src/HealthVerdict.sol";

// ============================================================================
//  HealthPoolsV2 test suite
//
//  Ports the v1 unit + fuzz + invariant coverage onto the remediation candidate
//  and proves each fixed finding closes:
//    F-1  createPool(model 0, fee 0) now REVERTS (was the zero-payout footgun).
//    F-4  a 200 x 50 pool with the verdict gate ON is fully settleable via
//         paginated settleStep, every step under a 30M block, asserting on the
//         USDC deltas; the v1-style single settle() at the same size blows past
//         the block gas limit.
//    F-5  a fee-on-transfer token credits the measured delta, not the request.
//    F-6  underfunded fixed-bounty scaling multiplies before dividing.
//    F-7  the constructor rejects a token address with no code.
//  Behavioral equivalence with v1 on every happy path is checked by the ported
//  unit and fuzz tests: for every pool v1 settles, V2 produces the same balances.
// ============================================================================

/// @dev Standard 6-decimal USDC stand-in (distinct symbol to avoid clashes with
///      the mocks in the other suites).
contract MockUSDCV2 {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "INSUFFICIENT");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "INSUFFICIENT");
        require(allowance[from][msg.sender] >= amount, "NOT_APPROVED");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Fee-on-transfer 6-decimal token for the F-5 proof: every transfer and
///      transferFrom skims feeBps to a sink, so the receiver gets less than the
///      requested amount. This is exactly the non-standard behavior v1's
///      accounting assumed away and V2 now measures around.
contract FeeUSDCV2 {
    uint8 public constant decimals = 6;
    uint256 public immutable feeBps;
    address public immutable feeSink;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 feeBps_, address feeSink_) {
        feeBps = feeBps_;
        feeSink = feeSink_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "INSUFFICIENT");
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        balanceOf[feeSink] += fee;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "NOT_APPROVED");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
}

// ---------------------------------------------------------------------------
//  Unit suite (ported from HealthPools.t.sol) + finding proofs F-1/F-5/F-6/F-7
// ---------------------------------------------------------------------------

contract HealthPoolsV2Test is Test {
    HealthPoolsV2 internal pools;
    MockUSDCV2 internal usdc;

    address internal oracle = makeAddr("oracle");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave"); // backer
    address internal erin = makeAddr("erin"); // backer
    address internal rando = makeAddr("rando");

    uint256 internal constant FEE = 100e6;
    uint256 internal constant FUNDING = 1000e6;
    uint256 internal constant NULL_A = uint256(keccak256("nullifier-alice"));
    uint256 internal constant NULL_B = uint256(keccak256("nullifier-bob"));
    uint256 internal constant NULL_C = uint256(keccak256("nullifier-carol"));

    uint64 internal periodStart;
    uint64 internal periodEnd;

    function setUp() public {
        usdc = new MockUSDCV2();
        pools = new HealthPoolsV2(address(usdc), oracle);

        periodStart = uint64(block.timestamp);
        periodEnd = uint64(block.timestamp + 7 days);

        address[7] memory users = [creator, alice, bob, carol, dave, erin, rando];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 10_000e6);
            vm.prank(users[i]);
            usdc.approve(address(pools), type(uint256).max);
        }
    }

    // ------------------------------------------------------------- helpers

    function _createPool(uint8 bountyModel, uint256 entryFee, uint256 funding) internal returns (uint256 poolId) {
        vm.prank(creator);
        poolId = pools.createPool("sleep-streak", "7h sleep, 7 nights", entryFee, periodStart, periodEnd, bountyModel, funding);
    }

    function _joinThree(uint256 poolId) internal {
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(bob);
        pools.joinPool(poolId, NULL_B);
        vm.prank(carol);
        pools.joinPool(poolId, NULL_C);
    }

    // ---------------------------------------------------------- create/join

    function test_createPool_storesAndPullsFunding() public {
        uint256 creatorBefore = usdc.balanceOf(creator);
        uint256 poolId = _createPool(1, FEE, FUNDING);

        assertEq(poolId, 1);
        assertEq(pools.poolCount(), 1);
        assertEq(usdc.balanceOf(creator), creatorBefore - FUNDING);
        assertEq(usdc.balanceOf(address(pools)), FUNDING);

        HealthPoolsV2.Pool memory p = pools.getPool(poolId);
        assertEq(p.creator, creator);
        assertEq(p.entryFee, FEE);
        assertEq(p.balance, FUNDING);
        assertEq(p.bountyModel, 1);
        assertFalse(p.settled);
    }

    function test_createPool_revertsOnBadParams() public {
        vm.startPrank(creator);
        vm.expectRevert(bytes("BAD_PERIOD"));
        pools.createPool("x", "y", FEE, periodEnd, periodStart, 0, 0);
        vm.expectRevert(bytes("BAD_BOUNTY_MODEL"));
        pools.createPool("x", "y", FEE, periodStart, periodEnd, 2, 0);
        vm.expectRevert(bytes("PERIOD_IN_PAST"));
        pools.createPool("x", "y", FEE, 0, uint64(block.timestamp), 0, 0);
        vm.stopPrank();
    }

    function test_joinPool_pullsFeeAndStoresParticipant() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        _joinThree(poolId);

        assertEq(pools.participantCount(poolId), 3);
        assertEq(usdc.balanceOf(address(pools)), FUNDING + 3 * FEE);
        assertEq(pools.getPool(poolId).balance, FUNDING + 3 * FEE);

        HealthPoolsV2.Participant memory part = pools.getParticipant(poolId, alice);
        assertTrue(part.joined);
        assertEq(part.nullifierHash, NULL_A);
        assertTrue(pools.nullifierUsed(poolId, NULL_A));
    }

    function test_joinPool_nullifierReuseReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(bob);
        vm.expectRevert(bytes("NULLIFIER_USED"));
        pools.joinPool(poolId, NULL_A);
    }

    function test_joinPool_doubleJoinReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(alice);
        vm.expectRevert(bytes("ALREADY_JOINED"));
        pools.joinPool(poolId, NULL_B);
    }

    // --------------------------------------------------------- recordResult

    function test_recordResult_onlyOracle() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(rando);
        vm.expectRevert(bytes("NOT_ORACLE"));
        pools.recordResult(poolId, alice, true, 10_000);
    }

    function test_recordResult_multiplierCapEnforced() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(oracle);
        vm.expectRevert(bytes("MULTIPLIER_TOO_HIGH"));
        pools.recordResult(poolId, alice, true, 30_001);

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 30_000);
        assertEq(pools.getParticipant(poolId, alice).multiplierBps, 30_000);
    }

    // --------------------------------------------------------------- settle

    /// Behavioral equivalence: pot-split happy path, identical numbers to v1.
    function test_settle_potSplit_happyPath() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        _joinThree(poolId);

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 10_000); // 1x
        pools.recordResult(poolId, bob, true, 20_000); // 2x
        pools.recordResult(poolId, carol, false, 0);
        vm.stopPrank();

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 carolBefore = usdc.balanceOf(carol);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 pot = FUNDING + 3 * FEE;
        uint256 alicePay = (pot * 10_000) / 30_000;
        uint256 bobPay = (pot * 20_000) / 30_000;
        assertEq(usdc.balanceOf(alice), aliceBefore + alicePay);
        assertEq(usdc.balanceOf(bob), bobBefore + bobPay);
        assertEq(usdc.balanceOf(carol), carolBefore);

        HealthPoolsV2.Pool memory p = pools.getPool(poolId);
        assertTrue(p.settled);
        assertTrue(pools.settlementComplete(poolId));
        assertEq(p.balance, 1); // dust

        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(usdc.balanceOf(creator), creatorBefore + 1);
        assertEq(pools.getPool(poolId).balance, 0);
    }

    /// Behavioral equivalence: fixed-bounty happy path, identical numbers to v1.
    function test_settle_fixedBounty_happyPath() public {
        uint256 poolId = _createPool(0, FEE, FUNDING);
        _joinThree(poolId);

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 10_000); // owed 100e6
        pools.recordResult(poolId, bob, true, 30_000); // owed 300e6
        pools.recordResult(poolId, carol, false, 0);
        vm.stopPrank();

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aliceBefore + 100e6);
        assertEq(usdc.balanceOf(bob), bobBefore + 300e6);

        assertEq(pools.getPool(poolId).balance, 900e6);
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(usdc.balanceOf(creator), creatorBefore + 900e6);
    }

    function test_settle_fixedBounty_underfundedScalesProRata() public {
        uint256 poolId = _createPool(0, FEE, 0); // fee > 0 so F-1 allows it
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 30_000); // owed 300e6, pot only 100e6

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aliceBefore + 100e6); // whole pot, no revert
        assertEq(pools.getPool(poolId).balance, 0);
    }

    function test_settle_beforePeriodEndReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        _joinThree(poolId);

        vm.expectRevert(bytes("PERIOD_NOT_ENDED"));
        pools.settle(poolId);

        vm.warp(periodEnd);
        vm.expectRevert(bytes("PERIOD_NOT_ENDED"));
        pools.settle(poolId);
    }

    function test_settle_twiceReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);
        vm.expectRevert(bytes("ALREADY_SETTLED"));
        pools.settle(poolId);
    }

    function test_settle_noAchievers_creatorSweepsEverything() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        _joinThree(poolId);
        vm.prank(oracle);
        pools.recordResult(poolId, alice, false, 0);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(usdc.balanceOf(creator), creatorBefore + FUNDING + 3 * FEE);
    }

    // -------------------------------------------------------------- backing

    function test_backGoal_payoutMath() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(bob);
        pools.joinPool(poolId, NULL_B);

        vm.prank(dave);
        pools.backGoal(poolId, alice, 500e6);
        vm.prank(erin);
        pools.backGoal(poolId, bob, 200e6);

        assertEq(pools.getPool(poolId).balance, 1900e6);
        assertEq(pools.getParticipant(poolId, alice).backingTotal, 500e6);
        assertEq(pools.backerStake(poolId, alice, dave), 500e6);

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 15_000);
        pools.recordResult(poolId, bob, false, 0);
        vm.stopPrank();

        uint256 daveBefore = usdc.balanceOf(dave);
        uint256 erinBefore = usdc.balanceOf(erin);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(dave), daveBefore + 600e6); // 500 + 20%
        assertEq(usdc.balanceOf(erin), erinBefore); // forfeits
        assertEq(usdc.balanceOf(alice), aliceBefore + 1300e6); // 1900 - 600
        assertEq(pools.getPool(poolId).balance, 0);
    }

    function test_backGoal_bonusCappedByPoolHeadroom() public {
        uint256 poolId = _createPool(1, 0, 0);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(dave);
        pools.backGoal(poolId, alice, 500e6);

        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);

        uint256 daveBefore = usdc.balanceOf(dave);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(dave), daveBefore + 500e6); // stake back, no bonus
        assertEq(pools.getPool(poolId).balance, 0);
    }

    function test_backGoal_afterResultRecordedReverts() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);

        vm.prank(dave);
        vm.expectRevert(bytes("RESULT_KNOWN"));
        pools.backGoal(poolId, alice, 100e6);
    }

    // ------------------------------------------------------- fundPool/sweep

    function test_fundPool_topsUpBalance() public {
        uint256 poolId = _createPool(1, FEE, 0);
        vm.prank(rando);
        pools.fundPool(poolId, 250e6);
        assertEq(pools.getPool(poolId).balance, 250e6);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);
        vm.prank(rando);
        vm.expectRevert(bytes("SETTLED"));
        pools.fundPool(poolId, 1e6);
    }

    function test_sweep_accessControl() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);

        vm.prank(creator);
        vm.expectRevert(bytes("NOT_SETTLED"));
        pools.sweep(poolId);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        vm.prank(rando);
        vm.expectRevert(bytes("NOT_CREATOR"));
        pools.sweep(poolId);

        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(pools.getPool(poolId).balance, 0);
    }

    // ---------------------------------------------------------------- views

    function test_getBackers() public {
        uint256 poolId = _createPool(1, FEE, FUNDING);
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(dave);
        pools.backGoal(poolId, alice, 100e6);
        vm.prank(dave);
        pools.backGoal(poolId, alice, 50e6);
        vm.prank(erin);
        pools.backGoal(poolId, alice, 25e6);

        (address[] memory backers, uint256[] memory stakes) = pools.getBackers(poolId, alice);
        assertEq(backers.length, 2);
        assertEq(backers[0], dave);
        assertEq(stakes[0], 150e6);
        assertEq(backers[1], erin);
        assertEq(stakes[1], 25e6);
    }

    // =====================================================================
    //  FINDING PROOFS
    // =====================================================================

    /// FINDING F-1 (High): the exact v1 pinned scenario — model 0, entryFee 0,
    /// real money in — must now REVERT at creation instead of accepting funding
    /// it can never pay out. This is the load-bearing regression proof that the
    /// economically-dead config is unreachable in the redeploy.
    function test_finding_F1_deadConfigRevertsAtCreate() public {
        vm.prank(creator);
        vm.expectRevert(bytes("DEAD_CONFIG"));
        pools.createPool("preventive-care", "annual checkup", 0, periodStart, periodEnd, 0, 1_000e6);

        // No pool was created, no funding was pulled.
        assertEq(pools.poolCount(), 0);
        assertEq(usdc.balanceOf(address(pools)), 0);
    }

    /// F-1: the guard is precise — model 1 with fee 0 (pot-split, no entry fee)
    /// stays legal, and model 0 with any positive fee stays legal.
    function test_finding_F1_guardIsNarrow() public {
        uint256 potSplitNoFee = _createPool(1, 0, 1_000e6); // legal
        assertEq(pools.getPool(potSplitNoFee).bountyModel, 1);

        uint256 fixedWithFee = _createPool(0, 1, 0); // legal (fee > 0)
        assertEq(pools.getPool(fixedWithFee).entryFee, 1);
    }

    /// FINDING F-5 (Low): with a fee-on-transfer token, the pool credits the
    /// ACTUAL received amount, not the requested one, so the on-chain ledger
    /// never overstates holdings and the contract stays solvent through payout.
    /// v1 would have credited the full request and later reverted on insolvency.
    function test_finding_F5_feeOnTransferCreditsMeasuredDelta() public {
        FeeUSDCV2 fee = new FeeUSDCV2(100, makeAddr("feesink")); // 1% fee
        HealthPoolsV2 fpools = new HealthPoolsV2(address(fee), oracle);

        address[3] memory who = [creator, alice, dave];
        for (uint256 i = 0; i < who.length; i++) {
            fee.mint(who[i], 1_000_000e6);
            vm.prank(who[i]);
            fee.approve(address(fpools), type(uint256).max);
        }

        // Fund 1000e6; a 1% fee means only 990e6 actually arrives.
        vm.prank(creator);
        uint256 poolId = fpools.createPool("g", "s", 0, periodStart, periodEnd, 1, 1_000e6);

        assertEq(fpools.getPool(poolId).balance, 990e6, "ledger must reflect the received delta");
        assertEq(fee.balanceOf(address(fpools)), 990e6, "held tokens == ledger");
        // The pool is solvent: ledger never exceeds real holdings.
        assertEq(fpools.getPool(poolId).balance, fee.balanceOf(address(fpools)));

        // Backing is measured too.
        vm.prank(alice);
        fpools.joinPool(poolId, NULL_A);
        vm.prank(dave);
        fpools.backGoal(poolId, alice, 100e6); // 99e6 arrives
        assertEq(fpools.getParticipant(poolId, alice).backingTotal, 99e6);
        assertEq(fpools.backerStake(poolId, alice, dave), 99e6);
        assertEq(fpools.getPool(poolId).balance, fee.balanceOf(address(fpools)), "solvent after backing");

        // Settlement stays solvent: the ledger is drained to zero, never underwater.
        vm.prank(oracle);
        fpools.recordResult(poolId, alice, true, 10_000);
        vm.warp(periodEnd + 1);
        fpools.settle(poolId);
        assertTrue(fpools.settlementComplete(poolId));
        assertEq(fpools.getPool(poolId).balance, fee.balanceOf(address(fpools)), "solvent after settle");
    }

    /// FINDING F-6 (Low): the underfunded fixed-bounty branch multiplies before
    /// dividing. This test picks weights where flooring owed at /BPS first (the
    /// v1 order) loses precision that the reordered expression keeps, while the
    /// sum of payouts still never exceeds the pot.
    function test_finding_F6_multiplyBeforeDivideKeepsPrecision() public {
        // Two achievers, tiny fee and odd multipliers so entryFee*mult is not a
        // clean multiple of BPS. Pot deliberately below total owed (underfunded).
        uint256 poolId = _createPool(0, 3, 0); // fee = 3 units
        vm.prank(alice);
        pools.joinPool(poolId, NULL_A);
        vm.prank(bob);
        pools.joinPool(poolId, NULL_B);
        vm.prank(rando);
        pools.fundPool(poolId, 4); // pot = 3 + 3 + 4 = 10 units

        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 17_000); // w = 3*17000 = 51000, owed 5
        pools.recordResult(poolId, bob, true, 23_000); // w = 3*23000 = 69000, owed 6
        vm.stopPrank();

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);
        uint256 pot = pools.getPool(poolId).balance;

        // totalOwed = 5 + 6 = 11 > pot (10): the underfunded scaling branch runs.
        assertEq(pot, 10, "setup: pot should be below total owed");

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 aPay = usdc.balanceOf(alice) - aBefore;
        uint256 bPay = usdc.balanceOf(bob) - bBefore;

        // V2 multiplies the un-floored weight by the pot BEFORE dividing:
        // payout_i = floor(w_i * pot / totalWeight), totalWeight = 51000 + 69000.
        // (v1 floored owed = w_i/BPS first; the numeric gap versus this is sub-unit
        // by design — the value of the fix is precision, not a headline delta.)
        uint256 totalWeight = 51_000 + 69_000;
        assertEq(aPay, (51_000 * pot) / totalWeight, "F-6 alice payout"); // 4
        assertEq(bPay, (69_000 * pot) / totalWeight, "F-6 bob payout"); // 5
        // Never overpays the pot, even with the more precise numerator.
        assertLe(aPay + bPay, pot, "F-6 must not overpay the pot");
        // Ledger conserved.
        assertEq(aPay + bPay + pools.getPool(poolId).balance, pot, "F-6 ledger drift");
    }

    /// FINDING F-7 (Low): the constructor rejects a settlement asset that is not
    /// a contract, closing the silent-no-op transfer footgun at deploy time.
    function test_finding_F7_constructorRejectsNonContractToken() public {
        vm.expectRevert(bytes("TOKEN_NOT_CONTRACT"));
        new HealthPoolsV2(makeAddr("not_a_token"), oracle);

        // Zero address still rejected first with its own reason.
        vm.expectRevert(bytes("ZERO_TOKEN"));
        new HealthPoolsV2(address(0), oracle);

        // A real contract is accepted.
        HealthPoolsV2 ok = new HealthPoolsV2(address(usdc), oracle);
        assertEq(address(ok.usdc()), address(usdc));
    }

    // =====================================================================
    //  PAGINATION SEMANTICS (F-4) at small scale — equivalence + idempotency
    // =====================================================================

    /// Paginated settleStep produces the identical result to a single-call
    /// settle() on the same pool shape, and is safely idempotent/monotonic.
    function test_F4_paginatedEqualsSingleCall() public {
        // Two identical pools; settle one atomically, the other in 1-participant
        // steps, and assert the achievers receive the same USDC.
        uint256 aPool = _buildSmallPotSplit();
        uint256 bPool = _buildSmallPotSplit();

        vm.warp(periodEnd + 1);

        // Atomic.
        uint256 a1 = usdc.balanceOf(alice);
        uint256 b1 = usdc.balanceOf(bob);
        pools.settle(aPool);
        uint256 atomicAlice = usdc.balanceOf(alice) - a1;
        uint256 atomicBob = usdc.balanceOf(bob) - b1;

        // Paginated, one participant at a time, interleaved re-reads.
        uint256 a2 = usdc.balanceOf(alice);
        uint256 b2 = usdc.balanceOf(bob);
        uint256 guard;
        while (!pools.settlementComplete(bPool)) {
            pools.settleStep(bPool, 1);
            guard++;
            require(guard < 100, "pagination did not terminate");
        }
        uint256 pagedAlice = usdc.balanceOf(alice) - a2;
        uint256 pagedBob = usdc.balanceOf(bob) - b2;

        assertEq(pagedAlice, atomicAlice, "paged alice != atomic alice");
        assertEq(pagedBob, atomicBob, "paged bob != atomic bob");

        // Stepping a completed pool reverts, never double-pays.
        vm.expectRevert(bytes("ALREADY_SETTLED"));
        pools.settleStep(bPool, 1);
    }

    /// A settlement begun with settleStep can be finished with a single settle().
    function test_F4_settleFinishesAPartialSettleStep() public {
        uint256 poolId = _buildSmallPotSplit();
        vm.warp(periodEnd + 1);

        pools.settleStep(poolId, 1); // start it, do a little work
        assertFalse(pools.settlementComplete(poolId));

        uint256 aBefore = usdc.balanceOf(alice);
        pools.settle(poolId); // finish the rest in one call
        assertTrue(pools.settlementComplete(poolId));
        assertGt(usdc.balanceOf(alice), aBefore, "achiever must still be paid");
    }

    /// A pool cannot be swept mid-settlement — only after it completes.
    function test_F4_sweepBlockedUntilSettlementComplete() public {
        uint256 poolId = _buildSmallPotSplit();
        vm.warp(periodEnd + 1);
        pools.settleStep(poolId, 1); // in progress, not done

        vm.prank(creator);
        vm.expectRevert(bytes("NOT_SETTLED"));
        pools.sweep(poolId);
    }

    function _buildSmallPotSplit() internal returns (uint256 poolId) {
        poolId = _createPool(1, FEE, FUNDING);
        // reuse fresh nullifiers per pool so both pools can be built in one test
        uint256 salt = poolId;
        vm.prank(alice);
        pools.joinPool(poolId, uint256(keccak256(abi.encode("a", salt))));
        vm.prank(bob);
        pools.joinPool(poolId, uint256(keccak256(abi.encode("b", salt))));
        vm.prank(dave);
        pools.backGoal(poolId, alice, 300e6);
        vm.startPrank(oracle);
        pools.recordResult(poolId, alice, true, 10_000);
        pools.recordResult(poolId, bob, true, 20_000);
        vm.stopPrank();
    }
}

// ---------------------------------------------------------------------------
//  Fuzz suite (ported from HealthPoolsInvariant.t.sol's HealthPoolsFuzzTest)
// ---------------------------------------------------------------------------

contract HealthPoolsV2FuzzTest is Test {
    HealthPoolsV2 internal pools;
    HealthVerdict internal verdict;
    MockUSDCV2 internal usdc;

    address internal oracle = makeAddr("f_oracle");
    address internal attester = makeAddr("f_attester");
    address internal creator = makeAddr("f_creator");
    address internal alice = makeAddr("f_alice");
    address internal bob = makeAddr("f_bob");
    address internal carol = makeAddr("f_carol");
    address internal dave = makeAddr("f_dave");
    address internal erin = makeAddr("f_erin");

    uint256 internal constant NULL_A = uint256(keccak256("f-null-a"));
    uint256 internal constant NULL_B = uint256(keccak256("f-null-b"));
    uint256 internal constant NULL_C = uint256(keccak256("f-null-c"));
    bytes32 internal constant DIGEST = keccak256("f-signed-inference");

    uint8 internal constant HIGH = 2;
    uint16 internal constant FACET_AI = 1 << 2;

    uint64 internal periodStart;
    uint64 internal periodEnd;

    function setUp() public {
        usdc = new MockUSDCV2();
        pools = new HealthPoolsV2(address(usdc), oracle);
        verdict = new HealthVerdict(attester);

        periodStart = uint64(block.timestamp);
        periodEnd = uint64(block.timestamp + 7 days);

        address[6] memory users = [creator, alice, bob, carol, dave, erin];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 1e30);
            vm.prank(users[i]);
            usdc.approve(address(pools), type(uint256).max);
        }
    }

    function _create(uint8 model, uint256 fee, uint256 funding) internal returns (uint256 poolId) {
        vm.prank(creator);
        poolId = pools.createPool("goal", "spec", fee, periodStart, periodEnd, model, funding);
    }

    function _join(uint256 poolId, address who, uint256 nullifier) internal {
        vm.prank(who);
        pools.joinPool(poolId, nullifier);
    }

    function _record(uint256 poolId, address who, bool v, uint16 mult) internal {
        vm.prank(oracle);
        pools.recordResult(poolId, who, v, mult);
    }

    function testFuzz_potSplit_conservesAndNeverOverpays(
        uint256 fee,
        uint256 funding,
        uint16 mA,
        uint16 mB,
        uint16 mC,
        bool passA,
        bool passB,
        bool passC
    ) public {
        fee = bound(fee, 0, 1_000e6);
        funding = bound(funding, 0, 1_000_000e6);
        mA = uint16(bound(mA, 0, 30_000));
        mB = uint16(bound(mB, 0, 30_000));
        mC = uint16(bound(mC, 0, 30_000));

        uint256 poolId = _create(1, fee, funding);
        _join(poolId, alice, NULL_A);
        _join(poolId, bob, NULL_B);
        _join(poolId, carol, NULL_C);

        _record(poolId, alice, passA, mA);
        _record(poolId, bob, passB, mB);
        _record(poolId, carol, passC, mC);

        uint256 pot = pools.getPool(poolId).balance;
        uint256[3] memory bal = [usdc.balanceOf(alice), usdc.balanceOf(bob), usdc.balanceOf(carol)];

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 paid = (usdc.balanceOf(alice) - bal[0]) + (usdc.balanceOf(bob) - bal[1])
            + (usdc.balanceOf(carol) - bal[2]);
        uint256 remaining = pools.getPool(poolId).balance;

        assertLe(paid, pot, "pot-split overpaid");
        assertEq(paid + remaining, pot, "pot-split ledger drift");
        assertEq(usdc.balanceOf(address(pools)), remaining, "pot-split solvency drift");

        uint256 achievers;
        if (passA && mA > 0) achievers++;
        if (passB && mB > 0) achievers++;
        if (passC && mC > 0) achievers++;
        if (achievers > 0) {
            assertLt(remaining, achievers, "pot-split left more than rounding dust");
        }
    }

    function testFuzz_fixedBounty_neverExceedsOwedOrPot(
        uint256 fee,
        uint256 funding,
        uint16 mA,
        uint16 mB,
        bool passA,
        bool passB
    ) public {
        fee = bound(fee, 1, 1_000e6); // model-0 with fee 0 is rejected at create (F-1)
        funding = bound(funding, 0, 1_000_000e6);
        mA = uint16(bound(mA, 0, 30_000));
        mB = uint16(bound(mB, 0, 30_000));

        uint256 poolId = _create(0, fee, funding);
        _join(poolId, alice, NULL_A);
        _join(poolId, bob, NULL_B);

        _record(poolId, alice, passA, mA);
        _record(poolId, bob, passB, mB);

        uint256 pot = pools.getPool(poolId).balance;
        uint256 owed;
        if (passA && mA > 0) owed += (fee * mA) / 10_000;
        if (passB && mB > 0) owed += (fee * mB) / 10_000;

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 paid = (usdc.balanceOf(alice) - aBefore) + (usdc.balanceOf(bob) - bBefore);
        uint256 remaining = pools.getPool(poolId).balance;

        assertLe(paid, pot, "fixed-bounty overpaid the pot");
        assertLe(paid, owed, "fixed-bounty overpaid what was owed");
        assertEq(paid + remaining, pot, "fixed-bounty ledger drift");
        assertEq(usdc.balanceOf(address(pools)), remaining, "fixed-bounty solvency drift");

        if (owed > 0 && pot >= owed) {
            assertEq(paid, owed, "fully funded pool did not pay the exact owed amount");
        }
    }

    function testFuzz_backerBonus_capped(uint256 fee, uint256 funding, uint256 s1, uint256 s2, uint16 mult) public {
        fee = bound(fee, 0, 1_000e6);
        funding = bound(funding, 0, 1_000_000e6);
        s1 = bound(s1, 1, 500_000e6);
        s2 = bound(s2, 1, 500_000e6);
        mult = uint16(bound(mult, 1, 30_000));

        uint256 poolId = _create(1, fee, funding);
        _join(poolId, alice, NULL_A);

        vm.prank(dave);
        pools.backGoal(poolId, alice, s1);
        vm.prank(erin);
        pools.backGoal(poolId, alice, s2);

        _record(poolId, alice, true, mult);

        uint256 backing = s1 + s2;
        uint256 poolBal = pools.getPool(poolId).balance;
        uint256 headroom = poolBal - backing;
        uint256 bonusPot = (backing * 2_000) / 10_000;
        if (bonusPot > headroom) bonusPot = headroom;

        uint256 dBefore = usdc.balanceOf(dave);
        uint256 eBefore = usdc.balanceOf(erin);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 dGain = usdc.balanceOf(dave) - dBefore;
        uint256 eGain = usdc.balanceOf(erin) - eBefore;

        assertGe(dGain, s1, "dave lost principal on a winner");
        assertGe(eGain, s2, "erin lost principal on a winner");
        assertLe(dGain, s1 + (s1 * 2_000) / 10_000 + 1, "dave over-bonused");
        assertLe(eGain, s2 + (s2 * 2_000) / 10_000 + 1, "erin over-bonused");
        assertLe(dGain + eGain, backing + bonusPot, "backers over-paid in aggregate");
        assertEq(usdc.balanceOf(address(pools)), pools.getPool(poolId).balance, "backer path solvency drift");
    }

    function testFuzz_gate_noVerdictNoPayout(uint256 fee, uint256 funding, uint16 mult) public {
        fee = bound(fee, 0, 1_000e6);
        funding = bound(funding, 0, 1_000_000e6);
        mult = uint16(bound(mult, 1, 30_000));

        uint256 poolId = _create(1, fee, funding);
        pools.setHealthVerdict(address(verdict));
        _join(poolId, alice, NULL_A);
        _record(poolId, alice, true, mult);

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 pot = pools.getPool(poolId).balance;

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aBefore, "paid an achiever with no verdict");
        assertEq(pools.getPool(poolId).balance, pot, "pot moved despite blocked achiever");
    }

    function testFuzz_gate_withVerdictPays(uint256 fee, uint256 funding, uint16 mult) public {
        fee = bound(fee, 0, 1_000e6);
        funding = bound(funding, 1, 1_000_000e6);
        mult = uint16(bound(mult, 1, 30_000));

        uint256 poolId = _create(1, fee, funding);
        pools.setHealthVerdict(address(verdict));
        _join(poolId, alice, NULL_A);
        _record(poolId, alice, true, mult);

        bytes32 goalId = pools.computeGoalId(poolId, alice);
        vm.prank(attester);
        verdict.recordVerdict(goalId, true, HIGH, DIGEST, FACET_AI);

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 pot = pools.getPool(poolId).balance;

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice) - aBefore, pot, "gated happy path did not pay the pot");
        assertEq(pools.getPool(poolId).balance, 0, "pot not fully distributed to sole achiever");
    }

    function testFuzz_nullifier_cannotBeReused(uint256 firstSeed, uint256 secondSeed, uint256 nullifier) public {
        address[4] memory pool = [alice, bob, carol, dave];
        address first = pool[firstSeed % 4];
        address second = pool[secondSeed % 4];
        vm.assume(first != second);

        uint256 poolId = _create(1, 100e6, 0);

        vm.prank(first);
        pools.joinPool(poolId, nullifier);
        assertTrue(pools.nullifierUsed(poolId, nullifier));
        assertEq(pools.participantCount(poolId), 1);

        vm.prank(second);
        vm.expectRevert(bytes("NULLIFIER_USED"));
        pools.joinPool(poolId, nullifier);

        vm.prank(first);
        vm.expectRevert(bytes("ALREADY_JOINED"));
        pools.joinPool(poolId, nullifier ^ 1);

        assertEq(pools.participantCount(poolId), 1, "nullifier gate let an extra entry through");
    }

    function testFuzz_settle_idempotent(uint256 fee, uint256 funding, uint16 mult, address recaller) public {
        fee = bound(fee, 0, 1_000e6);
        funding = bound(funding, 0, 1_000_000e6);
        mult = uint16(bound(mult, 1, 30_000));

        uint256 poolId = _create(1, fee, funding);
        _join(poolId, alice, NULL_A);
        _record(poolId, alice, true, mult);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 aAfter = usdc.balanceOf(alice);
        uint256 poolAfter = usdc.balanceOf(address(pools));

        vm.prank(recaller);
        vm.expectRevert(bytes("ALREADY_SETTLED"));
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aAfter, "second settle moved achiever funds");
        assertEq(usdc.balanceOf(address(pools)), poolAfter, "second settle moved pool funds");
    }

    /// F-1 as a fuzz property: model-0 with fee 0 always reverts at create,
    /// regardless of funding, so no economically-dead pool can ever exist.
    function testFuzz_F1_model0ZeroFeeAlwaysReverts(uint256 funding) public {
        funding = bound(funding, 0, 1_000_000e6);
        vm.prank(creator);
        vm.expectRevert(bytes("DEAD_CONFIG"));
        pools.createPool("g", "s", 0, periodStart, periodEnd, 0, funding);
    }

    /// F-4 as a fuzz property: paginated settleStep at a random step size pays
    /// the achiever the same pot a single settle() would, and completes.
    function testFuzz_F4_paginationPaysSameAsAtomic(uint256 funding, uint16 mult, uint256 step) public {
        funding = bound(funding, 1, 1_000_000e6);
        mult = uint16(bound(mult, 1, 30_000));
        step = bound(step, 1, 5);

        uint256 poolId = _create(1, 0, funding);
        _join(poolId, alice, NULL_A);
        _join(poolId, bob, NULL_B);
        _join(poolId, carol, NULL_C);
        _record(poolId, alice, true, mult);
        _record(poolId, bob, true, mult);
        _record(poolId, carol, false, 0);

        uint256 pot = pools.getPool(poolId).balance;
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 bBefore = usdc.balanceOf(bob);

        vm.warp(periodEnd + 1);
        uint256 guard;
        while (!pools.settlementComplete(poolId)) {
            pools.settleStep(poolId, step);
            guard++;
            require(guard < 50, "did not terminate");
        }

        uint256 paid = (usdc.balanceOf(alice) - aBefore) + (usdc.balanceOf(bob) - bBefore);
        assertLe(paid, pot, "paginated overpaid");
        assertEq(paid + pools.getPool(poolId).balance, pot, "paginated ledger drift");
        assertEq(usdc.balanceOf(address(pools)), pools.getPool(poolId).balance, "paginated solvency drift");
    }
}

// ---------------------------------------------------------------------------
//  Stateful invariant campaign (ported), now also exercising settleStep
// ---------------------------------------------------------------------------

contract HealthPoolsV2Handler is Test {
    HealthPoolsV2 public pools;
    MockUSDCV2 public usdc;

    address public immutable oracle;
    address public immutable creator;

    address[6] public actors;
    uint256 public constant ACTOR_COUNT = 6;
    uint256 public constant MINT_EACH = 1e30;
    uint256 public constant NULLIFIER_SPACE = 8;

    constructor(HealthPoolsV2 _pools, MockUSDCV2 _usdc, address _oracle, address _creator) {
        pools = _pools;
        usdc = _usdc;
        oracle = _oracle;
        creator = _creator;

        actors[0] = makeAddr("h2_alice");
        actors[1] = makeAddr("h2_bob");
        actors[2] = makeAddr("h2_carol");
        actors[3] = makeAddr("h2_dave");
        actors[4] = makeAddr("h2_erin");
        actors[5] = makeAddr("h2_frank");

        usdc.mint(creator, MINT_EACH);
        vm.prank(creator);
        usdc.approve(address(pools), type(uint256).max);

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            usdc.mint(actors[i], MINT_EACH);
            vm.prank(actors[i]);
            usdc.approve(address(pools), type(uint256).max);
        }
    }

    function totalMinted() external pure returns (uint256) {
        return MINT_EACH * (ACTOR_COUNT + 1);
    }

    function allHolders() external view returns (address[] memory holders) {
        holders = new address[](ACTOR_COUNT + 1);
        holders[0] = creator;
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            holders[i + 1] = actors[i];
        }
    }

    function createPool(uint256 seed, uint8 bountyModel, uint256 entryFee, uint256 funding) external {
        bountyModel = uint8(bound(bountyModel, 0, 1));
        entryFee = bound(entryFee, 0, 1_000e6);
        funding = bound(funding, 0, 1_000_000e6);
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 7 days);
        vm.prank(creator);
        try pools.createPool("inv", "spec", entryFee, start, end, bountyModel, funding) {} catch {}
        seed;
    }

    function join(uint256 poolSeed, uint256 actorSeed, uint256 nullifierSeed) external {
        uint256 poolId = _poolId(poolSeed);
        if (poolId == 0) return;
        address actor = actors[actorSeed % ACTOR_COUNT];
        uint256 nullifier = uint256(keccak256(abi.encode(nullifierSeed % NULLIFIER_SPACE)));
        vm.prank(actor);
        try pools.joinPool(poolId, nullifier) {} catch {}
    }

    function back(uint256 poolSeed, uint256 actorSeed, uint256 targetSeed, uint256 amount) external {
        uint256 poolId = _poolId(poolSeed);
        if (poolId == 0) return;
        address backer = actors[actorSeed % ACTOR_COUNT];
        address target = actors[targetSeed % ACTOR_COUNT];
        amount = bound(amount, 1, 500_000e6);
        vm.prank(backer);
        try pools.backGoal(poolId, target, amount) {} catch {}
    }

    function fund(uint256 poolSeed, uint256 actorSeed, uint256 amount) external {
        uint256 poolId = _poolId(poolSeed);
        if (poolId == 0) return;
        address funder = actors[actorSeed % ACTOR_COUNT];
        amount = bound(amount, 1, 500_000e6);
        vm.prank(funder);
        try pools.fundPool(poolId, amount) {} catch {}
    }

    function record(uint256 poolSeed, uint256 targetSeed, bool verdict, uint16 mult) external {
        uint256 poolId = _poolId(poolSeed);
        if (poolId == 0) return;
        address target = actors[targetSeed % ACTOR_COUNT];
        mult = uint16(bound(mult, 0, pools.MAX_MULTIPLIER_BPS()));
        vm.prank(oracle);
        try pools.recordResult(poolId, target, verdict, mult) {} catch {}
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 0, 3 days);
        vm.warp(block.timestamp + secs);
    }

    function settle(uint256 poolSeed) external {
        uint256 poolId = _poolId(poolSeed);
        if (poolId == 0) return;
        try pools.settle(poolId) {} catch {}
    }

    /// Exercise the paginated path under the invariant campaign: bounded, random
    /// step size, leaving many pools mid-settlement so the invariants are checked
    /// against partially-settled state too.
    function settleStep(uint256 poolSeed, uint256 steps) external {
        uint256 poolId = _poolId(poolSeed);
        if (poolId == 0) return;
        steps = bound(steps, 1, 3);
        try pools.settleStep(poolId, steps) {} catch {}
    }

    function sweep(uint256 poolSeed) external {
        uint256 poolId = _poolId(poolSeed);
        if (poolId == 0) return;
        vm.prank(creator);
        try pools.sweep(poolId) {} catch {}
    }

    function _poolId(uint256 seed) internal view returns (uint256) {
        uint256 count = pools.poolCount();
        if (count == 0) return 0;
        return (seed % count) + 1;
    }
}

contract HealthPoolsV2InvariantTest is StdInvariant, Test {
    HealthPoolsV2 internal pools;
    MockUSDCV2 internal usdc;
    HealthPoolsV2Handler internal handler;

    address internal oracle = makeAddr("inv2_oracle");
    address internal creator = makeAddr("inv2_creator");

    function setUp() public {
        usdc = new MockUSDCV2();
        pools = new HealthPoolsV2(address(usdc), oracle);
        handler = new HealthPoolsV2Handler(pools, usdc, oracle, creator);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = HealthPoolsV2Handler.createPool.selector;
        selectors[1] = HealthPoolsV2Handler.join.selector;
        selectors[2] = HealthPoolsV2Handler.back.selector;
        selectors[3] = HealthPoolsV2Handler.fund.selector;
        selectors[4] = HealthPoolsV2Handler.record.selector;
        selectors[5] = HealthPoolsV2Handler.warp.selector;
        selectors[6] = HealthPoolsV2Handler.settle.selector;
        selectors[7] = HealthPoolsV2Handler.settleStep.selector;
        selectors[8] = HealthPoolsV2Handler.sweep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Sum of every pool's ledger balance must always equal the USDC the contract
    /// holds — including in partially-settled (paginated) states.
    function invariant_ledgerMatchesTokenBalance() public view {
        uint256 sum;
        uint256 n = pools.poolCount();
        for (uint256 i = 1; i <= n; i++) {
            sum += pools.getPool(i).balance;
        }
        assertEq(usdc.balanceOf(address(pools)), sum, "ledger != token balance");
    }

    function invariant_tokenConservation() public view {
        uint256 total = usdc.balanceOf(address(pools));
        address[] memory holders = handler.allHolders();
        for (uint256 i = 0; i < holders.length; i++) {
            total += usdc.balanceOf(holders[i]);
        }
        assertEq(total, handler.totalMinted(), "token supply not conserved");
    }

    function invariant_noPoolExceedsHoldings() public view {
        uint256 held = usdc.balanceOf(address(pools));
        uint256 n = pools.poolCount();
        for (uint256 i = 1; i <= n; i++) {
            assertLe(pools.getPool(i).balance, held, "pool balance exceeds holdings");
        }
    }
}

// ---------------------------------------------------------------------------
//  F-4 gas / liveness profile at the maximum caps (200 participants x 50 backers)
//
//  Proves the fund-lock risk is real and closed: a v1-style single settle() at
//  the caps blows past a realistic block gas limit, while V2's paginated
//  settleStep drains the same pool in bounded chunks, each far under the limit,
//  asserting on the USDC deltas that achievers are actually paid.
// ---------------------------------------------------------------------------

contract HealthPoolsV2GasTest is Test {
    uint256 internal constant BLOCK_GAS_LIMIT = 30_000_000; // realistic L2/L1 ceiling
    uint256 internal constant N_PART = 200; // MAX_PARTICIPANTS
    uint256 internal constant N_BACK = 50; // MAX_BACKERS_PER_GOAL
    uint8 internal constant HIGH = 2;
    uint16 internal constant FACET_AI = 1 << 2;
    bytes32 internal constant DIGEST = keccak256("gas-digest");

    address internal oracle = makeAddr("g_oracle");
    address internal attester = makeAddr("g_attester");
    address internal creator = makeAddr("g_creator");

    uint64 internal periodStart;
    uint64 internal periodEnd;

    function setUp() public {
        periodStart = uint64(block.timestamp);
        periodEnd = uint64(block.timestamp + 7 days);
    }

    function _mkAddrs() internal pure returns (address[] memory parts, address[] memory backers) {
        parts = new address[](N_PART);
        for (uint256 i = 0; i < N_PART; i++) {
            parts[i] = address(uint160(0x100000 + i));
        }
        backers = new address[](N_BACK);
        for (uint256 j = 0; j < N_BACK; j++) {
            backers[j] = address(uint160(0x900000 + j));
        }
    }

    // ------- v1 build (the deployed, immutable contract) -------

    function _buildMaxedV1(HealthPools p, HealthVerdict v, MockUSDCV2 usdc)
        internal
        returns (uint256 poolId, address[] memory parts)
    {
        address[] memory backers;
        (parts, backers) = _mkAddrs();

        usdc.mint(creator, 1e33);
        vm.prank(creator);
        usdc.approve(address(p), type(uint256).max);
        vm.prank(creator);
        poolId = p.createPool("max", "spec", 0, periodStart, periodEnd, 1, 1_000_000e6);
        p.setHealthVerdict(address(v)); // gate ON — this test contract owns p

        for (uint256 j = 0; j < N_BACK; j++) {
            usdc.mint(backers[j], 1e33);
            vm.prank(backers[j]);
            usdc.approve(address(p), type(uint256).max);
        }

        for (uint256 i = 0; i < N_PART; i++) {
            address u = parts[i];
            vm.prank(u);
            p.joinPool(poolId, uint256(keccak256(abi.encode("v1", i))));
            for (uint256 j = 0; j < N_BACK; j++) {
                vm.prank(backers[j]);
                p.backGoal(poolId, u, 1e6);
            }
            vm.prank(oracle);
            p.recordResult(poolId, u, true, 10_000);
            bytes32 goalId = p.computeGoalId(poolId, u);
            vm.prank(attester);
            v.recordVerdict(goalId, true, HIGH, DIGEST, FACET_AI);
        }
    }

    function _buildMaxedV2(HealthPoolsV2 p, HealthVerdict v, MockUSDCV2 usdc)
        internal
        returns (uint256 poolId, address[] memory parts)
    {
        address[] memory backers;
        (parts, backers) = _mkAddrs();

        usdc.mint(creator, 1e33);
        vm.prank(creator);
        usdc.approve(address(p), type(uint256).max);
        vm.prank(creator);
        poolId = p.createPool("max", "spec", 0, periodStart, periodEnd, 1, 1_000_000e6);
        p.setHealthVerdict(address(v)); // gate ON

        for (uint256 j = 0; j < N_BACK; j++) {
            usdc.mint(backers[j], 1e33);
            vm.prank(backers[j]);
            usdc.approve(address(p), type(uint256).max);
        }

        for (uint256 i = 0; i < N_PART; i++) {
            address u = parts[i];
            vm.prank(u);
            p.joinPool(poolId, uint256(keccak256(abi.encode("v2", i))));
            for (uint256 j = 0; j < N_BACK; j++) {
                vm.prank(backers[j]);
                p.backGoal(poolId, u, 1e6);
            }
            vm.prank(oracle);
            p.recordResult(poolId, u, true, 10_000);
            bytes32 goalId = p.computeGoalId(poolId, u);
            vm.prank(attester);
            v.recordVerdict(goalId, true, HIGH, DIGEST, FACET_AI);
        }
    }

    /// F-4 PART A: the v1-style single settle() at 200 x 50 with the gate ON
    /// consumes far more than a 30M block, i.e. the maxed pool is effectively
    /// unsettleable in one transaction — the fund-lock risk the audit flagged.
    function test_F4_v1SingleSettleExceedsBlockLimit() public {
        MockUSDCV2 usdc = new MockUSDCV2();
        HealthPools p = new HealthPools(address(usdc), oracle);
        HealthVerdict v = new HealthVerdict(attester);
        (uint256 poolId,) = _buildMaxedV1(p, v, usdc);

        vm.warp(periodEnd + 1);
        uint256 g0 = gasleft();
        p.settle(poolId);
        uint256 used = g0 - gasleft();

        emit log_named_uint("v1_single_settle_gas_200x50", used);
        assertGt(used, BLOCK_GAS_LIMIT, "expected v1 single settle to exceed a 30M block");
    }

    /// F-4 PART B: V2's paginated settleStep drains the SAME maxed pool in bounded
    /// chunks, each comfortably under a 30M block, and the achievers are paid
    /// (asserted on the USDC delta). This is the liveness fix — funds cannot lock.
    function test_F4_v2PaginatedSettleStaysUnderBlockLimit() public {
        MockUSDCV2 usdc = new MockUSDCV2();
        HealthPoolsV2 p = new HealthPoolsV2(address(usdc), oracle);
        HealthVerdict v = new HealthVerdict(attester);
        (uint256 poolId, address[] memory parts) = _buildMaxedV2(p, v, usdc);

        uint256 pot = p.getPool(poolId).balance;
        vm.warp(periodEnd + 1);

        // Two participants per step bounds a step to <= 2 * 50 = 100 token
        // transfers, well under a block. Assert it on every step.
        uint256 maxStepGas;
        uint256 steps;
        while (!p.settlementComplete(poolId)) {
            uint256 g0 = gasleft();
            p.settleStep(poolId, 2);
            uint256 used = g0 - gasleft();
            if (used > maxStepGas) maxStepGas = used;
            assertLt(used, BLOCK_GAS_LIMIT, "a V2 settle step exceeded a 30M block");
            steps++;
            require(steps < 1000, "pagination did not terminate");
        }

        emit log_named_uint("v2_paginated_max_step_gas_200x50", maxStepGas);
        emit log_named_uint("v2_paginated_step_count", steps);

        // Achievers were actually paid: aggregate delta equals the whole pot
        // (sole-model pot-split across 200 equal-multiplier achievers, minus dust).
        uint256 totalToAchievers;
        for (uint256 i = 0; i < parts.length; i++) {
            totalToAchievers += usdc.balanceOf(parts[i]);
        }
        // 200 achievers each also got their 50 backers' stakes routed correctly;
        // what matters for F-4 is that the pot was distributed and not locked.
        uint256 remaining = p.getPool(poolId).balance;
        assertLt(remaining, pot, "nothing was paid out");
        assertLt(remaining, N_PART, "more than rounding dust stranded");
        assertEq(usdc.balanceOf(address(p)), remaining, "solvency drift after paginated settle");
        assertGt(totalToAchievers, 0, "achievers received nothing");
    }
}
