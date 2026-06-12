// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {Test} from "forge-std/Test.sol";
interface IERC20T { function balanceOf(address) external view returns (uint256); function approve(address,uint256) external returns (bool); }
interface IPoolT {
    function supply(address,uint256,address,uint16) external;
    function borrow(address,uint256,uint256,uint16,address) external;
    function setUserEMode(uint8) external;
    function setUserUseReserveAsCollateral(address,bool) external;
}
/// Empirical Aave-3.3 semantics this app depends on: inside an eMode category the category's
/// BORROWABLE BITMAP overrides the reserve's global borrowing flag (WETH: borrowEnabled=false,
/// yet borrowable in cat 1); outside the category the global flag rules; assets not in the
/// bitmap stay unborrowable inside it.
contract EModeBorrowSemantics is Test {
    address constant POOL = 0xb50201558B00496A145fE76f7424749556E326D8;
    address constant WSTETH = 0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6;
    address constant WETH = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;
    function setUp() public { vm.createSelectFork("https://rpc.gnosischain.com"); }
    function test_can_borrow_weth_against_wsteth_emode1() public {
        address u = address(0xCAFE42);
        deal(WSTETH, u, 1e18);
        vm.startPrank(u);
        IERC20T(WSTETH).approve(POOL, type(uint256).max);
        IPoolT(POOL).supply(WSTETH, 1e18, u, 0);
        IPoolT(POOL).setUserEMode(1);
        IPoolT(POOL).borrow(WETH, 1e15, 2, 0, u); // tiny WETH borrow inside cat 1
        vm.stopPrank();
        assertEq(IERC20T(WETH).balanceOf(u), 1e15, "borrowed");
    }
    function test_borrow_weth_without_emode() public {
        address u = address(0xCAFE43);
        deal(WSTETH, u, 1e18);
        vm.startPrank(u);
        IERC20T(WSTETH).approve(POOL, type(uint256).max);
        IPoolT(POOL).supply(WSTETH, 1e18, u, 0);
        vm.expectRevert(); // global borrowEnabled=false rules outside a category
        IPoolT(POOL).borrow(WETH, 1e15, 2, 0, u);
        vm.stopPrank();
    }
    function test_borrow_wsteth_in_emode1() public {
        address u = address(0xCAFE44);
        deal(WSTETH, u, 1e18);
        vm.startPrank(u);
        IERC20T(WSTETH).approve(POOL, type(uint256).max);
        IPoolT(POOL).supply(WSTETH, 1e18, u, 0);
        IPoolT(POOL).setUserEMode(1);
        vm.expectRevert(); // wstETH is NOT in cat 1's borrowable bitmap
        IPoolT(POOL).borrow(WSTETH, 1e15, 2, 0, u);
        vm.stopPrank();
    }
}
