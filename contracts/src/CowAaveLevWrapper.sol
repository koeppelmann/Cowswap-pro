// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

import {CowWrapper, ICowSettlement, ICowWrapper} from "./CowWrapper.sol";

/*
 * CowAaveLevWrapper — MODEL B: a SPECIALIZED CoW wrapper for the Aave leverage use case.
 *
 * One wrapper does everything: it takes the Aave flash loan itself AND performs the Aave operations
 * itself as the Safe (it is the Safe's enabled module). The Safe registers small SEMANTIC params
 * ("OPEN: collateral WETH, debt WXDAI, flash 200, borrow 100.1") instead of encoding generic pre/post
 * calldata — and the supply amount is DYNAMIC (the actual swap proceeds, measured as a balance delta).
 *
 *   solver → wrappedSettle(settleData, chain=[(safe,nonce)])
 *     _wrap: load+freeze params, snapshot balances, POOL.flashLoan(debt, flashAmount)
 *       executeOperation:
 *         transfer flash → safe
 *         CLOSE pre : as the Safe: approve+repay ALL debt, withdraw `withdrawAmount` collateral,
 *                     approve vaultRelayer for the withdrawn delta
 *         OPEN  pre : as the Safe: approve vaultRelayer for the flash (sell side)
 *         bless uid digest → _nextMem → settle (EIP-1271 via CoWSafeSigHandler → isBlessed) → unbless
 *         require filledAmount ≥ expectedFill
 *         OPEN  post: supply the collateral DELTA, borrow `borrowAmount`, route flash+premium back
 *         CLOSE post: route flash+premium back, send the debt-token SURPLUS DELTA to `payout`
 *         approve POOL for flash+premium  → pool pulls; anything short → whole tx reverts
 *
 * Per the adversarial review of the draft spec, all amounts touching pre-existing Safe funds are either
 * EXPLICITLY REGISTERED by the Safe (borrowAmount, withdrawAmount, payout) or DELTA-BASED (supply =
 * collateral gained by the swap; surplus = debt-token gained by the action) — the wrapper never
 * touches balances that predate the action. Token addresses are registered by the Safe itself
 * (owner-authorized), so a hostile token is self-harm only. One leverage action per wrapped settlement.
 */

interface ISafeModule {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external returns (bool success);
}
interface ISettlementFilledL {
    function filledAmount(bytes calldata orderUid) external view returns (uint256);
}
interface IAavePoolLev {
    function flashLoan(address receiver, address[] calldata assets, uint256[] calldata amounts,
        uint256[] calldata modes, address onBehalfOf, bytes calldata params, uint16 ref) external;
}
interface IERC20L {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract CowAaveLevWrapper is CowWrapper {
    IAavePoolLev public immutable POOL;
    address public immutable VAULT_RELAYER;

    uint8 public constant OPEN = 0;
    uint8 public constant CLOSE = 1;

    struct LevParams {
        bytes   uid;            // 56-byte CoW order UID; digest = uid[0:32] blessed during settle
        uint256 expectedFill;   // minimum filledAmount after settle (sell: sellAmount, buy: buyAmount)
        uint8   kind;           // 0 OPEN · 1 CLOSE
        address collateral;     // e.g. WETH  (registered by the Safe — owner-authorized)
        address debt;           // e.g. WXDAI
        uint256 flashAmount;    // flash-borrowed `debt` delivered to the Safe. NOTE: CLOSE repays at most
                                // this budget (the pool approval bounds it) — registering flashAmount
                                // below the outstanding debt is a deliberate PARTIAL close by the Safe.
        uint256 borrowAmount;   // OPEN: exact borrow after supply (typically flash+premium−equity); CLOSE: 0
        uint256 withdrawAmount; // CLOSE: collateral to withdraw (type(uint).max = ALL, a deliberate choice); OPEN: 0
        address payout;         // CLOSE: recipient of the debt-token surplus delta (0 = stays in the Safe)
        uint64  deadline;       // 0 = none
        uint8   status;         // 0 none · 1 registered · 2 consumed
    }
    mapping(address => mapping(uint256 => LevParams)) public positions;

