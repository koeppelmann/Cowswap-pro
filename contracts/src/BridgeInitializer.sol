// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IForeignOmnibridgeErc20 {
    /// @notice Native-xDAI bridge: lock `_amount` of the bridged token (USDS post-migration)
    ///         and credit native xDAI 1:1 to `_receiver` on Gnosis Chain (~26 min, no callback).
    function relayTokens(address _receiver, uint256 _amount) external;
}

/**
 * @title BridgeInitializer
 * @notice Stateless helper `DELEGATECALL`ed exactly once during a mainnet Safe's
 *         `setup()` (via the `to`/`data` args). Running in the Safe's context
 *         (`address(this) == safe`) it:
 *
 *           1. reads the Safe's *runtime* USDS balance — whatever the CoW swap
 *              delivered to this address as the order `receiver`, capturing any
 *              solver surplus (the amount is unknown at signing time);
 *           2. approves the native xDAI bridge (Foreign Omnibridge, post-USDS) to
 *              pull that USDS;
 *           3. calls `relayTokens(gnosisReceiver, balance)` — the only 1:1,
 *              zero-slippage rail — crediting native xDAI to the counterfactual
 *              Gnosis Safe (`gnosisReceiver`) ~26 min later.
 *
 *         The whole `setup()` calldata (owner, this initializer, `gnosisReceiver`)
 *         is hashed by the SafeProxyFactory into the CREATE2 salt, so the mainnet
 *         Safe address *commits* to bridging to exactly that Gnosis address. The
 *         deploy is therefore permissionless: anyone (the CoW post-hook, a keeper,
 *         or the user) may deploy it and the funds can only flow to the committed
 *         recipient. If the post-hook is gas-skipped the USDS simply waits at the
 *         Safe address until someone deploys — nothing is ever stranded.
 *
 * @dev Deploy once on Ethereum mainnet at a deterministic address; immutable and
 *      stateless, so a single instance is shared by every user's Safe.
 */
contract BridgeInitializer {
    using SafeERC20 for IERC20;

    /// @dev USDS (Sky) on Ethereum mainnet — the token the xDAI bridge now locks
    ///      (post 7-Nov-2025 USDS migration; verified on-chain: foreign bridge
    ///      `erc20token()` == this address).
    IERC20 public constant USDS = IERC20(0xdC035D45d973E3EC169d2276DDab16f1e407384F);

    /// @dev Foreign Omnibridge (native xDAI bridge, mainnet side).
    IForeignOmnibridgeErc20 public constant BRIDGE =
        IForeignOmnibridgeErc20(0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016);

    event BridgeInitialized(address indexed safe, address indexed gnosisReceiver, uint256 amount);

    /**
     * @param gnosisReceiver the counterfactual Gnosis Safe that receives native
     *        xDAI (baked into the mainnet Safe's CREATE2 salt via this calldata).
     * @dev MUST be reached by `DELEGATECALL` from the Safe. `forceApprove` handles
     *      USDS (a standard ERC20 with a normal approve, but forceApprove is used
     *      defensively). Bridges the entire USDS balance held by the Safe.
     */
    function initialize(address gnosisReceiver) external {
        require(gnosisReceiver != address(0), "receiver=0");
        uint256 bal = USDS.balanceOf(address(this));
        require(bal > 0, "no USDS");
        USDS.forceApprove(address(BRIDGE), bal);
        BRIDGE.relayTokens(gnosisReceiver, bal);
        emit BridgeInitialized(address(this), gnosisReceiver, bal);
    }
}
