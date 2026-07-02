// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {BridgeInitializer} from "../src/BridgeInitializer.sol";
import {ConvertModule} from "../src/ConvertModule.sol";
import {SdaiSafeInitializer} from "../src/SdaiSafeInitializer.sol";
import {ReturnRouter} from "../src/ReturnRouter.sol";
import {SdaiFinalizeHelper} from "../src/SdaiFinalizeHelper.sol";

/**
 * @notice Deterministic (CREATE2) deployment of the "swap → sDAI on Gnosis"
 *         contracts, so each has the SAME address on every chain via the canonical
 *         deterministic-deployment proxy (0x4e59...4956C).
 *
 *   Deploy targets:
 *     - BridgeInitializer   -> Ethereum mainnet (forward: Safe setup bridges USDS)
 *     - ConvertModule       -> Gnosis Chain     (finalize: xDAI -> sDAI + tip)
 *     - SdaiSafeInitializer -> Gnosis Chain     (Safe setup enables ConvertModule)
 *     - ReturnRouter        -> Gnosis Chain     (reverse: sDAI -> mainnet USDS)
 *
 *   Predict (no key / no RPC):
 *     forge script script/DeploySdaiBridge.s.sol --sig "predict()"
 *
 *   Deploy mainnet piece:
 *     forge script script/DeploySdaiBridge.s.sol --sig "runMainnet()" --rpc-url $ETH --broadcast --private-key $PK
 *   Deploy Gnosis pieces:
 *     forge script script/DeploySdaiBridge.s.sol --sig "runGnosis()" --rpc-url $GNO --broadcast --private-key $PK
 */
contract DeploySdaiBridge is Script {
    address constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    bytes32 constant SALT_BRIDGE_INIT = keccak256("sdai.bridge-initializer.v1");
    bytes32 constant SALT_CONVERT_MODULE = keccak256("sdai.convert-module.v3");
    bytes32 constant SALT_SAFE_INIT = keccak256("sdai.safe-initializer.v1");
    bytes32 constant SALT_RETURN_ROUTER = keccak256("sdai.return-router.v2");
    bytes32 constant SALT_FINALIZE_HELPER = keccak256("sdai.finalize-helper.v3");

    function bridgeInitializerAddress() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT_BRIDGE_INIT, keccak256(type(BridgeInitializer).creationCode), DETERMINISTIC_DEPLOYER
        );
    }

    function convertModuleAddress() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT_CONVERT_MODULE, keccak256(type(ConvertModule).creationCode), DETERMINISTIC_DEPLOYER
        );
    }

    function safeInitializerAddress() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT_SAFE_INIT, keccak256(type(SdaiSafeInitializer).creationCode), DETERMINISTIC_DEPLOYER
        );
    }

    function returnRouterAddress() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT_RETURN_ROUTER, keccak256(type(ReturnRouter).creationCode), DETERMINISTIC_DEPLOYER
        );
    }

    function finalizeHelperAddress() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT_FINALIZE_HELPER, keccak256(type(SdaiFinalizeHelper).creationCode), DETERMINISTIC_DEPLOYER
        );
    }

    function predict() external pure {
        console2.log("BridgeInitializer  (mainnet):", bridgeInitializerAddress());
        console2.log("ConvertModule      (gnosis) :", convertModuleAddress());
        console2.log("SdaiSafeInitializer(gnosis) :", safeInitializerAddress());
        console2.log("ReturnRouter       (gnosis) :", returnRouterAddress());
        console2.log("SdaiFinalizeHelper (gnosis) :", finalizeHelperAddress());
    }

    function runMainnet() external {
        vm.startBroadcast();
        if (bridgeInitializerAddress().code.length == 0) {
            BridgeInitializer d = new BridgeInitializer{salt: SALT_BRIDGE_INIT}();
            require(address(d) == bridgeInitializerAddress(), "bridgeInit addr");
            console2.log("BridgeInitializer deployed:", address(d));
        } else {
            console2.log("BridgeInitializer already deployed:", bridgeInitializerAddress());
        }
        vm.stopBroadcast();
    }

    function runGnosis() external {
        vm.startBroadcast();
        if (convertModuleAddress().code.length == 0) {
            ConvertModule m = new ConvertModule{salt: SALT_CONVERT_MODULE}();
            require(address(m) == convertModuleAddress(), "module addr");
            console2.log("ConvertModule deployed:", address(m));
        }
        if (safeInitializerAddress().code.length == 0) {
            SdaiSafeInitializer s = new SdaiSafeInitializer{salt: SALT_SAFE_INIT}();
            require(address(s) == safeInitializerAddress(), "safeInit addr");
            console2.log("SdaiSafeInitializer deployed:", address(s));
        }
        if (returnRouterAddress().code.length == 0) {
            ReturnRouter r = new ReturnRouter{salt: SALT_RETURN_ROUTER}();
            require(address(r) == returnRouterAddress(), "router addr");
            console2.log("ReturnRouter deployed:", address(r));
        }
        if (finalizeHelperAddress().code.length == 0) {
            SdaiFinalizeHelper f = new SdaiFinalizeHelper{salt: SALT_FINALIZE_HELPER}();
            require(address(f) == finalizeHelperAddress(), "helper addr");
            console2.log("SdaiFinalizeHelper deployed:", address(f));
        }
        vm.stopBroadcast();
    }
}
