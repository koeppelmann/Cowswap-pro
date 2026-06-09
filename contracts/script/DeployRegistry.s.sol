// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {TwapDeploymentRegistry} from "../src/TwapDeploymentRegistry.sol";

/// @notice Deterministically deploy the registry (same address on every chain).
contract DeployRegistry is Script {
    address constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant SALT = keccak256("twap-deployment-registry.v1");

    function predictedAddress() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT, keccak256(type(TwapDeploymentRegistry).creationCode), DETERMINISTIC_DEPLOYER
        );
    }

    function predict() external pure {
        console2.log("TwapDeploymentRegistry (deterministic):", predictedAddress());
    }

    function run() external {
        address predicted = predictedAddress();
        console2.log("TwapDeploymentRegistry (deterministic):", predicted);
        if (predicted.code.length > 0) {
            console2.log("Already deployed.");
            return;
        }
        vm.startBroadcast();
        TwapDeploymentRegistry r = new TwapDeploymentRegistry{salt: SALT}();
        vm.stopBroadcast();
        require(address(r) == predicted, "addr mismatch");
        console2.log("Deployed at:", address(r));
    }
}
