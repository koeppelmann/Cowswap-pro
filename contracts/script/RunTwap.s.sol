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

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address);
    function proxyCreationCode() external view returns (bytes memory);
}

/// @notice End-to-end: build an hourly TWAP, approve the predicted Safe, deploy it
///         which atomically registers the order. Run with the deployer key.
contract RunTwap is Script {
    address constant TWAP_INIT = 0x3afA7DB0BEC365b4CF169A3556acDDe6653d0E18;
    address constant FALLBACK = 0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5;
    ISafeProxyFactory constant FACTORY = ISafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
    address constant SINGLETON = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E; // SafeL2 1.3.0
    IERC20 constant EURE = IERC20(0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430);
    address constant GNO = 0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb;

    function run() external {
        uint256 pk = vm.envUint("PK");
        address owner = vm.addr(pk);

        Twap.Data memory d = Twap.Data({
            sellToken: EURE,
            buyToken: IERC20(GNO),
            receiver: owner, // non-zero -> not banned by the autopilot
            partSellAmount: 2.5 ether, // 2.5 EURe per part
            minPartLimit: 0.030 ether, // >= 0.030 GNO/part (market ~0.0319, ~6% buffer)
            t0: 0, // start now (cabinet)
            n: 2,
            t: 3600, // HOURLY
            span: 0,
            appData: bytes32(0)
        });
        uint256 total = d.partSellAmount * d.n; // 5 EURe
        IConditionalOrder.ConditionalOrderParams memory params = Twap.toParams(d, bytes32(0));

        bytes memory initData =
            abi.encodeCall(TwapSafeInitializer.initialize, (EURE, owner, total, total, params));
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), TWAP_INIT, initData, FALLBACK, address(0), uint256(0), address(0)
        );

        address predicted = _predict(initializer, 0);
        console2.log("owner/receiver:", owner);
        console2.log("predicted Safe:", predicted);

        vm.startBroadcast(pk);
        EURE.approve(predicted, total); // allowance model — deploy pulls via transferFrom
        address proxy = FACTORY.createProxyWithNonce(SINGLETON, initializer, 0);
        vm.stopBroadcast();

        require(proxy == predicted, "addr mismatch");
        console2.log("deployed Safe :", proxy);
    }

    function _predict(bytes memory initializer, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        bytes memory dep = abi.encodePacked(FACTORY.proxyCreationCode(), uint256(uint160(SINGLETON)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(FACTORY), salt, keccak256(dep))))));
    }
}
