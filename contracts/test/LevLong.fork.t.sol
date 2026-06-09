// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {LevLong} from "../src/LevLong.sol";

interface IERC20 { function balanceOf(address) external view returns (uint256); function allowance(address,address) external view returns (uint256); }
interface IPool { function getUserAccountData(address) external view returns (uint256,uint256,uint256,uint256,uint256,uint256); }

/// Fork test: prove openLeg supplies bought collateral + borrows debt + approves the
/// pool for repayment against REAL Gnosis Aave V3. Run:
/// GNOSIS_RPC=https://gnosis-rpc.publicnode.com forge test --match-path test/LevLong.fork.t.sol -vv
contract LevLongForkTest is Test {
    address constant WSTETH = 0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6; // collateral
    address constant WXDAI  = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // debt/stable
    address constant POOL   = 0xb50201558B00496A145fE76f7424749556E326D8;
    address constant TRAMPOLINE = 0x60Bf78233f48eC42eE3F101b9a05eC7878728006;
    address owner = address(0xA11CE);
    address attacker = address(0xBAD);
    LevLong inst;

    function setUp() public {
        vm.createSelectFork(vm.envString("GNOSIS_RPC"));
        inst = new LevLong(owner);
        // simulate: CoW trade just delivered ~0.0015 wstETH collateral to the instance
        deal(WSTETH, address(inst), 15e14);
    }

    function test_setup_approvesRelayerAndHash() public {
        address RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
        bytes32 h = keccak256("order");
        vm.prank(owner);
        inst.setup(WXDAI, h);
        assertEq(IERC20(WXDAI).allowance(address(inst), RELAYER), type(uint256).max, "relayer approved");
        assertTrue(inst.approvedHashes(h), "order hash approved");
        assertEq(inst.isValidSignature(h, ""), bytes4(0x1626ba7e), "eip1271 valid");
    }

    function test_2x_openLeg_healthy() public {
        // simulate the 2x flow's post-hook: ~$2-worth WETH supplied, ~$1 borrowed
        deal(WSTETH, address(inst), 0); // ensure clean
        // give the instance ~0.0005 WETH-equivalent collateral via wstETH proxy for the ratio check
        deal(WSTETH, address(inst), 8e14);
        vm.prank(TRAMPOLINE);
        inst.openLeg(WSTETH, WXDAI, 8e17, 16e17); // borrow ~0.8, approve ~1.6
        (uint256 col, uint256 debt,,,, uint256 hf) = IPool(POOL).getUserAccountData(address(inst));
        assertGt(col, 0); assertGt(debt, 0);
        assertGt(hf, 1e18, "health factor > 1");
        emit log_named_uint("collateralBase", col);
        emit log_named_uint("debtBase", debt);
        emit log_named_uint("healthFactor(1e18)", hf);
    }

    function test_open_then_close_roundtrip() public {
        // OPEN: supply ~$2 WETH-equiv collateral (use wstETH reserve) + borrow ~1 WXDAI
        deal(WSTETH, address(inst), 8e14);
        vm.prank(TRAMPOLINE);
        inst.openLeg(WSTETH, WXDAI, 1e18, 2e18); // borrow 1 WXDAI
        (uint256 col0, uint256 debt0,,,,) = IPool(POOL).getUserAccountData(address(inst));
        assertGt(col0, 0); assertGt(debt0, 0);

        // CLOSE step 1 (pre-hook): flash loan delivers WXDAI -> repay all debt + withdraw all collateral
        deal(WXDAI, address(inst), 12e17); // simulate flash-borrow of ~1.2 WXDAI
        vm.prank(TRAMPOLINE);
        inst.closePrepare(WSTETH, WXDAI);
        (uint256 col1, uint256 debt1,,,,) = IPool(POOL).getUserAccountData(address(inst));
        assertEq(debt1, 0, "debt fully repaid");
        assertEq(col1, 0, "collateral fully withdrawn");
        assertGt(IERC20(WSTETH).balanceOf(address(inst)), 0, "collateral now liquid in instance");

        // simulate the CoW swap: collateral sold -> instance receives WXDAI proceeds (~$2 worth)
        deal(WSTETH, address(inst), 0);
        uint256 leftoverWxdaiFromLoan = IERC20(WXDAI).balanceOf(address(inst)); // loan minus repaid debt
        deal(WXDAI, address(inst), leftoverWxdaiFromLoan + 2e18); // + ~2 WXDAI sale proceeds

        // CLOSE step 2 (post-hook): keep repayApprove for Aave, send rest to user
        address user = address(0xBEEF);
        uint256 repayApprove = 1201e15; // loan 1.2 + premium buffer
        vm.prank(TRAMPOLINE);
        inst.closeFinalize(WSTETH, WXDAI, repayApprove, user);
        assertGe(IERC20(WXDAI).balanceOf(address(inst)), repayApprove, "repayApprove retained for flashloan pull");
        assertGt(IERC20(WXDAI).balanceOf(user), 0, "equity forwarded to user");
        emit log_named_uint("user received WXDAI", IERC20(WXDAI).balanceOf(user));
    }

    function test_attackerCannotOpenLeg() public {
        vm.prank(attacker);
        vm.expectRevert(bytes("!auth"));
        inst.openLeg(WSTETH, WXDAI, 1e17, 5e18);
    }

    function test_trampolineOpensLeg() public {
        (uint256 col0,,,,,) = IPool(POOL).getUserAccountData(address(inst));
        assertEq(col0, 0, "no collateral initially");
        // supply the wstETH, borrow 0.5 WXDAI, approve pool 5.01 WXDAI for flashloan pull
        vm.prank(TRAMPOLINE);
        inst.openLeg(WSTETH, WXDAI, 5e17, 501e16);
        (uint256 col1, uint256 debt1,,,,) = IPool(POOL).getUserAccountData(address(inst));
        assertGt(col1, 0, "collateral created");
        assertGt(debt1, 0, "debt created");
        assertEq(IERC20(WSTETH).balanceOf(address(inst)), 0, "wstETH supplied out");
        assertGt(IERC20(WXDAI).balanceOf(address(inst)), 0, "borrowed WXDAI present for repayment");
        emit log_named_uint("collateralBase", col1);
        emit log_named_uint("debtBase", debt1);
        emit log_named_uint("WXDAI held (to repay loan)", IERC20(WXDAI).balanceOf(address(inst)));
    }
}
