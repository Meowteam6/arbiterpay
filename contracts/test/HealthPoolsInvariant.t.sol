// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {HealthPools} from "../src/HealthPools.sol";
import {HealthVerdict} from "../src/HealthVerdict.sol";

/// @dev 6-decimal USDC stand-in (named distinctly from the mocks in the other
///      suites to avoid a duplicate-symbol clash at compile time). Standard,
///      non-fee-on-transfer, non-rebasing ERC-20 semantics — the same assumption
///      HealthPools accounting makes about Arc-testnet USDC.
contract MockUSDCI {
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

/// @notice Stateful handler that drives HealthPools through random but valid-ish
///         lifecycles (create -> join -> back/fund -> record -> warp -> settle ->
///         sweep). Reverting calls are tolerated (fail_on_revert = false); the
///         invariants below must hold in every reachable state regardless of
///         which individual actions succeeded.
contract Handler is Test {
    HealthPools public pools;
    MockUSDCI public usdc;

    address public immutable oracle;
    address public immutable creator;

    address[6] public actors; // participants + backers
    uint256 public constant ACTOR_COUNT = 6;
    uint256 public constant MINT_EACH = 1e30;

    // A small nullifier alphabet so collisions actually happen and exercise the
    // one-wallet-one-entry gate under fuzzing.
    uint256 public constant NULLIFIER_SPACE = 8;

    constructor(HealthPools _pools, MockUSDCI _usdc, address _oracle, address _creator) {
        pools = _pools;
        usdc = _usdc;
        oracle = _oracle;
        creator = _creator;

        actors[0] = makeAddr("h_alice");
        actors[1] = makeAddr("h_bob");
        actors[2] = makeAddr("h_carol");
        actors[3] = makeAddr("h_dave");
        actors[4] = makeAddr("h_erin");
        actors[5] = makeAddr("h_frank");

        // creator is funded/approved too so it can seed pools and sweep.
        usdc.mint(creator, MINT_EACH);
        vm.prank(creator);
        usdc.approve(address(pools), type(uint256).max);

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            usdc.mint(actors[i], MINT_EACH);
            vm.prank(actors[i]);
            usdc.approve(address(pools), type(uint256).max);
        }
    }

    // ------------------------------------------------------- token accounting

    /// Total USDC that exists across every address that can ever hold it. Used by
    /// the conservation invariant. creator + 6 actors were each minted MINT_EACH;
    /// nothing else is ever minted, so this sum is a fixed constant.
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

    // --------------------------------------------------------------- actions

    function createPool(uint256 seed, uint8 bountyModel, uint256 entryFee, uint256 funding) external {
        bountyModel = uint8(bound(bountyModel, 0, 1));
        entryFee = bound(entryFee, 0, 1_000e6);
        funding = bound(funding, 0, 1_000_000e6);
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 7 days);
        vm.prank(creator);
        try pools.createPool("inv", "spec", entryFee, start, end, bountyModel, funding) {} catch {}
        seed; // silence unused
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
        // permissionless: any actor may settle
        try pools.settle(poolId) {} catch {}
    }

    function sweep(uint256 poolSeed) external {
        uint256 poolId = _poolId(poolSeed);
        if (poolId == 0) return;
        vm.prank(creator);
        try pools.sweep(poolId) {} catch {}
    }

    // --------------------------------------------------------------- helpers

    function _poolId(uint256 seed) internal view returns (uint256) {
        uint256 count = pools.poolCount();
        if (count == 0) return 0;
        return (seed % count) + 1;
    }
}

