// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

interface ISafeModule {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success);
    function getOwners() external view returns (address[] memory);
    function isModuleEnabled(address module) external view returns (bool);
}

interface ISavingsXDaiAdapter {
    /// @notice Wrap native xDAI (msg.value) into wxDAI, deposit into the sDAI
    ///         ERC-4626 vault, and send the minted sDAI to `receiver`.
    function depositXDAI(address receiver) external payable returns (uint256 shares);
}

/**
 * @title ConvertModule (v2)
 * @notice A single shared, immutable Safe module that finalizes the second leg of
 *         a "swap → sDAI on Gnosis" transfer. The native xDAI bridge has NO
 *         callback and credits an undeployed address, so the xDAI→sDAI conversion
 *         cannot be atomic on arrival — it needs a permissionless trigger.
 *
 *         A user's counterfactual 1/1 Gnosis Safe enables this module at deploy
 *         (via `SdaiSafeInitializer`). Once native xDAI is bridged in, ANYONE may
 *         call `convert(safe)`:
 *
 *           1. **gas stipend** — if the owner's xDAI balance is below `GAS_FLOOR`,
 *              send them `GAS_STIPEND` native xDAI from the bridged amount. A user
 *              who arrived cross-chain holds only sDAI and zero xDAI, so they can't
 *              pay gas to do anything on Gnosis (e.g. bridge back). This bootstraps
 *              them just enough to transact. Conditional, so users who already have
 *              gas (e.g. on a repeat deposit to their reused Safe) aren't re-dusted.
 *           2. deposit the remainder into the sDAI vault, minting sDAI to the owner
 *              (receiver is the Safe's sole owner — NOT caller-supplied — so it can't
 *              be redirected);
 *           3. pay a fixed 0.01 xDAI tip to `msg.sender` (liveness = incentive).
 *
 *         Reentrancy-guarded (`locked`) in addition to draining before the untrusted
 *         tip transfer. `convert` is idempotent w.r.t. leftover dust.
 *
 * @dev Deploy once on Gnosis Chain at a deterministic address; shared by every
 *      user's Safe. (v1 lacked the gas stipend; a Safe commits to whichever module
 *      it enabled at creation.)
 */
contract ConvertModule {
    /// @dev SavingsXDaiAdapter on Gnosis (Spark) — native-xDAI entry point to sDAI.
    ISavingsXDaiAdapter public constant ADAPTER =
        ISavingsXDaiAdapter(0xD499b51fcFc66bd31248ef4b28d656d67E591A94);

    /// @dev Fixed finalize tip: 0.01 xDAI, paid to whoever calls convert().
    uint256 public constant TIP = 0.01 ether;
    /// @dev Give the owner a gas stipend only if their xDAI is below this floor.
    uint256 public constant GAS_FLOOR = 0.01 ether;
    /// @dev Size of the gas stipend (~20 Gnosis txs; covers the reverse). Matches TIP.
    uint256 public constant GAS_STIPEND = 0.01 ether;

    uint8 private constant CALL = 0; // Enum.Operation.Call

    /// @dev Non-reentrancy guard (shared across Safes — converts are never nested).
    uint256 private _locked;

    event Converted(
        address indexed safe, address indexed receiver, uint256 deposited, uint256 stipend, address indexed keeper, uint256 tip
    );

    /**
     * @notice Convert bridged native xDAI held by `safe` into sDAI for the owner,
     *         top up the owner's gas if empty, and tip the caller.
     * @param safe a 1/1 Safe that has enabled this module (see `SdaiSafeInitializer`).
     */
    function convert(address safe) external {
        require(_locked == 0, "reentrant");
        _locked = 1;

        require(ISafeModule(safe).isModuleEnabled(address(this)), "module disabled");

        uint256 bal = safe.balance;
        require(bal > TIP, "nothing to convert");

        address[] memory owners = ISafeModule(safe).getOwners();
        require(owners.length == 1, "not 1/1");
        address receiver = owners[0];

        // (1) gas stipend for a gas-less owner — bounded so the deposit never underflows.
        uint256 stipend = receiver.balance < GAS_FLOOR ? GAS_STIPEND : 0;
        if (stipend + TIP > bal) stipend = bal - TIP; // bal > TIP guaranteed above
        uint256 depositAmount = bal - TIP - stipend;

        // (2) deposit the remainder -> sDAI to the owner. ADAPTER is a trusted Spark
        //     contract. Drain first so the untrusted tip transfer can't re-enter.
        if (depositAmount > 0) {
            require(
                ISafeModule(safe).execTransactionFromModule(
                    address(ADAPTER), depositAmount, abi.encodeCall(ISavingsXDaiAdapter.depositXDAI, (receiver)), CALL
                ),
                "deposit failed"
            );
        }

        // (3) pay the stipend to the owner (native xDAI).
        if (stipend > 0) {
            ISafeModule(safe).execTransactionFromModule(receiver, stipend, "", CALL);
        }

        // (4) pay the tip to the caller LAST (untrusted external call).
        ISafeModule(safe).execTransactionFromModule(msg.sender, TIP, "", CALL);

        emit Converted(safe, receiver, depositAmount, stipend, msg.sender, TIP);
        _locked = 0;
    }
}