    // transient
    bytes32 private constant T_EPOCH = keccak256("CowAaveLevWrapper.EPOCH");
    bytes32 private constant T_BLESS_IN = keccak256("CowAaveLevWrapper.BLESS_IN"); // bless window flag
    bytes32 private constant T_FL = keccak256("CowAaveLevWrapper.FL");             // flash frame flag

    event Registered(address indexed safe, uint256 indexed nonce, bytes32 uidHash, uint8 kind);
    event Cancelled(address indexed safe, uint256 indexed nonce);
    event Executed(address indexed safe, uint256 indexed nonce, uint8 kind);

    error NotPool();
    error NotSelfInitiated();
    error NotInFlash();

    constructor(ICowSettlement settlement_, IAavePoolLev pool_, address vaultRelayer_)
        CowWrapper(settlement_)
    {
        POOL = pool_;
        VAULT_RELAYER = vaultRelayer_;
    }

    /// @inheritdoc ICowWrapper
    function name() external pure override returns (string memory) { return "CowAaveLevWrapper"; }

    // ================= registration (direct Safe CALL only) =================
    function registerLeverage(uint256 nonce, LevParams calldata p) external {
        require(p.uid.length == 56, "uid len");
        require(_uidOwner(p.uid) == msg.sender, "uid owner != safe");
        require(p.expectedFill > 0 && p.flashAmount > 0, "amounts");
        require(p.kind <= CLOSE, "kind");
        LevParams storage s = positions[msg.sender][nonce];
        require(s.status != 2, "nonce consumed");
        s.uid = p.uid; s.expectedFill = p.expectedFill; s.kind = p.kind;
        s.collateral = p.collateral; s.debt = p.debt;
        s.flashAmount = p.flashAmount; s.borrowAmount = p.borrowAmount; s.withdrawAmount = p.withdrawAmount;
        s.payout = p.payout; s.deadline = p.deadline;
        s.status = 1;
        emit Registered(msg.sender, nonce, keccak256(p.uid), p.kind);
    }

    function cancelLeverage(uint256 nonce) external {
        LevParams storage s = positions[msg.sender][nonce];
        require(s.status == 1, "not active");
        s.status = 0;
        emit Cancelled(msg.sender, nonce);
    }

    function positionStatus(address safe, uint256 nonce) external view returns (uint8) {
        return positions[safe][nonce].status;
    }

    // ================= ICowWrapper =================
    /// @inheritdoc ICowWrapper
    function validateWrapperData(bytes calldata wrapperData) external pure override {
        abi.decode(wrapperData, (address, uint256)); // (safe, nonce); one action per wrapped settlement
    }

    /// @inheritdoc CowWrapper
    function _wrap(bytes calldata settleData, bytes calldata wrapperData, bytes calldata remainingWrapperData)
        internal
        override
    {
        require(_tload(T_FL) == 0, "reentrant");
        // This wrapper must be the FINAL wrapper in the chain: the bless window must cover ONLY the
        // direct GPv2Settlement.settle call, never arbitrary downstream wrapper logic (audit High-1).
        // Composition with the generic flash layer is still possible as FlashLoanWrapper → this → settle.
        require(remainingWrapperData.length == 0, "must be final wrapper");
        Ctx memory c;
        c.settleData = settleData;
        c.remaining = remainingWrapperData;
        (c.safe, c.nonce) = abi.decode(wrapperData, (address, uint256));

        LevParams storage p = positions[c.safe][c.nonce];
        require(p.status == 1, "not registered");
        if (p.deadline != 0) require(block.timestamp <= p.deadline, "expired");
        require(ISettlementFilledL(address(SETTLEMENT)).filledAmount(p.uid) == 0, "already filled");
        p.status = 2; // freeze (one-shot; reverts with the tx on failure)

        // balance snapshots → all later amounts are DELTAS (never touch pre-existing funds)
        c.collBefore = IERC20L(p.collateral).balanceOf(c.safe);
        c.debtBefore = IERC20L(p.debt).balanceOf(c.safe);
        c.ownBefore  = IERC20L(p.debt).balanceOf(address(this)); // stranded-funds protection (audit M-3)

        _tstore(T_FL, 1);
        _startFlash(p.debt, p.flashAmount, c);
        _tstore(T_FL, 0);
    }

