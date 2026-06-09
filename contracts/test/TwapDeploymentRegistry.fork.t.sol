// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TwapDeploymentRegistry} from "../src/TwapDeploymentRegistry.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address);
}

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

/// @notice Proves the registry's recovery guarantee on a real Gnosis fork: the
///         address it records in `Registered` (and returns from `predict`) is
///         exactly where the Safe actually deploys — so a funded address can
///         always be deployed from the logged initializer.
///
/// Run: GNOSIS_RPC_URL=... forge test --match-contract RegistryFork -vv
contract TwapDeploymentRegistryForkTest is Test {
    ISafeProxyFactory constant FACTORY = ISafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
    address constant SAFE_L2_SINGLETON = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;

    TwapDeploymentRegistry registry;

    function setUp() public {
        try vm.envString("GNOSIS_RPC_URL") returns (string memory url) {
            vm.createSelectFork(url);
        } catch {
            try vm.activeFork() returns (uint256) {} catch {
                vm.skip(true);
            }
        }
        registry = new TwapDeploymentRegistry();
    }

    function testRegisteredAddressMatchesDeployment() public {
        address[] memory owners = new address[](1);
        owners[0] = address(0xBEEF);
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector,
            owners,
            uint256(1),
            address(0),
            bytes(""),
            address(0),
            address(0),
            uint256(0),
            address(0)
        );
        uint256 saltNonce = 42;

        // What the registry records (and would emit) for recovery.
        address predicted = registry.predict(SAFE_L2_SINGLETON, saltNonce, initializer);
        address registered = registry.register(SAFE_L2_SINGLETON, saltNonce, initializer);
        assertEq(registered, predicted, "register == predict");

        // Recovery path: deploy from exactly the recorded data.
        address proxy = FACTORY.createProxyWithNonce(SAFE_L2_SINGLETON, initializer, saltNonce);
        assertEq(proxy, predicted, "recovered deployment lands at the funded address");
    }
}
