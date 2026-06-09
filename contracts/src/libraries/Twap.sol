// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IConditionalOrder} from "../interfaces/ICoW.sol";

/**
 * @title Twap
 * @notice Helpers for building CoW Protocol TWAP conditional orders, mirroring
 *         `TWAPOrder.Data` from cowprotocol/composable-cow.
 */
library Twap {
    /// @dev Canonical TWAP handler, identical across all supported chains.
    address internal constant HANDLER = 0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5;

    /// @dev Mirrors `TWAPOrder.Data`. The handler decodes `staticInput` into this.
    struct Data {
        IERC20 sellToken;
        IERC20 buyToken;
        address receiver; // address(0) -> the Safe itself
        uint256 partSellAmount; // sellToken sold per part
        uint256 minPartLimit; // min buyToken received per part (limit price)
        uint256 t0; // start time; 0 -> read "now" from the cabinet
        uint256 n; // number of parts (must be > 1)
        uint256 t; // seconds per part (0 < t <= 365 days)
        uint256 span; // tradeable window within each part; 0 -> whole part
        bytes32 appData;
    }

    /// @dev Wrap a TWAP `Data` into ComposableCoW `ConditionalOrderParams`.
    function toParams(Data memory data, bytes32 salt)
        internal
        pure
        returns (IConditionalOrder.ConditionalOrderParams memory)
    {
        return IConditionalOrder.ConditionalOrderParams({
            handler: HANDLER,
            salt: salt,
            staticInput: abi.encode(data)
        });
    }
}
