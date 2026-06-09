// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TwapSafeInitializer} from "../src/TwapSafeInitializer.sol";
import {Twap} from "../src/libraries/Twap.sol";
import {IConditionalOrder} from "../src/interfaces/ICoW.sol";

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;
}

/**
 * @notice Emits a deterministic test vector (fixed inputs) so the TypeScript SDK
 *         can be cross-checked byte-for-byte against the Solidity encoding that
 *         is already proven correct on-chain by the fork test.
 *
 *  forge script script/Vector.s.sol --sig "vector()"
 */
contract Vector is Script {
    // Fixed inputs mirrored in web/src/lib/*.test.ts
    address constant USER = 0x000000000000000000000000000000000000bEEF;
    address constant HELPER = 0x3afA7DB0BEC365b4CF169A3556acDDe6653d0E18;
    address constant FALLBACK_HANDLER = 0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5;
    address constant FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address constant SINGLETON = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    IERC20 constant WXDAI = IERC20(0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d);
    IERC20 constant USDC = IERC20(0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83);

    function _twap() internal pure returns (Twap.Data memory) {
        return Twap.Data({
            sellToken: WXDAI,
            buyToken: USDC,
            receiver: address(0),
            partSellAmount: 100e18,
            minPartLimit: 95e6,
            t0: 0,
            n: 5,
            t: 3600,
            span: 0,
            appData: bytes32(0)
        });
    }

    function vector() external view {
        Twap.Data memory twap = _twap();
        uint256 approveAmount = twap.partSellAmount * twap.n;
        IConditionalOrder.ConditionalOrderParams memory params = Twap.toParams(twap, bytes32(0));

        bytes memory staticInput = params.staticInput;
        bytes memory initData =
            abi.encodeCall(TwapSafeInitializer.initialize, (WXDAI, USER, approveAmount, approveAmount, params));

        address[] memory owners = new address[](1);
        owners[0] = USER;
        bytes memory initializerCalldata = abi.encodeWithSelector(
            ISafeSetup.setup.selector,
            owners,
            uint256(1),
            HELPER,
            initData,
            FALLBACK_HANDLER,
            address(0),
            uint256(0),
            address(0)
        );

        uint256 saltNonce = 0;
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializerCalldata), saltNonce));
        bytes memory proxyCreationCode = vm.parseBytes(vm.readFile("test/fixtures/proxyCreationCode.hex"));
        bytes memory deploymentData = abi.encodePacked(proxyCreationCode, uint256(uint160(SINGLETON)));
        address predicted =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, salt, keccak256(deploymentData))))));

        console2.log("staticInput keccak   :", vm.toString(keccak256(staticInput)));
        console2.log("initData keccak      :", vm.toString(keccak256(initData)));
        console2.log("initializer keccak   :", vm.toString(keccak256(initializerCalldata)));
        console2.log("predicted address    :", predicted);
    }
}
