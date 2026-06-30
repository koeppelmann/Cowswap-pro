// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IComposableCoW, IConditionalOrder, ISignatureVerifierMuxer, ISafeSignatureVerifier
} from "./interfaces/ICoW.sol";

/// @title BarnTwapInitializer — TwapSafeInitializer re-parameterized for CoW's Gnosis STAGING (barn)
/// settlement, with a fixed-t0 conditional order (plain `create`, no cabinet) so part validity is
/// known at submission time. Same delegatecall-from-setup pattern; resolves the Safe's own address
/// at runtime via address(this), which is what breaks the address<->initializer circularity.
contract BarnTwapInitializer {
    using SafeERC20 for IERC20;

    IComposableCoW public constant COMPOSABLE_COW = IComposableCoW(0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74);
    address public constant VAULT_RELAYER = 0xC7242d167563352E2BCA4d71C043fbe542DB8FB2; // barn
    bytes32 public constant BARN_DOMAIN = 0x6cd10bb2764eecd37db627a2f5525b0dc0dacc9cf7898bcac7ef4ae8529d12a9;

    event BarnSafeInitialized(address indexed safe, address indexed sellToken, bytes32 orderHash);

    function initialize(
        IERC20 sellToken,
        address from,
        uint256 pullAmount,
        uint256 approveAmount,
        IConditionalOrder.ConditionalOrderParams calldata params
    ) external {
        if (pullAmount > 0) {
            sellToken.safeTransferFrom(from, address(this), pullAmount);
        }
        ISignatureVerifierMuxer(address(this)).setDomainVerifier(
            BARN_DOMAIN, ISafeSignatureVerifier(address(COMPOSABLE_COW))
        );
        sellToken.forceApprove(VAULT_RELAYER, approveAmount);
        COMPOSABLE_COW.create(params, true); // fixed t0 in staticInput — no cabinet context needed
        emit BarnSafeInitialized(address(this), address(sellToken), COMPOSABLE_COW.hash(params));
    }
}
