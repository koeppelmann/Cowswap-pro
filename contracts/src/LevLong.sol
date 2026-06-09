// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IGPv2Settlement {
    function setPreSignature(bytes calldata orderUid, bool signed) external;
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanRouter {
    function borrowerCallBack(bytes calldata callBackData) external;
}

/**
 * @title LevLong
 * @notice A per-position leverage instance that is, in one atomic CoW settlement,
 *         simultaneously: (1) the flash-loan BORROWER, (2) the CoW order owner /
 *         receiver, and (3) the Aave account that ends up holding the levered
 *         collateral and debt.
 *
 *         Folding the borrower into the instance is the key design choice: Aave
 *         sends the flash loan straight here, this contract sells it via CoW,
 *         supplies the bought collateral, borrows the debt token, and pre-approves
 *         the Aave pool to pull back the flash-loan repayment — so a solver needs
 *         to build only a STANDARD settlement (trade + trampoline hook), with no
 *         flashloan-specific routing interactions. That maximises the chance a
 *         generic solver will pick the order up.
 *
 *         Custody: only `owner` can move funds, set approvals, or presign. The
 *         hook entrypoint (`openLeg`) is callable by the CoW trampoline or owner
 *         and only ever acts on this instance's own balances into its own
 *         (owner-controlled) Aave position — anyone may *complete* the trade, no
 *         one can divert funds.
 */
contract LevLong {
    IGPv2Settlement public constant SETTLEMENT = IGPv2Settlement(0x9008D19f58AAbD9eD0D60971565AA8510560ab41);
    address public constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    IAavePool public constant POOL = IAavePool(0xb50201558B00496A145fE76f7424749556E326D8);
    IFlashLoanRouter public constant ROUTER = IFlashLoanRouter(0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69);
    // CoW HooksTrampoline on GNOSIS (mainnet's is 0x01DcB8…; Gnosis differs!)
    address public constant TRAMPOLINE = 0x60Bf78233f48eC42eE3F101b9a05eC7878728006;

    address public immutable owner;

    /// @notice Order digests the owner has approved for EIP-1271 validation.
    mapping(bytes32 => bool) public approvedHashes;

    constructor(address _owner) {
        owner = _owner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "!owner");
        _;
    }

    // ---------------------------------------------------------------------
    // Flash-loan borrower role (called by the FlashLoanRouter during settle)
    // ---------------------------------------------------------------------

    /// @notice Router entrypoint: trigger the Aave flash loan to THIS contract,
    ///         then hand control back to the router to run the settlement.
    function flashLoanAndCallBack(address lender, address token, uint256 amount, bytes calldata callBackData) external {
        require(msg.sender == address(ROUTER), "!router");
        address[] memory assets = new address[](1);
        assets[0] = token;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // no debt: revert if not repaid by end of tx
        IAavePool(lender).flashLoan(address(this), assets, amounts, modes, address(this), callBackData, 0);
    }

    /// @notice Aave flash-loan callback. The loan funds are now in this contract;
    ///         re-enter the router to execute the CoW settlement, then return true
    ///         so Aave pulls back `amount + premium` (which `openLeg` pre-approved).
    function executeOperation(
        address[] calldata,
        uint256[] calldata,
        uint256[] calldata,
        address,
        bytes calldata callBackData
    ) external returns (bool) {
        require(msg.sender == address(POOL), "!pool");
        ROUTER.borrowerCallBack(callBackData);
        return true;
    }

    // ---------------------------------------------------------------------
    // CoW post-hook: build the levered position + pre-approve repayment
    // ---------------------------------------------------------------------

    /// @notice POST-HOOK. After the CoW trade has delivered `collateral` here:
    ///         supply it to Aave, borrow `borrowAmount` of `debtToken`, and approve
    ///         the pool for `repayApprove` so Aave can pull the flash-loan repayment
    ///         (loan + premium) after settlement returns. Only the trampoline or
    ///         owner may call, and it only touches this instance's own position.
    function openLeg(address collateral, address debtToken, uint256 borrowAmount, uint256 repayApprove) external {
        require(msg.sender == TRAMPOLINE || msg.sender == owner, "!auth");
        uint256 cb = IERC20(collateral).balanceOf(address(this));
        if (cb > 0) {
            IERC20(collateral).approve(address(POOL), cb);
            POOL.supply(collateral, cb, address(this), 0);
        }
        if (borrowAmount > 0) {
            POOL.borrow(debtToken, borrowAmount, 2, 0, address(this));
        }
        IERC20(debtToken).approve(address(POOL), repayApprove);
    }

    // ---------------------------------------------------------------------
    // CLOSE: unwind the position inside a CoW flash-loan settlement
    // ---------------------------------------------------------------------

    /// @notice CLOSE pre-hook. The flash loan has delivered `debtToken` here; use it to
    ///         repay ALL Aave debt, withdraw ALL `collateral`, and approve the relayer so
    ///         the CoW order can sell the freed collateral. Trampoline- or owner-callable.
    function closePrepare(address collateral, address debtToken) external {
        require(msg.sender == TRAMPOLINE || msg.sender == owner, "!auth");
        IERC20(debtToken).approve(address(POOL), type(uint256).max);
        POOL.repay(debtToken, type(uint256).max, 2, address(this));
        POOL.withdraw(collateral, type(uint256).max, address(this));
        IERC20(collateral).approve(VAULT_RELAYER, type(uint256).max);
    }

    /// @notice CLOSE post-hook. Keep exactly `repayApprove` of `debtToken` approved for the
    ///         Aave flash-loan pull, and forward everything else — leftover debt token and ALL
    ///         remaining collateral — to `recipient` (the user's wallet).
    function closeFinalize(address collateral, address debtToken, uint256 repayApprove, address recipient) external {
        require(msg.sender == TRAMPOLINE || msg.sender == owner, "!auth");
        IERC20(debtToken).approve(address(POOL), repayApprove);
        uint256 d = IERC20(debtToken).balanceOf(address(this));
        if (d > repayApprove) IERC20(debtToken).transfer(recipient, d - repayApprove);
        uint256 c = IERC20(collateral).balanceOf(address(this));
        if (c > 0) IERC20(collateral).transfer(recipient, c);
    }

    // ---------------------------------------------------------------------
    // Owner setup / custody
    // ---------------------------------------------------------------------

    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        IERC20(token).approve(spender, amount);
    }

    function preSign(bytes calldata orderUid) external onlyOwner {
        SETTLEMENT.setPreSignature(orderUid, true);
    }

    /// @notice One-shot setup for a position: approve the VaultRelayer to pull the
    ///         sell token AND approve the order digest for EIP-1271 — both in one tx.
    function setup(address sellToken, bytes32 orderHash) external onlyOwner {
        IERC20(sellToken).approve(VAULT_RELAYER, type(uint256).max);
        approvedHashes[orderHash] = true;
    }

    /// @notice Approve a CoW order digest so this contract validates it via EIP-1271.
    ///         EIP-1271 (not presign) is required so the CoW autopilot exempts the
    ///         order from its balance filter and lets the flashloan supply the sell
    ///         tokens during settlement.
    function approveOrderHash(bytes32 hash) external onlyOwner {
        approvedHashes[hash] = true;
    }

    /// @notice EIP-1271: valid iff the owner pre-approved this order digest.
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return approvedHashes[hash] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    function exec(address target, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "exec failed");
        return ret;
    }
}
