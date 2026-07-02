// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

interface ISafeProxyFactoryLike {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface IConvertModuleLike {
    function convert(address safe) external;
}

/**
 * @title SdaiFinalizeHelper
 * @notice Atomic **deploy + convert** for the sDAI finalize step. An EOA keeper
 *         cannot do two calls in one transaction, so without this it must (1)
 *         `createProxyWithNonce` then (2) `ConvertModule.convert` as separate txs —
 *         and a competing keeper could take the 0.01 xDAI tip in between, leaving
 *         the first keeper out its (non-refundable) deploy gas.
 *
 *         `finalize` does both in ONE call: deploy the user's Gnosis Safe, then
 *         convert its bridged xDAI to sDAI. `ConvertModule.convert` pays the tip to
 *         `msg.sender` (= this helper), which forwards it to the keeper. All-or-
 *         nothing: if anyone front-runs the convert, `createProxyWithNonce` reverts
 *         ("proxy already exists") or `convert` reverts ("nothing to convert"), so
 *         the whole tx reverts and the keeper pays no deploy gas for a lost tip.
 *
 * @dev Stateless, immutable, shared. Only used for the FIRST finalize of a Safe
 *      (when it's still counterfactual). If the Safe already exists, a keeper calls
 *      `ConvertModule.convert` directly (no deploy → no race).
 */
contract SdaiFinalizeHelper {
    ISafeProxyFactoryLike public constant FACTORY =
        ISafeProxyFactoryLike(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
    IConvertModuleLike public constant MODULE =
        IConvertModuleLike(0x7cE6e4fe5c6658FF3f98C417Da09E6C31c9aAae3); // ConvertModule v3

    /**
     * @notice Deploy `safe` (from its committed setup) and convert its xDAI to sDAI,
     *         forwarding the finalize tip to the caller — atomically.
     * @return safe the deployed Safe address.
     */
    function finalize(address singleton, bytes calldata setup, uint256 saltNonce)
        external
        returns (address safe)
    {
        safe = FACTORY.createProxyWithNonce(singleton, setup, saltNonce);
        MODULE.convert(safe); // tip (native xDAI) paid to this helper
        _sweepTo(msg.sender);
    }

    function _sweepTo(address to) private {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = payable(to).call{value: bal}("");
            require(ok, "tip forward failed");
        }
    }

    receive() external payable {}
}
