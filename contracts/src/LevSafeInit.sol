// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

interface ISafeModules { function enableModule(address module) external; }
interface IERC20Approve { function approve(address, uint256) external returns (bool); }

/**
 * @title LevSafeInit
 * @notice Run via delegatecall from Safe.setup (the `to`/`data` arg) at creation time,
 *         in the new Safe's own context: enable the LevModule and pre-approve the CoW
 *         VaultRelayer to pull the sell token. One-shot, no state.
 */
contract LevSafeInit {
    function setup(address module, address sellToken, address relayer) external {
        ISafeModules(address(this)).enableModule(module);
        IERC20Approve(sellToken).approve(relayer, type(uint256).max);
    }
}
