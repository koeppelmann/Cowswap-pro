// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

interface IModuleManager {
    function enableModule(address module) external;
}

/**
 * @title SdaiSafeInitializer
 * @notice Stateless helper `DELEGATECALL`ed exactly once during a Gnosis Safe's
 *         `setup()`. Running in the Safe's context (`address(this) == safe`) it
 *         enables the shared `ConvertModule` — a self-call, the only way past the
 *         Safe's `authorized` (`onlySelf`) guard on `enableModule`.
 *
 *         The module address is passed in and hashed (with the owner) into the
 *         SafeProxyFactory CREATE2 salt, so the Gnosis Safe address *commits* to
 *         enabling exactly this converter. The native xDAI bridged in from mainnet
 *         can then be turned into sDAI for the owner by anyone calling
 *         `ConvertModule.convert(safe)`.
 *
 * @dev Deploy once on Gnosis Chain at a deterministic address; stateless, shared
 *      by every user's Safe. No token pull and no fallback handler are needed —
 *      the Safe only ever holds transient native xDAI.
 */
contract SdaiSafeInitializer {
    event SdaiSafeInitialized(address indexed safe, address indexed module);

    /**
     * @param module the shared ConvertModule to enable (committed via the salt).
     * @dev MUST be reached by `DELEGATECALL` from the Safe.
     */
    function initialize(address module) external {
        require(module != address(0), "module=0");
        IModuleManager(address(this)).enableModule(module);
        emit SdaiSafeInitialized(address(this), module);
    }
}
