// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {TwapSafeInitializer} from "../src/TwapSafeInitializer.sol";

/**
 * @notice Deterministically deploys the TwapSafeInitializer so it has the SAME
 *         address on every chain. Uses Foundry's CREATE2 path via the canonical
 *         deterministic-deployment proxy (0x4e59...4956C), which exists on
 *         Ethereum, Gnosis and most EVM chains.
 *
 *  Predict (no key / no RPC needed):
 *      forge script script/DeployInitializer.s.sol --sig "predict()"
 *
 *  Deploy:
 *      forge script script/DeployInitializer.s.sol --sig "run()" \
 *          --rpc-url <RPC> --broadcast --private-key $PK
 */
contract DeployInitializer is Script {
    address constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant SALT = keccak256("twap-safe-initializer.v1");

    function predictedAddress() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT, keccak256(type(TwapSafeInitializer).creationCode), DETERMINISTIC_DEPLOYER
        );
    }

    function predict() external pure {
        console2.log("TwapSafeInitializer (deterministic):", predictedAddress());
    }

    function run() external {
        address predicted = predictedAddress();
        console2.log("TwapSafeInitializer (deterministic):", predicted);

        if (predicted.code.length > 0) {
            console2.log("Already deployed; nothing to do.");
            return;
        }

        vm.startBroadcast();
        TwapSafeInitializer deployed = new TwapSafeInitializer{salt: SALT}();
        vm.stopBroadcast();

        require(address(deployed) == predicted, "address mismatch");
        console2.log("Deployed at:", address(deployed));
    }
}
