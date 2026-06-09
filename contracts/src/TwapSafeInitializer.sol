// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IComposableCoW,
    IConditionalOrder,
    ISignatureVerifierMuxer,
    ISafeSignatureVerifier,
    IValueFactory
} from "./interfaces/ICoW.sol";

/**
 * @title TwapSafeInitializer
 * @notice Stateless helper meant to be `DELEGATECALL`ed exactly once, during a
 *         Safe's `setup()` (via the `to`/`data` arguments). Because it runs in
 *         the Safe's context (`address(this) == safe`), it can:
 *
 *           1. set the GPv2 domain verifier on the Safe's ExtensibleFallbackHandler
 *              (a self-call, which is the only way to satisfy the handler's
 *              `onlySelf` guard) -> enables ERC-1271 signing of TWAP parts;
 *           2. approve the CoW VaultRelayer to pull the sell token;
 *           3. register the TWAP conditional order with ComposableCoW, stamping
 *              the current block timestamp into the cabinet so the order starts
 *              "now" (the moment the Safe is deployed & funded).
 *
 *         All of this is encoded into the Safe `setup()` calldata, which the
 *         SafeProxyFactory hashes into the CREATE2 salt. The resulting Safe
 *         address therefore *commits* to the exact owner, fallback handler and
 *         TWAP order: an allowance granted to the predicted address can only be
 *         spent by a deployment that reproduces precisely this configuration.
 *
 * @dev Deploy this once per chain at a deterministic address (see
 *      script/DeployInitializer.s.sol). The contract is immutable and holds no
 *      state, so a single deployment is shared by every user's Safe.
 */
contract TwapSafeInitializer {
    using SafeERC20 for IERC20;

    /// @dev Canonical CoW Protocol / ComposableCoW deployments. Identical across
    ///      Ethereum, Gnosis Chain, Arbitrum, Base, Optimism, Polygon, Sepolia, ...
    IComposableCoW public constant COMPOSABLE_COW =
        IComposableCoW(0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74);
    IValueFactory public constant CURRENT_BLOCK_TIMESTAMP_FACTORY =
        IValueFactory(0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc);
    address public constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    /// @notice Emitted (from the Safe's context) once the TWAP has been registered.
    event TwapSafeInitialized(address indexed safe, address indexed sellToken, bytes32 orderHash);

    /**
     * @param sellToken      the token the TWAP sells (must match params.staticInput).
     * @param from           address to pull the sell token from via `transferFrom`
     *                       (the user's wallet).
     * @param pullAmount     amount to pull into the Safe at deploy time. With an
     *                       allowance granted to the Safe's CREATE2 address, funds
     *                       stay in the user's wallet until deployment — nothing is
     *                       ever stranded at an undeployed address. (The `> 0` guard
     *                       below is purely defensive; the app always sets this.)
     * @param approveAmount  allowance granted to the VaultRelayer; typically
     *                       `n * partSellAmount` (or `type(uint256).max`).
     * @param params         the ComposableCoW conditional order (handler = TWAP,
     *                       staticInput = abi.encode(TWAPOrder.Data) with t0 == 0).
     *
     * @dev MUST be reached via `DELEGATECALL` from the Safe, after the fallback
     *      handler has been set to the ExtensibleFallbackHandler (Safe.setup does
     *      this before running the setup delegatecall). Because it runs as the Safe,
     *      `transferFrom`'s msg.sender is the Safe — exactly the spender the user
     *      approved on the (counterfactual) CREATE2 address.
     */
    function initialize(
        IERC20 sellToken,
        address from,
        uint256 pullAmount,
        uint256 approveAmount,
        IConditionalOrder.ConditionalOrderParams calldata params
    ) external {
        // (1) Pull the sell token from the user into the Safe (allowance model):
        //     the user approved this CREATE2 address; here msg.sender ==
        //     address(this) == the Safe == that approved spender. The guard is
        //     defensive — the app always passes pullAmount == n * partSellAmount.
        if (pullAmount > 0) {
            sellToken.safeTransferFrom(from, address(this), pullAmount);
        }

        // (2) Self-call into the ExtensibleFallbackHandler. address(this) is the
        //     Safe, so msg.sender as seen by the handler is the Safe -> satisfies
        //     `onlySelf`. Routes GPv2 ERC-1271 signature checks to ComposableCoW.
        ISignatureVerifierMuxer(address(this)).setDomainVerifier(
            COMPOSABLE_COW.domainSeparator(), ISafeSignatureVerifier(address(COMPOSABLE_COW))
        );

        // (3) Let the settlement contract pull the sell token at execution time.
        sellToken.forceApprove(VAULT_RELAYER, approveAmount);

        // (4) Register the order and stamp the start time into the cabinet.
        //     With params.staticInput's t0 == 0, the TWAP handler reads the start
        //     time from cabinet[safe][hash(params)] -> "start now".
        COMPOSABLE_COW.createWithContext(params, CURRENT_BLOCK_TIMESTAMP_FACTORY, "", true);

        emit TwapSafeInitialized(address(this), address(sellToken), COMPOSABLE_COW.hash(params));
    }
}