/// @notice Stateful invariant campaign. The two properties below are the
///         solvency backbone of the whole contract: it can never owe more USDC
///         than it holds, and no USDC is ever conjured or destroyed.
contract HealthPoolsInvariantTest is StdInvariant, Test {
    HealthPools internal pools;
    HealthVerdict internal verdict;
    MockUSDCI internal usdc;
    Handler internal handler;

    address internal oracle = makeAddr("inv_oracle");
    address internal attester = makeAddr("inv_attester");
    address internal creator = makeAddr("inv_creator");

    function setUp() public {
        usdc = new MockUSDCI();
        pools = new HealthPools(address(usdc), oracle);
        verdict = new HealthVerdict(attester);
        handler = new Handler(pools, usdc, oracle, creator);

        // Restrict the fuzzer to the handler's lifecycle actions only.
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = Handler.createPool.selector;
        selectors[1] = Handler.join.selector;
        selectors[2] = Handler.back.selector;
        selectors[3] = Handler.fund.selector;
        selectors[4] = Handler.record.selector;
        selectors[5] = Handler.warp.selector;
        selectors[6] = Handler.settle.selector;
        selectors[7] = Handler.sweep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// The contract's own per-pool `balance` ledger must always sum to exactly
    /// the USDC it actually holds. Any drift means a payout path desynced the
    /// ledger from reality — the class of bug that lets a pool pay out more than
    /// it holds, or strand funds it no longer accounts for.
    function invariant_ledgerMatchesTokenBalance() public view {
        uint256 sum;
        uint256 n = pools.poolCount();
        for (uint256 i = 1; i <= n; i++) {
            sum += pools.getPool(i).balance;
        }
        assertEq(usdc.balanceOf(address(pools)), sum, "ledger != token balance");
    }

    /// No USDC is created or destroyed: every token minted at setup lives either
    /// with a holder or inside the pool contract. Catches double-payment (which
    /// would require minting) and value leakage.
    function invariant_tokenConservation() public view {
        uint256 total = usdc.balanceOf(address(pools));
        address[] memory holders = handler.allHolders();
        for (uint256 i = 0; i < holders.length; i++) {
            total += usdc.balanceOf(holders[i]);
        }
        assertEq(total, handler.totalMinted(), "token supply not conserved");
    }

    /// No single pool can ever claim more balance than the contract holds.
    function invariant_noPoolExceedsHoldings() public view {
        uint256 held = usdc.balanceOf(address(pools));
        uint256 n = pools.poolCount();
        for (uint256 i = 1; i <= n; i++) {
            assertLe(pools.getPool(i).balance, held, "pool balance exceeds holdings");
        }
    }
}

/// @notice Stateless property tests. Every assertion is on a USDC balance DELTA
///         and on the pool-balance conservation identity, never on transaction
///         success. Each targets one economic/safety invariant from the audit
///         checklist.
contract HealthPoolsFuzzTest is Test {
    HealthPools internal pools;
    HealthVerdict internal verdict;
    MockUSDCI internal usdc;

    address internal oracle = makeAddr("f_oracle");
    address internal attester = makeAddr("f_attester");
    address internal creator = makeAddr("f_creator");
    address internal alice = makeAddr("f_alice");
    address internal bob = makeAddr("f_bob");
    address internal carol = makeAddr("f_carol");
    address internal dave = makeAddr("f_dave"); // backer
    address internal erin = makeAddr("f_erin"); // backer

    uint256 internal constant NULL_A = uint256(keccak256("f-null-a"));
    uint256 internal constant NULL_B = uint256(keccak256("f-null-b"));
    uint256 internal constant NULL_C = uint256(keccak256("f-null-c"));
    bytes32 internal constant DIGEST = keccak256("f-signed-inference");

    uint8 internal constant HIGH = 2;
    uint16 internal constant FACET_AI = 1 << 2;

    uint64 internal periodStart;
    uint64 internal periodEnd;

    function setUp() public {
        usdc = new MockUSDCI();
        pools = new HealthPools(address(usdc), oracle);
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

    // ------------------------------------------------------------- helpers

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

    // ---------------------------------------------------- pot-split (model 1)

    /// Pot-split settlement must (a) never pay achievers more than the pool
    /// holds, (b) conserve the ledger (paid + remaining == pot), and (c) leave
    /// only sub-unit rounding dust — strictly less than one unit per achiever.
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
        uint256[3] memory before = [usdc.balanceOf(alice), usdc.balanceOf(bob), usdc.balanceOf(carol)];

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 paid = (usdc.balanceOf(alice) - before[0]) + (usdc.balanceOf(bob) - before[1])
            + (usdc.balanceOf(carol) - before[2]);
        uint256 remaining = pools.getPool(poolId).balance;

        // (a) never pays out more than it held
        assertLe(paid, pot, "pot-split overpaid");
        // (b) ledger conservation: nothing vanished
        assertEq(paid + remaining, pot, "pot-split ledger drift");
        // (b') on-chain ledger matches real token holdings
        assertEq(usdc.balanceOf(address(pools)), remaining, "pot-split solvency drift");

        // (c) if anyone qualified, dust is bounded by the achiever count
        uint256 achievers;
        if (passA && mA > 0) achievers++;
        if (passB && mB > 0) achievers++;
        if (passC && mC > 0) achievers++;
        if (achievers > 0) {
            assertLt(remaining, achievers, "pot-split left more than rounding dust");
        }
    }

    // --------------------------------------------------- fixed bounty (model 0)

    /// Fixed-bounty settlement: each achiever is owed entryFee*mult/BPS. Total
    /// paid must never exceed the smaller of that owed sum and the pot, and when
    /// the pool fully covers the owed sum it must pay it exactly.
    function testFuzz_fixedBounty_neverExceedsOwedOrPot(
        uint256 fee,
        uint256 funding,
        uint16 mA,
        uint16 mB,
        bool passA,
        bool passB
    ) public {
        fee = bound(fee, 1, 1_000e6); // model-0 with fee 0 is the known zero-payout footgun, pinned separately
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

        // Fully funded: owed is paid exactly (no scaling, no shortfall).
        if (owed > 0 && pot >= owed) {
            assertEq(paid, owed, "fully funded pool did not pay the exact owed amount");
        }
    }

    // ----------------------------------------------------------- backer bonus

    /// A backer of an achiever gets their stake back plus at most a 20% bonus,
    /// never more; total backer payout never exceeds stakes + the affordable
    /// bonus pot; and the backer never loses principal when their pick wins.
    function testFuzz_backerBonus_capped(uint256 fee, uint256 funding, uint256 s1, uint256 s2, uint16 mult)
        public
    {
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

        _record(poolId, alice, true, mult); // alice wins -> her backers are paid

        uint256 backing = s1 + s2;
        uint256 poolBal = pools.getPool(poolId).balance;
        uint256 headroom = poolBal - backing; // safe: stakes are part of balance
        uint256 bonusPot = (backing * 2_000) / 10_000;
        if (bonusPot > headroom) bonusPot = headroom;

        uint256 dBefore = usdc.balanceOf(dave);
        uint256 eBefore = usdc.balanceOf(erin);

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        uint256 dGain = usdc.balanceOf(dave) - dBefore;
        uint256 eGain = usdc.balanceOf(erin) - eBefore;

        // Principal is never lost on a winning pick.
        assertGe(dGain, s1, "dave lost principal on a winner");
        assertGe(eGain, s2, "erin lost principal on a winner");
        // Bonus per backer never exceeds 20% (+1 wei rounding tolerance).
        assertLe(dGain, s1 + (s1 * 2_000) / 10_000 + 1, "dave over-bonused");
        assertLe(eGain, s2 + (s2 * 2_000) / 10_000 + 1, "erin over-bonused");
        // Aggregate backer payout never exceeds stakes + affordable bonus.
        assertLe(dGain + eGain, backing + bonusPot, "backers over-paid in aggregate");
        // Solvency preserved.
        assertEq(usdc.balanceOf(address(pools)), pools.getPool(poolId).balance, "backer path solvency drift");
    }

    // --------------------------------------------------------- verdict gate

    /// With the registry configured and NO verdict recorded, an oracle-passed
    /// achiever is paid nothing, no matter how the pool is funded. Gate holds:
    /// no verdict -> no payout.
    function testFuzz_gate_noVerdictNoPayout(uint256 fee, uint256 funding, uint16 mult) public {
        fee = bound(fee, 0, 1_000e6);
        funding = bound(funding, 0, 1_000_000e6);
        mult = uint16(bound(mult, 1, 30_000));

        uint256 poolId = _create(1, fee, funding);
        pools.setHealthVerdict(address(verdict)); // gate ON, test contract is owner
        _join(poolId, alice, NULL_A);
        _record(poolId, alice, true, mult); // oracle passes...
        // ...but no verdict recorded in the registry

        uint256 aBefore = usdc.balanceOf(alice);
        uint256 pot = pools.getPool(poolId).balance;

        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        assertEq(usdc.balanceOf(alice), aBefore, "paid an achiever with no verdict");
        assertEq(pools.getPool(poolId).balance, pot, "pot moved despite blocked achiever");
    }

    /// Same setup but WITH a passing high-confidence verdict: the achiever is now
    /// paid the whole pot (sole achiever, pot-split). Confirms the gate is a
    /// precise AND, not a blanket block.
    function testFuzz_gate_withVerdictPays(uint256 fee, uint256 funding, uint16 mult) public {
        fee = bound(fee, 0, 1_000e6);
        funding = bound(funding, 1, 1_000_000e6); // ensure a non-empty pot to observe payment
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

    // ------------------------------------------------ one-wallet-one-entry

    /// The World-ID nullifier gate is unbypassable: a second wallet presenting an
    /// already-used nullifier reverts, and a wallet cannot join the same pool
    /// twice. Fuzzed over which two distinct actors collide.
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

        // second human, same nullifier -> rejected
        vm.prank(second);
        vm.expectRevert(bytes("NULLIFIER_USED"));
        pools.joinPool(poolId, nullifier);

        // first wallet again, a distinct unused nullifier (XOR of the low bit can
        // never overflow and is always != nullifier) -> still rejected because
        // the wallet already joined. Note joinPool checks NULLIFIER_USED before
        // ALREADY_JOINED, so the fresh nullifier is required to reach this branch.
        vm.prank(first);
        vm.expectRevert(bytes("ALREADY_JOINED"));
        pools.joinPool(poolId, nullifier ^ 1);

        assertEq(pools.participantCount(poolId), 1, "nullifier gate let an extra entry through");
    }

    // --------------------------------------------------------- idempotency

    /// settle() is one-shot. A second settle reverts and moves no USDC, so a
    /// permissionless re-call can never double-pay.
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

    // ------------------------------------- FINDING PIN: model-0 zero-fee footgun

    /// FINDING (see AUDIT-READINESS.md, F-1): a fixed-bounty (model 0) pool with
    /// entryFee == 0 owes entryFee*mult/BPS == 0 to every achiever, so a fully
    /// funded pool pays achievers NOTHING and the entire balance is strandable to
    /// the creator's sweep. This is the exact production defect from SPEC.md
    /// (three of five live pools). Pinned here as an assertion so the misbehavior
    /// is documented and regression-caught without failing the suite.
    function test_finding_fixedBountyZeroFeeStrandsFunding() public {
        uint256 funding = 1_000e6;
        uint256 poolId = _create(0, 0, funding); // model 0, entryFee 0, real money in
        _join(poolId, alice, NULL_A);
        _record(poolId, alice, true, 30_000); // alice is a bona-fide 3x achiever

        uint256 aBefore = usdc.balanceOf(alice);
        vm.warp(periodEnd + 1);
        pools.settle(poolId);

        // Bug surface: a real achiever in a funded pool is paid zero.
        assertEq(usdc.balanceOf(alice) - aBefore, 0, "expected the zero-payout defect");
        // The funding is fully stranded and only the creator can reclaim it.
        assertEq(pools.getPool(poolId).balance, funding, "funding should be stranded to sweep");

        uint256 cBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        pools.sweep(poolId);
        assertEq(usdc.balanceOf(creator) - cBefore, funding, "creator reclaims stranded pot");
    }
}
