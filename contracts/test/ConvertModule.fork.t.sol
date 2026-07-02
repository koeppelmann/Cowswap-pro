// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ConvertModule} from "../src/ConvertModule.sol";
import {SdaiSafeInitializer} from "../src/SdaiSafeInitializer.sol";
import {SdaiFinalizeHelper} from "../src/SdaiFinalizeHelper.sol";

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
    function isModuleEnabled(address module) external view returns (bool);
    function getOwners() external view returns (address[] memory);
}

/// @notice Gnosis-fork test of the finalize leg: a 1/1 Safe enables ConvertModule
///         at deploy; once native xDAI is bridged in, anyone calls `convert(safe)`
///         and the module deposits it into sDAI for the owner, paying the caller a
///         0.01 xDAI tip.
///
/// Run: GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test --match-contract ConvertModuleForkTest -vv
contract ConvertModuleForkTest is Test {
    ISafeProxyFactory constant FACTORY = ISafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
    address constant SAFE_L2_SINGLETON = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    IERC20 constant SDAI = IERC20(0xaf204776c7245bF4147c2612BF6e5972Ee483701);
    // Real deployed ConvertModule v3 (SdaiFinalizeHelper hardcodes this address).
    address constant CONVERT_MODULE = 0x7cE6e4fe5c6658FF3f98C417Da09E6C31c9aAae3;

    ConvertModule module;
    SdaiSafeInitializer initializer;
    address user = address(0xBEEF);
    address keeper = address(0xC0FFEE);

    function setUp() public {
        try vm.envString("GNOSIS_RPC_URL") returns (string memory url) {
            vm.createSelectFork(url);
        } catch {
            try vm.activeFork() returns (uint256) {} catch {
                vm.skip(true);
            }
        }
        module = new ConvertModule();
        initializer = new SdaiSafeInitializer();
    }

    function _predict(bytes memory initData, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initData), saltNonce));
        bytes memory deploymentData =
            abi.encodePacked(FACTORY.proxyCreationCode(), uint256(uint160(SAFE_L2_SINGLETON)));
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(FACTORY), salt, keccak256(deploymentData)));
        return address(uint160(uint256(h)));
    }

    function _deploySafe() internal returns (address safe) {
        bytes memory initData = abi.encodeCall(SdaiSafeInitializer.initialize, (address(module)));
        address[] memory owners = new address[](1);
        owners[0] = user;
        bytes memory setupCalldata = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), address(initializer), initData, address(0), address(0), uint256(0), address(0)
        );
        address predicted = _predict(setupCalldata, 0);
        safe = FACTORY.createProxyWithNonce(SAFE_L2_SINGLETON, setupCalldata, 0);
        assertEq(safe, predicted, "predicted == deployed");
    }

    function testConvertMintsSdaiToOwnerAndTipsCaller() public {
        address safe = _deploySafe();
        assertTrue(ISafeSetup(safe).isModuleEnabled(address(module)), "module enabled at deploy");

        // Bridge credits native xDAI to the counterfactual/deployed Safe.
        uint256 bridged = 100 ether;
        vm.deal(safe, bridged);

        // Use balance deltas — these addresses may carry pre-existing state on the fork.
        uint256 sdaiBefore = SDAI.balanceOf(user);
        uint256 keeperBefore = keeper.balance;

        vm.prank(keeper);
        module.convert(safe);

        assertGt(SDAI.balanceOf(user) - sdaiBefore, 0, "owner received sDAI");
        assertEq(keeper.balance - keeperBefore, module.TIP(), "keeper got exactly the 0.01 xDAI tip");
        assertEq(safe.balance, 0, "safe fully drained");
    }

    function testConvertRevertsBelowTip() public {
        address safe = _deploySafe();
        vm.deal(safe, module.TIP()); // == TIP, not > TIP
        vm.prank(keeper);
        vm.expectRevert(bytes("nothing to convert"));
        module.convert(safe);
    }

    function testConvertGivesGasStipendToGaslessOwner() public {
        address safe = _deploySafe();
        vm.deal(safe, 100 ether);
        vm.deal(user, 0); // owner arrived cross-chain with zero xDAI
        uint256 sdaiBefore = SDAI.balanceOf(user);
        vm.prank(keeper);
        module.convert(safe);
        assertEq(user.balance, module.GAS_STIPEND(), "gasless owner topped up with stipend");
        assertGt(SDAI.balanceOf(user) - sdaiBefore, 0, "owner still receives sDAI");
    }

    function testConvertSkipsStipendWhenOwnerHasGas() public {
        address safe = _deploySafe();
        vm.deal(safe, 100 ether);
        vm.deal(user, 1 ether); // owner already has gas → no stipend
        vm.prank(keeper);
        module.convert(safe);
        assertEq(user.balance, 1 ether, "no stipend when owner already funded");
    }

    function testFinalizeHelperAtomicDeployConvertAndTip() public {
        // Uses the REAL deployed ConvertModule (the helper hardcodes its address),
        // which exists on the Gnosis fork.
        bytes memory initData = abi.encodeCall(SdaiSafeInitializer.initialize, (CONVERT_MODULE));
        address[] memory owners = new address[](1);
        owners[0] = user;
        bytes memory setupCalldata = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), address(initializer), initData, address(0), address(0), uint256(0), address(0)
        );
        uint256 saltNonce = 42;
        address predicted = _predict(setupCalldata, saltNonce);

        // Bridge credits native xDAI to the still-counterfactual Safe.
        vm.deal(predicted, 100 ether);
        assertEq(predicted.code.length, 0, "undeployed before finalize");

        SdaiFinalizeHelper helper = new SdaiFinalizeHelper();
        uint256 sdaiBefore = SDAI.balanceOf(user);
        uint256 keeperBefore = keeper.balance;

        // ONE call: deploy + convert + tip forwarded to the caller.
        vm.prank(keeper);
        address safe = helper.finalize(SAFE_L2_SINGLETON, setupCalldata, saltNonce);

        assertEq(safe, predicted, "deployed at predicted address");
        assertGt(safe.code.length, 0, "safe deployed in the same tx");
        assertGt(SDAI.balanceOf(user) - sdaiBefore, 0, "owner received sDAI");
        assertEq(keeper.balance - keeperBefore, 0.01 ether, "keeper got the tip forwarded");
        assertEq(address(helper).balance, 0, "helper swept clean");
        assertEq(safe.balance, 0, "safe drained");
    }

    function testConvertRevertsIfModuleNotEnabled() public {
        // A fresh Safe with no module enabled (use the initializer with a different module addr).
        address[] memory owners = new address[](1);
        owners[0] = user;
        bytes memory setupCalldata = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), address(0), bytes(""), address(0), address(0), uint256(0), address(0)
        );
        address bareSafe = FACTORY.createProxyWithNonce(SAFE_L2_SINGLETON, setupCalldata, 1);
        vm.deal(bareSafe, 50 ether);
        vm.expectRevert(bytes("module disabled"));
        module.convert(bareSafe);
    }
}
