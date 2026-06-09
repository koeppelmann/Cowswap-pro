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
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
}

/**
 * @title LevProxy
 * @notice Per-USER proxy that holds a leveraged CoW + Aave position. It is the
 *         CoW order's receiver and (later) the account that supplies collateral
 *         and carries debt on Aave V3. It must be per-user (not per-trade) so its
 *         address doesn't depend on the order's appData — the order's post-hook
 *         target sits *inside* appData, which would otherwise be circular.
 *
 *         Custody: only `owner` can move funds, set approvals, presign orders, or
 *         make arbitrary Aave calls (`exec`). The hook entrypoints are
 *         permissionless but only ever act on this proxy's own balance into its
 *         own (owner-controlled) position — so anyone may *complete* a trade, but
 *         no one can divert funds.
 */
contract LevProxy {
    address public constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address public constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    // Aave V3 Pool on Gnosis — HARDCODED so a caller can never redirect approvals.
    IAavePool public constant POOL = IAavePool(0xb50201558B00496A145fE76f7424749556E326D8);
    // CoW HooksTrampoline — the only contract allowed to trigger hooks (besides owner).
    address public constant TRAMPOLINE = 0x01DcB88678aedD0C4cC9552B20F4718550250574;

    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "!owner");
        _;
    }

    /// @notice Approve a spender (VaultRelayer for the sell token, etc.).
    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        IERC20(token).approve(spender, amount);
    }

    /// @notice Pre-sign a specific CoW order (uid computed off-chain) so it can fill.
    function preSign(bytes calldata orderUid) external onlyOwner {
        IGPv2Settlement(SETTLEMENT).setPreSignature(orderUid, true);
    }

    /// @notice POST-HOOK: supply this proxy's full `asset` balance to Aave as its own
    ///         collateral. Callable ONLY by the CoW trampoline (during settlement) or
    ///         the owner — never arbitrary callers — and only ever approves/calls the
    ///         hardcoded Aave POOL, so it cannot be used to drain funds.
    function supplyToAave(address asset) external {
        require(msg.sender == TRAMPOLINE || msg.sender == owner, "!auth");
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal > 0) {
            IERC20(asset).approve(address(POOL), bal);
            POOL.supply(asset, bal, address(this), 0);
        }
    }

    /// @notice Move tokens out (owner only) — full custody / recovery.
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    /// @notice Arbitrary call (owner only): borrow, repay, withdraw collateral, etc.
    function exec(address target, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "exec failed");
        return ret;
    }
}
