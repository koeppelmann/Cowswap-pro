// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {TwapOrderLens} from "../src/TwapOrderLens.sol";

contract DeployLens is Script {
    address constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant SALT = keccak256("twap-order-lens.v1");

    function predictedAddress() public pure returns (address) {
        return vm.computeCreate2Address(SALT, keccak256(type(TwapOrderLens).creationCode), DETERMINISTIC_DEPLOYER);
    }

    function predict() external pure { console2.log("TwapOrderLens:", predictedAddress()); }

    function run() external {
        address predicted = predictedAddress();
        console2.log("TwapOrderLens:", predicted);
        if (predicted.code.length > 0) { console2.log("Already deployed."); return; }
        vm.startBroadcast();
        TwapOrderLens l = new TwapOrderLens{salt: SALT}();
        vm.stopBroadcast();
        require(address(l) == predicted, "addr mismatch");
        console2.log("Deployed at:", address(l));
    }
}