    function _startFlash(address debtToken, uint256 flashAmount, Ctx memory c) private {
        address[] memory assets = new address[](1);  assets[0] = debtToken;
        uint256[] memory amounts = new uint256[](1); amounts[0] = flashAmount;
        POOL.flashLoan(address(this), assets, amounts, new uint256[](1), address(this), abi.encode(c), 0);
    }

    // ================= Aave callback (the whole leverage flow lives here) =================
    struct Ctx { bytes settleData; bytes remaining; address safe; uint256 nonce; uint256 collBefore; uint256 debtBefore; uint256 ownBefore; }

    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), NotPool());
        require(initiator == address(this), NotSelfInitiated());
        require(_tload(T_FL) == 1, NotInFlash());

        Ctx memory c = abi.decode(params, (Ctx));

        // deliver the flash liquidity to the Safe
        require(IERC20L(assets[0]).transfer(c.safe, amounts[0]), "deliver");

        _phasePre(c);
        _phaseSettle(c);
        _phasePost(c, amounts[0] + premiums[0]);

        // repayment must be funded ON TOP of any pre-existing wrapper balance (stranded funds are
        // never drained to subsidize a repayment — audit M-3); pool pulls via this allowance
        require(IERC20L(assets[0]).balanceOf(address(this)) >= c.ownBefore + amounts[0] + premiums[0], "underfunded");
        _approvePool(assets[0], amounts[0] + premiums[0]);
        return true;
    }

    /// pre-settle phase (as the Safe)
    function _phasePre(Ctx memory c) private {
        LevParams storage p = positions[c.safe][c.nonce]; // frozen (status==2)
        if (p.kind == CLOSE) {
            _exec(c.safe, p.debt, abi.encodeWithSignature("approve(address,uint256)", address(POOL), p.flashAmount));
            _exec(c.safe, address(POOL), abi.encodeWithSignature("repay(address,uint256,uint256,address)", p.debt, type(uint256).max, uint256(2), c.safe));
            _exec(c.safe, address(POOL), abi.encodeWithSignature("withdraw(address,uint256,address)", p.collateral, p.withdrawAmount, c.safe));
            // sell budget = ONLY what this action withdrew (delta), approved to the CoW vault relayer
            uint256 sellBudget = IERC20L(p.collateral).balanceOf(c.safe) - c.collBefore;
            _exec(c.safe, p.collateral, abi.encodeWithSignature("approve(address,uint256)", VAULT_RELAYER, sellBudget));
        } else {
            // OPEN: sell side = the flash-borrowed debt token
            _exec(c.safe, p.debt, abi.encodeWithSignature("approve(address,uint256)", VAULT_RELAYER, p.flashAmount));
        }
    }

    /// settle with a minimal bless window, then prove the fill
    function _phaseSettle(Ctx memory c) private {
        LevParams storage p = positions[c.safe][c.nonce];
        uint256 epoch = _tload(T_EPOCH) + 1;
        _tstore(T_EPOCH, epoch);
        _tstore(_sBless(epoch, c.safe, _digest(p.uid)), 1);
        _tstore(T_BLESS_IN, 1);
        _nextMem(c.settleData, c.remaining);
        _tstore(T_BLESS_IN, 0);
        require(ISettlementFilledL(address(SETTLEMENT)).filledAmount(p.uid) >= p.expectedFill, "not settled");
    }

    /// post-settle phase (as the Safe)
    function _phasePost(Ctx memory c, uint256 repayAmt) private {
        LevParams storage p = positions[c.safe][c.nonce];
        // reset the sell allowance: no durable vault-relayer approval survives the one-shot action (audit M-2)
        _exec(c.safe, p.kind == OPEN ? p.debt : p.collateral,
            abi.encodeWithSignature("approve(address,uint256)", VAULT_RELAYER, 0));
        if (p.kind == OPEN) {
            // supply ONLY the swap proceeds (collateral delta) — never pre-existing collateral
            uint256 gained = IERC20L(p.collateral).balanceOf(c.safe) - c.collBefore;
            _exec(c.safe, p.collateral, abi.encodeWithSignature("approve(address,uint256)", address(POOL), gained));
            _exec(c.safe, address(POOL), abi.encodeWithSignature("supply(address,uint256,address,uint16)", p.collateral, gained, c.safe, uint16(0)));
            _exec(c.safe, address(POOL), abi.encodeWithSignature("borrow(address,uint256,uint256,uint16,address)", p.debt, p.borrowAmount, uint256(2), uint16(0), c.safe));
            _exec(c.safe, p.debt, abi.encodeWithSignature("transfer(address,uint256)", address(this), repayAmt));
        } else {
            _exec(c.safe, p.debt, abi.encodeWithSignature("transfer(address,uint256)", address(this), repayAmt));
            if (p.payout != address(0)) {
                // surplus = debt-token DELTA gained by this action (sale proceeds − repayments − flash routing)
                uint256 bal = IERC20L(p.debt).balanceOf(c.safe);
                if (bal > c.debtBefore) {
                    _exec(c.safe, p.debt, abi.encodeWithSignature("transfer(address,uint256)", p.payout, bal - c.debtBefore));
                }
            }
        }
        emit Executed(c.safe, c.nonce, p.kind);
    }

    /// @notice EIP-1271 read used by CoWSafeSigHandler (same interface as CoWSafeWrapper.isBlessed).
    function isBlessed(address safe, bytes32 digest) external view returns (bool) {
        if (_tload(T_BLESS_IN) != 1) return false;
        return _tload(_sBless(_tload(T_EPOCH), safe, digest)) == 1;
    }

    // ================= internals =================
    function _exec(address safe, address to, bytes memory data) private {
        require(ISafeModule(safe).execTransactionFromModule(to, 0, data, 0), "exec failed"); // CALL-only
    }
    function _approvePool(address token, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(POOL), amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "approve");
    }

    /// @dev memory-args mirror of CowWrapper._next (continuation crosses the Aave callback boundary)
    function _nextMem(bytes memory settleData, bytes memory remaining) internal {
        if (remaining.length == 0) {
            require(settleData.length >= 4 && bytes4(_first4(settleData)) == ICowSettlement.settle.selector,
                InvalidSettleData(settleData));
            _callWithBubbleRevert(address(SETTLEMENT), settleData);
        } else {
            require(remaining.length >= 20, "chain");
            address nextWrapper = address(bytes20(_first20(remaining)));
            bytes memory rest = _sliceMem(remaining, 20);
            bytes memory returnData = _callWithBubbleRevert(
                nextWrapper, abi.encodeCall(ICowWrapper.wrappedSettle, (settleData, rest))
            );
            require(
                returnData.length == 32 && bytes32(returnData) == bytes32(ICowWrapper.wrappedSettle.selector),
                InvalidNextWrapper(nextWrapper)
            );
        }
    }

    function _sBless(uint256 e, address safe, bytes32 digest) private pure returns (bytes32) {
        return keccak256(abi.encode("CowAaveLevWrapper.BLESS", e, safe, digest));
    }
    function _first4(bytes memory b) private pure returns (bytes4 out) { assembly { out := mload(add(b, 32)) } }
    function _first20(bytes memory b) private pure returns (bytes20 out) { assembly { out := mload(add(b, 32)) } }
    function _sliceMem(bytes memory b, uint256 start) private pure returns (bytes memory r) {
        uint256 len = b.length - start;
        r = new bytes(len);
        assembly ("memory-safe") { mcopy(add(r, 32), add(add(b, 32), start), len) }
    }
    function _digest(bytes memory uid) private pure returns (bytes32 d) { assembly { d := mload(add(uid, 32)) } }
    function _uidOwner(bytes memory uid) private pure returns (address o) { assembly { o := shr(96, mload(add(uid, 64))) } }
    function _tload(bytes32 slot) private view returns (uint256 v) { assembly { v := tload(slot) } }
    function _tstore(bytes32 slot, uint256 v) private { assembly { tstore(slot, v) } }
}
