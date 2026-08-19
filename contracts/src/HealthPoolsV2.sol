// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================================
//  HealthPoolsV2 — AUDIT REMEDIATION CANDIDATE. UNAUDITED. NOT DEPLOYED.
// ----------------------------------------------------------------------------
//  This file is the remediation candidate for the FUTURE audited redeploy of
//  GoHealthMe's settlement contract. It is NOT the live contract. The deployed,
//  immutable v1 (contracts/src/HealthPools.sol) is untouched.
//
//  It applies ONLY the mechanical, product-neutral fixes for the audit findings
//  in contracts/AUDIT-READINESS.md. Each change is annotated with the finding it
//  closes. The product's economics, trust model, and settlement semantics are
//  otherwise IDENTICAL to v1: for every pool v1 can settle, V2's single-call
//  settle() produces the exact same balances.
//
//  Remediated here (mechanical, non-negotiable safety):
//    F-1  createPool rejects the economically-dead config (model 0 + fee 0).
//    F-4  settle() is liveness-safe at MAX_PARTICIPANTS x MAX_BACKERS via an
//         idempotent, paginated settleStep(); single-call settle() still works.
//    F-5  _pull/_push measure the real USDC balance delta instead of assuming
//         the requested amount transferred exactly.
//    F-6  the underfunded fixed-bounty scaling multiplies before dividing.
//    F-7  the constructor rejects a token address with no code.
//
//  Left EXACTLY as v1 by design (see the DECISION-GATED comments inline):
//    F-2  oracle is fully trusted for pass/fail and multiplier.
//    F-3  settle() is permissionless.
//    F-9  owner privileges (setOracle / setHealthVerdict(0) / overrideVerdict).
//  These are posture calls for the founders and the auditor, not code defects,
//  and are deliberately NOT changed here.
// ============================================================================

/// @dev Minimal ERC-20 surface needed for pool accounting. On Arc testnet the
///      canonical USDC ERC-20 interface lives at
///      0x3600000000000000000000000000000000000000 (6 decimals).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Minimal surface of the optional verdict registry. When configured,
///      HealthPools requires canSettle(goalId) to be true before a participant
///      counts as an achiever. See HealthVerdict.sol.
interface IHealthVerdict {
    function canSettle(bytes32 goalId) external view returns (bool);
}

