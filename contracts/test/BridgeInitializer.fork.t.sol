// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BridgeInitializer} from "../src/BridgeInitializer.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function proxyCreationCode() external view returns (bytes memory);
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
    function isOwner(address owner) external view returns (bool);
    function getThreshold() external view returns (uint256);
}

/// @notice Mainnet-fork test of the forward leg: the CoW swap delivers USDS to a
///         counterfactual 1/1 Safe; deploying that Safe runs BridgeInitializer,
///         which approves the native xDAI bridge and `relayTokens` the whole USDS
///         balance to the committed Gnosis receiver.
///
/// Run: MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --match-contract BridgeInitializerForkTest -vv
contract BridgeInitializerForkTest is Test {
    // canonical Safe deployments (identical address on every chain)
    ISafeProxyFactory constant FACTORY = ISafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
    // Safe v1.3.0 L1 singleton (mainnet convention, matches web chains.ts)
    address constant SAFE_L1_SINGLETON = 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552;

    IERC20 constant USDS = IERC20(0xdC035D45d973E3EC169d2276DDab16f1e407384F);
    address constant FOREIGN_BRIDGE = 0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016;

    BridgeInitializer initializer;
    address user = address(0xBEEF);
    address gnosisReceiver = address(0x1234567890123456789012345678901234567890);

    function setUp() public {
        try vm.envString("MAINNET_RPC_URL") returns (string memory url) {
            vm.createSelectFork(url);
        } catch {
            vm.skip(true);
        }
        initializer = new BridgeInitializer();
    }

    function _predict(bytes memory initData, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initData), saltNonce));
        bytes memory deploymentData =
            abi.encodePacked(FACTORY.proxyCreationCode(), uint256(uint160(SAFE_L1_SINGLETON)));
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(FACTORY), salt, keccak256(deploymentData)));
        return address(uint160(uint256(h)));
    }

    function testDeployBridgesUsdsToGnosisReceiver() public {
        uint256 amount = 100e18;

        bytes memory initData = abi.encodeCall(BridgeInitializer.initialize, (gnosisReceiver));
        address[] memory owners = new address[](1);
        owners[0] = user;
        bytes memory setupCalldata = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), address(initializer), initData, address(0), address(0), uint256(0), address(0)
        );

        uint256 saltNonce = 0;
        address predicted = _predict(setupCalldata, saltNonce);

        // The CoW swap delivers USDS to the counterfactual Safe address (still undeployed).
        deal(address(USDS), predicted, amount);
        assertEq(predicted.code.length, 0, "undeployed before");
        assertEq(USDS.balanceOf(predicted), amount, "USDS delivered to counterfactual safe");

        uint256 bridgeBefore = USDS.balanceOf(FOREIGN_BRIDGE);

        // Anyone (here: the CoW post-hook / a keeper) deploys the Safe.
        address proxy = FACTORY.createProxyWithNonce(SAFE_L1_SINGLETON, setupCalldata, saltNonce);

        assertEq(proxy, predicted, "predicted == deployed");
        assertTrue(ISafeSetup(proxy).isOwner(user), "user owns the safe");
        assertEq(ISafeSetup(proxy).getThreshold(), 1, "1/1 safe");

        // BridgeInitializer bridged the entire USDS balance on deploy.
        assertEq(USDS.balanceOf(proxy), 0, "all USDS bridged out of the safe");
        assertEq(USDS.balanceOf(FOREIGN_BRIDGE) - bridgeBefore, amount, "bridge locked the USDS 1:1");
    }
}
