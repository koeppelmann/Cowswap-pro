// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ReturnRouter} from "../src/ReturnRouter.sol";

interface ISDai {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
}

interface IAdapterDeposit {
    function depositXDAI(address receiver) external payable returns (uint256);
}

/// @notice Gnosis-fork test of the reverse leg: user deposits xDAI to get real
///         (backed) sDAI, signs one EIP-2612 permit, and ReturnRouter redeems +
///         bridges to mainnet in a single tx.
///
/// Run: GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test --match-contract ReturnRouterForkTest -vv
contract ReturnRouterForkTest is Test {
    ISDai constant SDAI = ISDai(0xaf204776c7245bF4147c2612BF6e5972Ee483701);
    IAdapterDeposit constant ADAPTER = IAdapterDeposit(0xD499b51fcFc66bd31248ef4b28d656d67E591A94);
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    ReturnRouter router;
    uint256 userPk = 0xA11CE;
    address user;
    address mainnetRecipient = address(0xD00D);

    function setUp() public {
        try vm.envString("GNOSIS_RPC_URL") returns (string memory url) {
            vm.createSelectFork(url);
        } catch {
            try vm.activeFork() returns (uint256) {} catch {
                vm.skip(true);
            }
        }
        router = new ReturnRouter();
        user = vm.addr(userPk);
    }

    function _sign(uint256 amount, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, user, address(router), amount, SDAI.nonces(user), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", SDAI.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(userPk, digest);
    }

    function testReturnRedeemsAndBridges() public {
        // Acquire real, redeemable sDAI by depositing native xDAI through the adapter.
        vm.deal(user, 25 ether);
        vm.prank(user);
        ADAPTER.depositXDAI{value: 25 ether}(user);
        uint256 sdai = SDAI.balanceOf(user);
        assertGt(sdai, 0, "user holds sDAI");

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(sdai, deadline);

        vm.prank(user);
        router.returnToMainnet(sdai, mainnetRecipient, deadline, v, r, s);

        // Router is stateless: everything bridged out.
        assertEq(SDAI.balanceOf(user), 0, "user sDAI redeemed");
        assertEq(SDAI.balanceOf(address(router)), 0, "router holds no sDAI");
        assertEq(address(router).balance, 0, "router holds no xDAI");
    }

    function testReturnRevertsBelowBridgeMin() public {
        // 5 xDAI < 10 xDAI minPerTx -> revert.
        vm.deal(user, 5 ether);
        vm.prank(user);
        ADAPTER.depositXDAI{value: 5 ether}(user);
        uint256 sdai = SDAI.balanceOf(user);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(sdai, deadline);

        vm.prank(user);
        vm.expectRevert(bytes("below bridge min (10 xDAI)"));
        router.returnToMainnet(sdai, mainnetRecipient, deadline, v, r, s);
    }
}