/// @title HealthPoolsV2
/// @notice Sybil-resistant health-goal bounty pools settled in USDC (GoHealthMe).
///         Remediation candidate for the audited redeploy — see the banner above.
///         Privacy invariant: raw health data never touches the chain — only
///         oracle verdicts and multipliers do. World ID sybil resistance is
///         enforced via one nullifierHash per pool.
///
/// Bounty models:
///   0 = fixed bounty per achiever: each achiever is owed
///       entryFee * multiplierBps / 10000 (scaled down pro-rata if the pool
///       cannot cover everyone). Unspent funds are sweepable by the creator
///       after settlement. entryFee == 0 is rejected at creation (F-1).
///   1 = pot split: achievers split the entire remaining pot pro-rata by
///       multiplierBps. Only rounding dust is left to sweep.
///
/// Backing: anyone can stake USDC behind a participant before that
/// participant's result is recorded. Backers of achievers get their stake back
/// plus a 20% bonus paid from the pool (capped by pool headroom). Backers of
/// failures (or of participants with no recorded result) forfeit their stake
/// into the pool.
contract HealthPoolsV2 {
    // ---------------------------------------------------------------- types

    struct Pool {
        address creator;
        uint8 bountyModel; // 0 = fixed bounty per achiever, 1 = pro-rata pot split
        bool settled; // true once settlement has been initiated (locks the pool)
        uint64 periodStart;
        uint64 periodEnd;
        uint256 entryFee; // USDC (6 decimals)
        uint256 balance; // USDC currently attributable to this pool
        string initiative;
        string goalSpec;
    }

    struct Participant {
        bool joined;
        bool resultRecorded;
        bool verdict;
        uint16 multiplierBps; // 10000 = 1x, hard-capped at 30000 (3x)
        uint256 nullifierHash; // World ID nullifier used to join
        uint256 backingTotal; // total USDC staked behind this participant
    }

    // -------------------------------------------------- settlement phases (F-4)

    /// @dev settle() is a three-phase pipeline. Each phase walks participantList
    ///      once; the phases must run in order because achiever payouts depend on
    ///      the pool balance left after all backer payouts. The phase/cursor pair
    ///      is persisted so a large pool can be settled across several bounded
    ///      transactions (settleStep) rather than one that cannot fit in a block.
    uint8 internal constant PHASE_NONE = 0;
    uint8 internal constant PHASE_TALLY = 1; // classify achievers, aggregate stats
    uint8 internal constant PHASE_BACKERS = 2; // pay backers of achievers
    uint8 internal constant PHASE_ACHIEVERS = 3; // pay achievers from the frozen pot
    uint8 internal constant PHASE_DONE = 4; // fully settled; sweep may proceed

    /// @dev Per-pool settlement progress. All aggregates are computed once in the
    ///      tally phase and reused, so the verdict-gate staticcall (F-4's gas
    ///      driver) runs at most once per participant across the whole settlement.
    struct Settlement {
        uint8 phase;
        uint256 cursor; // next participantList index to process in this phase
        uint256 achieverCount;
        uint256 sumMultiplierBps; // pot-split divisor
        uint256 backingOnAchievers; // total backing staked on achievers
        uint256 totalOwed; // fixed-model: sum of floored oweds (what the pool owes)
        uint256 totalWeight; // fixed-model: sum of entryFee*mult, the F-6 scaling basis
        uint256 bonusPot; // frozen after tally, before any backer is paid
        uint256 potForAchievers; // pool balance snapshotted after all backers paid
        uint256 paidToBackers;
        uint256 paidToAchievers;
    }

    // ------------------------------------------------------------ constants

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_MULTIPLIER_BPS = 30_000; // 3x trailing-baseline cap
    uint256 public constant BACKER_BONUS_BPS = 2_000; // 20% bonus for backers of achievers
    uint256 public constant MAX_PARTICIPANTS = 200; // bounds settle() work
    uint256 public constant MAX_BACKERS_PER_GOAL = 50; // bounds per-participant backer work

    // -------------------------------------------------------------- storage

    IERC20 public immutable usdc;
    address public owner;
    address public oracle;

    /// @notice Optional Chainlink Confidential AI verdict registry. When set to a
    ///         non-zero address, settle() additionally requires a passing verdict
    ///         (canSettle) for each participant to count as an achiever. Default
    ///         address(0) preserves the original oracle-only behavior exactly.
    address public healthVerdict;

    uint256 public poolCount; // pool ids run 1..poolCount
    mapping(uint256 => Pool) internal pools;
    mapping(uint256 => address[]) internal participantList;
    mapping(uint256 => mapping(address => Participant)) internal participants;
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;
    mapping(uint256 => mapping(address => address[])) internal backerList;
    mapping(uint256 => mapping(address => mapping(address => uint256))) public backerStake;

    /// @dev Per-pool settlement state machine (F-4). See Settlement above.
    mapping(uint256 => Settlement) internal settlements;
    /// @dev Achiever classification cached during the tally phase so the backer
    ///      and achiever phases never re-run the verdict-gate staticcall.
    mapping(uint256 => mapping(address => bool)) internal achieverFlag;

    uint256 private _lock = 1;

    // --------------------------------------------------------------- events

    event PoolCreated(
        uint256 indexed poolId,
        address indexed creator,
        string initiative,
        string goalSpec,
        uint256 entryFee,
        uint64 periodStart,
        uint64 periodEnd,
        uint8 bountyModel
    );
    event PoolJoined(uint256 indexed poolId, address indexed participant, uint256 nullifierHash);
    event ResultRecorded(uint256 indexed poolId, address indexed participant, bool verdict, uint16 multiplierBps);
    event GoalBacked(uint256 indexed poolId, address indexed participant, address indexed backer, uint256 amount);
    event PoolFunded(uint256 indexed poolId, address indexed funder, uint256 amount);
    event BackerPaid(uint256 indexed poolId, address indexed backer, address participant, uint256 amount);
    event AchieverPaid(uint256 indexed poolId, address indexed participant, uint256 amount);
    event PoolSettled(uint256 indexed poolId, uint256 achieverCount, uint256 totalPaid);
    /// @dev Emitted each time a bounded settleStep advances the pipeline but has
    ///      not yet completed it. Lets an off-chain settler track progress.
    event SettlementAdvanced(uint256 indexed poolId, uint8 phase, uint256 cursor);
    event FundsSwept(uint256 indexed poolId, address indexed creator, uint256 amount);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event HealthVerdictUpdated(address indexed previousRegistry, address indexed newRegistry);

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "NOT_ORACLE");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "REENTRANCY");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ----------------------------------------------------------- constructor

    /// @param token  ERC-20 used for all pool accounting (Arc testnet USDC in prod,
    ///               a mock in tests).
    /// @param oracle_ signer allowed to call recordResult.
    constructor(address token, address oracle_) {
        require(token != address(0), "ZERO_TOKEN");
        // F-7 (Low): reject a settlement asset that is not a contract. A low-level
        // call to an EOA returns ok==true with empty data, which _pull/_push would
        // read as a successful transfer while no tokens moved. Requiring code at
        // deploy time removes that silent-no-op footgun for good.
        require(token.code.length > 0, "TOKEN_NOT_CONTRACT");
        require(oracle_ != address(0), "ZERO_ORACLE");
        usdc = IERC20(token);
        owner = msg.sender;
        oracle = oracle_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OracleUpdated(address(0), oracle_);
    }

    // ----------------------------------------------------------- pool admin

    // DECISION-GATED (see AUDIT-READINESS.md F-9 / Mainnet-Roadmap): the owner can
    // rotate the oracle, disable the verdict gate via setHealthVerdict(0), and hand
    // ownership over. This is a trusted-owner posture, unchanged from v1. Any move
    // to a timelock/multisig is a founder governance decision, not a code fix.
    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "ZERO_ORACLE");
        emit OracleUpdated(oracle, newOracle);
        oracle = newOracle;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Enable, swap, or disable the verdict-gating registry. Pass
    ///         address(0) to disable and fall back to the oracle-only path.
    // DECISION-GATED (see AUDIT-READINESS.md F-9): the missing zero-address check is
    // intentional — address(0) is the documented "gate off" value, not a bug.
    function setHealthVerdict(address newRegistry) external onlyOwner {
        emit HealthVerdictUpdated(healthVerdict, newRegistry);
        healthVerdict = newRegistry;
    }

    // -------------------------------------------------------------- actions

    /// @notice Permissionless pool creation. Pulls initialFunding USDC from the
    ///         caller (requires prior approval).
    function createPool(
        string calldata initiative,
        string calldata goalSpec,
        uint256 entryFee,
        uint64 periodStart,
        uint64 periodEnd,
        uint8 bountyModel,
        uint256 initialFunding
    ) external nonReentrant returns (uint256 poolId) {
        require(periodEnd > periodStart, "BAD_PERIOD");
        require(periodEnd > block.timestamp, "PERIOD_IN_PAST");
        require(bountyModel <= 1, "BAD_BOUNTY_MODEL");
        // F-1 (High): reject the economically-dead config. A fixed-bounty (model 0)
        // pool with entryFee == 0 owes every achiever entryFee*mult/BPS == 0, so it
        // accepts funding but pays achievers nothing, and the whole pot becomes
        // sweepable by the creator. This is the exact production defect that
        // stranded three of five live pools. A funded pool must be able to pay.
        require(!(bountyModel == 0 && entryFee == 0), "DEAD_CONFIG");

        poolId = ++poolCount;
        Pool storage p = pools[poolId];
        p.creator = msg.sender;
        p.bountyModel = bountyModel;
        p.periodStart = periodStart;
        p.periodEnd = periodEnd;
        p.entryFee = entryFee;
        p.initiative = initiative;
        p.goalSpec = goalSpec;

        if (initialFunding > 0) {
            // F-5: credit only what actually arrived, not the requested amount.
            p.balance = _pull(msg.sender, initialFunding);
        }

        emit PoolCreated(poolId, msg.sender, initiative, goalSpec, entryFee, periodStart, periodEnd, bountyModel);
    }

    /// @notice Join a pool with a World ID nullifier. One nullifier per pool =
    ///         one human per pool. Pulls entryFee USDC from the caller.
    function joinPool(uint256 poolId, uint256 nullifierHash) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        require(!p.settled, "SETTLED");
        require(block.timestamp < p.periodEnd, "PERIOD_ENDED");
        require(!nullifierUsed[poolId][nullifierHash], "NULLIFIER_USED");
        require(!participants[poolId][msg.sender].joined, "ALREADY_JOINED");
        require(participantList[poolId].length < MAX_PARTICIPANTS, "POOL_FULL");

        nullifierUsed[poolId][nullifierHash] = true;
        Participant storage part = participants[poolId][msg.sender];
        part.joined = true;
        part.nullifierHash = nullifierHash;
        participantList[poolId].push(msg.sender);

        if (p.entryFee > 0) {
            // F-5: credit only the measured received amount.
            p.balance += _pull(msg.sender, p.entryFee);
        }

        emit PoolJoined(poolId, msg.sender, nullifierHash);
    }

    /// @notice Oracle posts the verdict for a participant. One shot per
    ///         participant per pool. multiplierBps capped at 3x.
    // DECISION-GATED (see AUDIT-READINESS.md F-2): the oracle is fully trusted for
    // the pass/fail flag and the multiplier (capped at 3x). Partially mitigated when
    // the verdict registry is configured (see _isAchiever). Key custody / gate-on
    // enforcement is an operational posture, not changed here.
    function recordResult(uint256 poolId, address user, bool verdict, uint16 multiplierBps) external onlyOracle {
        Pool storage p = _existingPool(poolId);
        require(!p.settled, "SETTLED");
        require(multiplierBps <= MAX_MULTIPLIER_BPS, "MULTIPLIER_TOO_HIGH");

        Participant storage part = participants[poolId][user];
        require(part.joined, "NOT_PARTICIPANT");
        require(!part.resultRecorded, "ALREADY_RECORDED");

        part.resultRecorded = true;
        part.verdict = verdict;
        part.multiplierBps = multiplierBps;

        emit ResultRecorded(poolId, user, verdict, multiplierBps);
    }

    /// @notice Stake USDC behind a participant. Must happen during the period
    ///         and before that participant's result is recorded (no risk-free
    ///         backing of known achievers).
    function backGoal(uint256 poolId, address user, uint256 amount) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        require(!p.settled, "SETTLED");
        require(block.timestamp < p.periodEnd, "PERIOD_ENDED");
        require(amount > 0, "ZERO_AMOUNT");

        Participant storage part = participants[poolId][user];
        require(part.joined, "NOT_PARTICIPANT");
        require(!part.resultRecorded, "RESULT_KNOWN");

        // F-5: pull first, then credit only what actually arrived, keeping the
        // backer stake, the participant's backing total, and the pool balance all
        // consistent with the real transfer (matters for fee-on-transfer tokens).
        uint256 received = _pull(msg.sender, amount);
        if (backerStake[poolId][user][msg.sender] == 0) {
            require(backerList[poolId][user].length < MAX_BACKERS_PER_GOAL, "TOO_MANY_BACKERS");
            backerList[poolId][user].push(msg.sender);
        }
        backerStake[poolId][user][msg.sender] += received;
        part.backingTotal += received;
        p.balance += received;

        emit GoalBacked(poolId, user, msg.sender, received);
    }

    /// @notice Top up any unsettled pool with USDC.
    function fundPool(uint256 poolId, uint256 amount) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        require(!p.settled, "SETTLED");
        require(amount > 0, "ZERO_AMOUNT");

        // F-5: credit only the measured received amount.
        uint256 received = _pull(msg.sender, amount);
        p.balance += received;

        emit PoolFunded(poolId, msg.sender, received);
    }

    /// @notice Settle a pool after its period ends, in one transaction. Pays
    ///         backers of achievers (stake + up to 20% bonus), then pays achievers
    ///         per the bounty model. Failed participants' entry fees and forfeited
    ///         backing stay in the pool for the creator to sweep.
    ///
    ///         Suitable for normal-sized pools. For a pool large enough that a
    ///         single transaction would exceed the block gas limit, use
    ///         settleStep repeatedly instead (F-4). Both drive the same idempotent
    ///         state machine and cannot double-pay.
    // DECISION-GATED (see AUDIT-READINESS.md F-3 / Mainnet-Roadmap): settlement is
    // permissionless (external, no auth) so a Circle agent wallet can settle with
    // zero Solidity changes. The known front-running/timing tradeoff is deliberate;
    // the authorized-settler + public-grace-fallback redesign is a founder
    // reward-vs-wager / custodial call and is intentionally NOT made here.
    function settle(uint256 poolId) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        _beginOrContinueSettlement(poolId, p);
        _advanceSettlement(poolId, p, type(uint256).max);
    }

    /// @notice Bounded, resumable settlement (F-4). Processes at most `maxSteps`
    ///         participants of the current phase, then persists progress. Call it
    ///         repeatedly until settlementComplete(poolId) is true. Idempotent and
    ///         monotonic: each participant is tallied once, each backer and each
    ///         achiever is paid at most once, and funds can never lock because any
    ///         maxed pool can always be drained in bounded chunks.
    // DECISION-GATED (see AUDIT-READINESS.md F-3): permissionless, same as settle().
    function settleStep(uint256 poolId, uint256 maxSteps) external nonReentrant {
        require(maxSteps > 0, "ZERO_STEPS");
        Pool storage p = _existingPool(poolId);
        _beginOrContinueSettlement(poolId, p);
        _advanceSettlement(poolId, p, maxSteps);
    }

    /// @notice Creator reclaims whatever is left in the pool after settlement
    ///         completes (forfeited fees/backing, unspent funding, rounding dust).
    function sweep(uint256 poolId) external nonReentrant {
        Pool storage p = _existingPool(poolId);
        // Must be fully settled, not merely started — an in-progress settlement
        // still owes achievers, so sweeping mid-pipeline would steal their payout.
        require(settlements[poolId].phase == PHASE_DONE, "NOT_SETTLED");
        require(msg.sender == p.creator, "NOT_CREATOR");

        uint256 amount = p.balance;
        require(amount > 0, "NOTHING_TO_SWEEP");
        p.balance = 0;
        _push(msg.sender, amount);

        emit FundsSwept(poolId, msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    function getPool(uint256 poolId) external view returns (Pool memory) {
        _existingPool(poolId);
        return pools[poolId];
    }

    function getParticipant(uint256 poolId, address user) external view returns (Participant memory) {
        return participants[poolId][user];
    }

    function getParticipants(uint256 poolId) external view returns (address[] memory) {
        return participantList[poolId];
    }

    function participantCount(uint256 poolId) external view returns (uint256) {
        return participantList[poolId].length;
    }

    /// @notice Full settlement progress for a pool (F-4). phase == PHASE_DONE (4)
    ///         means settlement finished and sweep may proceed.
    function getSettlement(uint256 poolId) external view returns (Settlement memory) {
        return settlements[poolId];
    }

    /// @notice True once settlement has fully completed.
    function settlementComplete(uint256 poolId) external view returns (bool) {
        return settlements[poolId].phase == PHASE_DONE;
    }

    /// @notice Backers of a participant's goal with their current stakes.
    function getBackers(uint256 poolId, address user)
        external
        view
        returns (address[] memory backers, uint256[] memory stakes)
    {
        backers = backerList[poolId][user];
        stakes = new uint256[](backers.length);
        for (uint256 i = 0; i < backers.length; i++) {
            stakes[i] = backerStake[poolId][user][backers[i]];
        }
    }

    // ------------------------------------------------------------ internals

    function _existingPool(uint256 poolId) internal view returns (Pool storage p) {
        require(poolId >= 1 && poolId <= poolCount, "NO_POOL");
        p = pools[poolId];
    }

    /// @dev A participant is an achiever iff the oracle recorded a passing
    ///      result AND, when the verdict registry is configured, that registry
    ///      also clears them via canSettle. With healthVerdict == address(0) this
    ///      is identical to the original `resultRecorded && verdict` check, so the
    ///      proven happy path is unchanged.
    // DECISION-GATED (see AUDIT-READINESS.md F-2): trust in the oracle result is
    // intentional; the registry is the additional AND-gate, not a replacement.
    function _isAchiever(uint256 poolId, address user) internal view returns (bool) {
        Participant storage part = participants[poolId][user];
        if (!(part.resultRecorded && part.verdict)) return false;

        address registry = healthVerdict;
        if (registry == address(0)) return true;

        return IHealthVerdict(registry).canSettle(computeGoalId(poolId, user));
    }

    /// @notice Deterministic goal id shared with the off-chain CRE pipeline and
    ///         the HealthVerdict registry. All three must agree on this hash.
    ///
    /// @dev Equivalent to HealthVerdict.computeGoalId(address(this), poolId,
    ///      participant, pool.periodStart). Reading periodStart from storage here
    ///      keeps this contract the single on-chain source of truth for the id.
    function computeGoalId(uint256 poolId, address participant) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), poolId, participant, pools[poolId].periodStart));
    }

    // ------------------------------------------------------- settlement (F-4)

    /// @dev Start settlement on first entry, or continue an in-progress one. The
    ///      period-ended and not-yet-settled checks run once, at initiation; once
    ///      started, p.settled locks the pool against joins/backs/funds/records.
    function _beginOrContinueSettlement(uint256 poolId, Pool storage p) internal {
        Settlement storage s = settlements[poolId];
        if (s.phase == PHASE_NONE) {
            require(block.timestamp > p.periodEnd, "PERIOD_NOT_ENDED");
            require(!p.settled, "ALREADY_SETTLED");
            p.settled = true;
            s.phase = PHASE_TALLY;
        } else {
            require(s.phase != PHASE_DONE, "ALREADY_SETTLED");
        }
    }

    /// @dev Advance the settlement pipeline by at most `budget` participants,
    ///      flowing through phases in order. Passing type(uint256).max runs the
    ///      whole pipeline in one call (the single-transaction settle() path).
    function _advanceSettlement(uint256 poolId, Pool storage p, uint256 budget) internal {
        Settlement storage s = settlements[poolId];
        address[] storage plist = participantList[poolId];
        uint256 n = plist.length;

        // --- Phase 1: tally. Classify achievers once and aggregate every figure
        //     settlement needs, so the verdict-gate staticcall never runs again.
        if (s.phase == PHASE_TALLY) {
            while (s.cursor < n && budget > 0) {
                address user = plist[s.cursor];
                if (_isAchiever(poolId, user)) {
                    achieverFlag[poolId][user] = true;
                    Participant storage part = participants[poolId][user];
                    s.achieverCount++;
                    s.sumMultiplierBps += part.multiplierBps;
                    s.backingOnAchievers += part.backingTotal;
                    uint256 w = p.entryFee * part.multiplierBps; // un-floored weight (F-6)
                    s.totalOwed += w / BPS;
                    s.totalWeight += w;
                }
                s.cursor++;
                budget--;
            }
            if (s.cursor < n) {
                emit SettlementAdvanced(poolId, s.phase, s.cursor);
                return;
            }
            // Tally complete: freeze the backer bonus pot from the full, untouched
            // balance (headroom = balance beyond the staked principal). Identical
            // value to v1's one-shot computation in _payBackers.
            if (s.backingOnAchievers > 0) {
                uint256 bonusPot = (s.backingOnAchievers * BACKER_BONUS_BPS) / BPS;
                uint256 headroom = p.balance - s.backingOnAchievers;
                if (bonusPot > headroom) bonusPot = headroom;
                s.bonusPot = bonusPot;
            }
            s.phase = PHASE_BACKERS;
            s.cursor = 0;
        }

        // --- Phase 2: pay backers of achievers (stake + pro-rata bonus).
        if (s.phase == PHASE_BACKERS) {
            while (s.cursor < n && budget > 0) {
                address user = plist[s.cursor];
                if (s.backingOnAchievers > 0 && achieverFlag[poolId][user]) {
                    s.paidToBackers += _payBackersOf(poolId, p, user, s.bonusPot, s.backingOnAchievers);
                }
                s.cursor++;
                budget--;
            }
            if (s.cursor < n) {
                emit SettlementAdvanced(poolId, s.phase, s.cursor);
                return;
            }
            // Freeze the achiever pot AFTER all backers are paid — this is exactly
            // v1's `pot = p.balance` at the top of _payAchievers, so pot-split and
            // underfunded scaling see the same denominator regardless of paging.
            s.potForAchievers = p.balance;
            s.phase = PHASE_ACHIEVERS;
            s.cursor = 0;
        }

        // --- Phase 3: pay achievers from the frozen pot per the bounty model.
        if (s.phase == PHASE_ACHIEVERS) {
            uint256 pot = s.potForAchievers;
            while (s.cursor < n && budget > 0) {
                address user = plist[s.cursor];
                if (achieverFlag[poolId][user]) {
                    uint256 payout = _achieverPayout(poolId, p, user, pot, s);
                    if (payout > 0) {
                        p.balance -= payout;
                        _push(user, payout);
                        s.paidToAchievers += payout;
                        emit AchieverPaid(poolId, user, payout);
                    }
                }
                s.cursor++;
                budget--;
            }
            if (s.cursor < n) {
                emit SettlementAdvanced(poolId, s.phase, s.cursor);
                return;
            }
            s.phase = PHASE_DONE;
            emit PoolSettled(poolId, s.achieverCount, s.paidToBackers + s.paidToAchievers);
        }
    }

    /// @dev One achiever's payout under the pool's bounty model, from the frozen
    ///      pot. View-only; the caller moves the funds.
    function _achieverPayout(uint256 poolId, Pool storage p, address user, uint256 pot, Settlement storage s)
        internal
        view
        returns (uint256)
    {
        if (pot == 0) return 0;
        uint16 mult = participants[poolId][user].multiplierBps;

        if (p.bountyModel == 0) {
            if (s.totalOwed == 0) return 0;
            uint256 w = p.entryFee * mult; // un-floored weight
            // F-6 (Low): multiply the un-floored weight by the pot BEFORE the
            // divide, instead of flooring owed = entryFee*mult/BPS first and then
            // scaling. Numerator and denominator both use un-floored weights, so
            // the sum of scaled payouts still never exceeds the pot.
            return s.totalOwed > pot ? (w * pot) / s.totalWeight : w / BPS;
        } else {
            if (s.sumMultiplierBps == 0) return 0;
            return (pot * mult) / s.sumMultiplierBps;
        }
    }

    /// @dev Pays all backers of a single achiever: stake back plus a pro-rata cut
    ///      of the frozen bonus pot. Per-iteration CEI: each backer's stake is
    ///      zeroed before the push.
    function _payBackersOf(uint256 poolId, Pool storage p, address user, uint256 bonusPot, uint256 backingOnAchievers)
        internal
        returns (uint256 totalPaid)
    {
        address[] storage blist = backerList[poolId][user];
        for (uint256 j = 0; j < blist.length; j++) {
            address backer = blist[j];
            uint256 stake = backerStake[poolId][user][backer];
            if (stake == 0) continue;
            uint256 payout = stake + (stake * bonusPot) / backingOnAchievers;
            backerStake[poolId][user][backer] = 0;
            p.balance -= payout;
            _push(backer, payout);
            totalPaid += payout;
            emit BackerPaid(poolId, backer, user, payout);
        }
    }

    // SafeERC20-style transfer helpers: tolerate tokens returning nothing, revert
    // on `false` or call failure. F-5: both measure the contract's real USDC
    // balance delta rather than assuming the requested amount moved exactly.

    /// @dev Pulls `amount` from `from` and returns the ACTUAL balance increase.
    ///      Callers must credit the return value, never `amount`, so a
    ///      fee-on-transfer or rebasing token can never leave the ledger
    ///      overstated (which would later make a push revert on insolvency).
    function _pull(address from, uint256 amount) internal returns (uint256 received) {
        uint256 balBefore = usdc.balanceOf(address(this));
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FROM_FAILED");
        received = usdc.balanceOf(address(this)) - balBefore;
    }

    /// @dev Pushes `amount` to `to` and returns the ACTUAL balance decrease (the
    ///      real outflow). For a standard token this equals `amount`; measuring it
    ///      keeps the transfer helpers symmetric with _pull and gives callers the
    ///      true amount that left the contract.
    function _push(address to, uint256 amount) internal returns (uint256 sent) {
        uint256 balBefore = usdc.balanceOf(address(this));
        (bool ok, bytes memory data) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FAILED");
        sent = balBefore - usdc.balanceOf(address(this));
    }
}
