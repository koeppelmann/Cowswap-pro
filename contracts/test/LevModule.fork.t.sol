// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {LevModule} from "../src/LevModule.sol";
import {LevSafeInit} from "../src/LevSafeInit.sol";

interface IERC20 { function balanceOf(address) external view returns (uint256); function allowance(address,address) external view returns (uint256); }
interface IPool { function getUserAccountData(address) external view returns (uint256,uint256,uint256,uint256,uint256,uint256); }
interface ISafeFactory { function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address); }
interface ISafe {
    function setup(address[] calldata owners, uint256 threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver) external;
    function isOwner(address) external view returns (bool);
    function isModuleEnabled(address) external view returns (bool);
}

/// Deploys a REAL Gnosis Safe (v1.3.0) wired with LevModule and runs the full
/// open + close + EIP-1271 against live Gnosis Aave V3.
/// Run: GNOSIS_RPC=https://gnosis-rpc.publicnode.com forge test --match-path test/LevModule.fork.t.sol -vv
contract LevModuleForkTest is Test {
    address constant FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address constant SINGLETON = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E; // SafeL2 v1.3.0
    address constant POOL = 0xb50201558B00496A145fE76f7424749556E326D8;
    address constant TRAMPOLINE = 0x60Bf78233f48eC42eE3F101b9a05eC7878728006;
    address constant RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    address constant WSTETH = 0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6;
    address constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;

    LevModule module;
    address safe;
    uint256 ownerPk = 0xA11CE;
    address owner;

    function setUp() public {
        vm.createSelectFork(vm.envString("GNOSIS_RPC"));
        owner = vm.addr(ownerPk);
        module = new LevModule();
        LevSafeInit init = new LevSafeInit();
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initData = abi.encodeWithSelector(LevSafeInit.setup.selector, address(module), WXDAI, RELAYER);
        bytes memory initializer = abi.encodeWithSelector(
            ISafe.setup.selector, owners, uint256(1), address(init), initData, address(module), address(0), uint256(0), address(0)
        );
        safe = ISafeFactory(FACTORY).createProxyWithNonce(SINGLETON, initializer, 0);
    }

    function test_safe_wiring() public view {
        assertTrue(ISafe(safe).isOwner(owner), "owner set");
        assertTrue(ISafe(safe).isModuleEnabled(address(module)), "module enabled");
        assertEq(IERC20(WXDAI).allowance(safe, RELAYER), type(uint256).max, "relayer approved for sell token");
    }

    function _safeBoundHash(bytes32 hash, address boundSafe) internal view returns (bytes32) {
        bytes32 domainSep = keccak256(abi.encode(keccak256("EIP712Domain(uint256 chainId,address verifyingContract)"), block.chainid, boundSafe));
        bytes32 structHash = keccak256(abi.encode(keccak256("SafeMessage(bytes32 message)"), hash));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function test_eip1271_ownerSig() public view {
        bytes32 hash = keccak256("cow order");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, _safeBoundHash(hash, safe));
        assertEq(LevModule(safe).isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e), "safe-bound owner sig valid");
    }

    function test_eip1271_rejects_rawDigestSig() public view {
        // the OLD vulnerable form: signing the raw order digest must now be rejected
        bytes32 hash = keccak256("cow order");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, hash);
        assertEq(LevModule(safe).isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff), "raw-digest sig rejected (no EOA replay)");
    }

    function test_eip1271_rejects_otherSafeBinding() public view {
        // a signature bound to a DIFFERENT safe must not validate here (no cross-safe replay)
        bytes32 hash = keccak256("cow order");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, _safeBoundHash(hash, address(0xBEEF)));
        assertEq(LevModule(safe).isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff), "other-safe-bound sig rejected");
    }

    function test_eip1271_rejects_nonOwner() public view {
        bytes32 hash = keccak256("cow order");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, _safeBoundHash(hash, safe)); // not an owner
        assertEq(LevModule(safe).isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff), "non-owner rejected");
    }

    function test_open_then_close_via_safe() public {
        // OPEN: collateral lands in the Safe (simulating the CoW buy), trampoline calls openLeg
        deal(WSTETH, safe, 8e14);
        vm.prank(TRAMPOLINE);
        (bool ok,) = safe.call(abi.encodeWithSelector(LevModule.openLeg.selector, WSTETH, WXDAI, uint256(1e18), uint256(2e18)));
        require(ok, "openLeg failed");
        (uint256 col0, uint256 debt0,,,,) = IPool(POOL).getUserAccountData(safe);
        assertGt(col0, 0, "collateral created"); assertGt(debt0, 0, "debt created");

        // CLOSE pre: flash loan delivers WXDAI -> repay all + withdraw all (max,max)
        deal(WXDAI, safe, 12e17);
        vm.prank(TRAMPOLINE);
        (ok,) = safe.call(abi.encodeWithSelector(LevModule.reducePrepare.selector, WSTETH, WXDAI, type(uint256).max, type(uint256).max));
        require(ok, "reducePrepare(max) failed");
        (uint256 col1, uint256 debt1,,,,) = IPool(POOL).getUserAccountData(safe);
        assertEq(debt1, 0, "debt repaid"); assertEq(col1, 0, "collateral withdrawn");
        assertGt(IERC20(WSTETH).balanceOf(safe), 0, "collateral liquid in safe");

        // simulate CoW swap: collateral sold -> safe receives WXDAI proceeds
        deal(WSTETH, safe, 0);
        uint256 keep = IERC20(WXDAI).balanceOf(safe);
        deal(WXDAI, safe, keep + 2e18);

        // CLOSE post: keep repayApprove, forward rest to the SAFE OWNER (never a caller-supplied addr)
        vm.prank(TRAMPOLINE);
        (ok,) = safe.call(abi.encodeWithSelector(LevModule.closeFinalize.selector, WSTETH, WXDAI, uint256(1201e15)));
        require(ok, "closeFinalize failed");
        assertGe(IERC20(WXDAI).allowance(safe, POOL), 1201e15, "pool approved for flashloan pull");
        assertGt(IERC20(WXDAI).balanceOf(owner), 0, "equity forwarded to the SAFE OWNER");
        emit log_named_uint("owner WXDAI", IERC20(WXDAI).balanceOf(owner));
    }

    function test_closeFinalize_alwaysPaysOwner_notCaller() public {
        // even when an attacker triggers the hook via the shared trampoline, funds go to the owner
        deal(WXDAI, safe, 5e18);
        uint256 ownerBefore = IERC20(WXDAI).balanceOf(owner);
        vm.prank(TRAMPOLINE); // anyone can make the trampoline call any target
        (bool ok,) = safe.call(abi.encodeWithSelector(LevModule.closeFinalize.selector, WSTETH, WXDAI, uint256(0)));
        require(ok, "closeFinalize");
        assertEq(IERC20(WXDAI).balanceOf(safe), 0, "safe liquid swept");
        assertEq(IERC20(WXDAI).balanceOf(owner) - ownerBefore, 5e18, "all swept to OWNER, not the caller");
    }

    function test_partial_reduce_keeps_position() public {
        // open ~$2 collateral / ~$1 debt
        deal(WSTETH, safe, 8e14);
        vm.prank(TRAMPOLINE);
        (bool ok,) = safe.call(abi.encodeWithSelector(LevModule.openLeg.selector, WSTETH, WXDAI, uint256(1e18), uint256(2e18)));
        require(ok, "open failed");
        (uint256 col0, uint256 debt0,,,,) = IPool(POOL).getUserAccountData(safe);

        // partial reduce: flash-borrow ~0.5 WXDAI, repay 0.5 debt, withdraw half the collateral
        deal(WXDAI, safe, 6e17);
        vm.prank(TRAMPOLINE);
        (ok,) = safe.call(abi.encodeWithSelector(LevModule.reducePrepare.selector, WSTETH, WXDAI, uint256(5e17), uint256(4e14)));
        require(ok, "partial reducePrepare failed");
        (uint256 col1, uint256 debt1,,,,) = IPool(POOL).getUserAccountData(safe);
        assertGt(debt1, 0, "position still has debt (open)");
        assertGt(col1, 0, "position still has collateral (open)");
        assertLt(debt1, debt0, "debt reduced");
        assertLt(col1, col0, "collateral reduced");
        assertGt(IERC20(WSTETH).balanceOf(safe), 0, "withdrawn collateral now liquid (to sell)");
        emit log_named_uint("debt before", debt0); emit log_named_uint("debt after", debt1);
        emit log_named_uint("col before", col0); emit log_named_uint("col after", col1);
    }

    function test_increase_leverage() public {
        // open
        deal(WSTETH, safe, 8e14);
        vm.prank(TRAMPOLINE);
        (bool ok,) = safe.call(abi.encodeWithSelector(LevModule.openLeg.selector, WSTETH, WXDAI, uint256(1e18), uint256(2e18)));
        require(ok, "open failed");
        (uint256 col0, uint256 debt0,,,,) = IPool(POOL).getUserAccountData(safe);
        // increase: more collateral bought lands in the safe, supply it + borrow more
        deal(WSTETH, safe, 4e14);
        vm.prank(TRAMPOLINE);
        (ok,) = safe.call(abi.encodeWithSelector(LevModule.openLeg.selector, WSTETH, WXDAI, uint256(5e17), uint256(6e17)));
        require(ok, "increase failed");
        (uint256 col1, uint256 debt1,,,,) = IPool(POOL).getUserAccountData(safe);
        assertGt(col1, col0, "collateral increased");
        assertGt(debt1, debt0, "debt increased");
    }

    function test_attacker_cannot_call_hooks() public {
        deal(WSTETH, safe, 8e14);
        vm.prank(address(0xBAD));
        (bool ok,) = safe.call(abi.encodeWithSelector(LevModule.openLeg.selector, WSTETH, WXDAI, uint256(1e18), uint256(2e18)));
        assertFalse(ok, "non-trampoline/non-owner blocked");
    }
}
