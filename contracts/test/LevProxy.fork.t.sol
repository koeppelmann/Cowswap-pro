// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {LevProxy} from "../src/LevProxy.sol";

interface IERC20 { function balanceOf(address) external view returns (uint256); }
interface IPool { function getUserAccountData(address) external view returns (uint256, uint256, uint256, uint256, uint256, uint256); }

/// Gnosis fork test: proves the drain vector is closed and the legit post-hook
/// supplies the bought asset to REAL Aave V3. Run: GNOSIS_RPC=... forge test --match-path test/LevProxy.fork.t.sol -vv
contract LevProxyForkTest is Test {
    address constant USDCE = 0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0;
    address constant POOL = 0xb50201558B00496A145fE76f7424749556E326D8;
    address constant TRAMPOLINE = 0x01DcB88678aedD0C4cC9552B20F4718550250574;
    address owner = address(0xA11CE);
    address attacker = address(0xBAD);
    LevProxy proxy;

    function setUp() public {
        vm.createSelectFork(vm.envString("GNOSIS_RPC"));
        proxy = new LevProxy(owner);
        deal(USDCE, address(proxy), 5e6); // 5 USDC.e
    }

    function test_attackerCannotTriggerHook() public {
        vm.prank(attacker);
        vm.expectRevert(bytes("!auth"));
        proxy.supplyToAave(USDCE);
        assertEq(IERC20(USDCE).balanceOf(address(proxy)), 5e6, "funds untouched");
    }

    function test_trampolineSuppliesToRealAave() public {
        (uint256 col0,,,,,) = IPool(POOL).getUserAccountData(address(proxy));
        assertEq(col0, 0, "no collateral initially");
        vm.prank(TRAMPOLINE);
        proxy.supplyToAave(USDCE);
        assertEq(IERC20(USDCE).balanceOf(address(proxy)), 0, "USDC.e supplied out of proxy");
        (uint256 col1,,,,,) = IPool(POOL).getUserAccountData(address(proxy));
        assertGt(col1, 0, "Aave collateral created for proxy");
    }

    function test_ownerCanAlsoSupply() public {
        vm.prank(owner);
        proxy.supplyToAave(USDCE);
        (uint256 col,,,,,) = IPool(POOL).getUserAccountData(address(proxy));
        assertGt(col, 0, "owner-triggered supply works");
    }
}
