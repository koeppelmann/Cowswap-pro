// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {LevAuthV5} from "../src/LevAuthV5.sol";

contract MockSettlement { function domainSeparator() external pure returns (bytes32) { return keccak256("DS"); } }

/// De-risks the Path-1 brittle core: parsing the router callback blob → settle calldata → finding the
/// EIP-1271 trade for our Safe → decoding + verifying the owner-signed intent. No fork needed.
contract LevAuthV5Test is Test {
    LevAuthV5 auth;
    uint256 ownerPk = 0xA11CE;
    address owner;
    address safe = address(0x5AFE);
    address other = address(0x0DDE);

    function setUp() public {
        owner = vm.addr(ownerPk);
        auth = new LevAuthV5(address(new MockSettlement()));
    }

    function _intent() internal view returns (LevAuthV5.LevIntent memory it) {
        it = LevAuthV5.LevIntent({
            safe: safe, action: 0, sellToken: address(0x5E11), buyToken: address(0xB111),
            sellAmount: 2e18, buyAmount: 1e15, validTo: uint32(block.timestamp + 1800), appData: keccak256("ad"),
            flashToken: address(0x5E11), flashAmount: 2e18, aaveBorrowOrRepay: 1e18, aaveWithdraw: 0,
            repayApprove: 2.001e18, longToken: address(0xB111), nonce: 1, deadline: block.timestamp + 1800
        });
    }

    // build params = [32-byte loanCount=0][settle calldata] with one EIP-1271 trade for `verifier`
    function _params(LevAuthV5.LevIntent memory it, uint256 signerPk, address verifier, uint256 extraFlags, bool secondSafeTrade) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, auth.intentDigest(it, verifier));
        bytes memory ownerSig = abi.encodePacked(r, s, v);
        bytes memory inner = abi.encode(it, ownerSig);
        bytes memory tradeSig = abi.encodePacked(verifier, inner); // verifier(20) ++ inner

        address[] memory tokens = new address[](2);
        tokens[0] = it.sellToken; tokens[1] = it.buyToken;
        uint256[] memory prices = new uint256[](2);
        uint256 n = secondSafeTrade ? 2 : 1;
        LevAuthV5.GPv2TradeData[] memory trades = new LevAuthV5.GPv2TradeData[](n);
        for (uint256 i = 0; i < n; i++) {
            trades[i] = LevAuthV5.GPv2TradeData({
                sellTokenIndex: 0, buyTokenIndex: 1, receiver: safe, sellAmount: it.sellAmount, buyAmount: it.buyAmount,
                validTo: it.validTo, appData: it.appData, feeAmount: 0, flags: (uint256(2) << 5) | extraFlags,
                executedAmount: it.sellAmount, signature: tradeSig
            });
        }
        LevAuthV5.Interaction[3][] memory inter = new LevAuthV5.Interaction[3][](0);
        bytes memory settleCd = abi.encodeWithSelector(bytes4(0x13d79a0b), tokens, prices, trades, inter);
        return abi.encodePacked(uint256(0), settleCd); // loanCount=0 ++ settle calldata
    }

    function test_authenticate_happy() public view {
        LevAuthV5.LevIntent memory it = _intent();
        bytes memory params = _params(it, ownerPk, safe, 0, false);
        (LevAuthV5.LevIntent memory got, address signer) = auth.authenticate(params, safe);
        assertEq(signer, owner, "recovered owner");
        assertEq(got.sellAmount, it.sellAmount);
        assertEq(got.aaveBorrowOrRepay, it.aaveBorrowOrRepay);
        assertEq(got.nonce, 1);
    }

    function test_reject_wrongSigner() public {
        LevAuthV5.LevIntent memory it = _intent();
        bytes memory params = _params(it, 0xB0B, safe, 0, false); // signed by non-owner
        // signer recovered != owner; the auth core returns the recovered signer — caller must check isOwner.
        (, address signer) = auth.authenticate(params, safe);
        assertTrue(signer != owner, "non-owner recovered (caller rejects via isOwner)");
    }

    function test_reject_noSafeTrade() public {
        LevAuthV5.LevIntent memory it = _intent();
        bytes memory params = _params(it, ownerPk, other, 0, false); // trade verifier = other, not safe
        vm.expectRevert(bytes("no safe trade in settlement"));
        auth.authenticate(params, safe);
    }

    function test_reject_partiallyFillable() public {
        LevAuthV5.LevIntent memory it = _intent();
        bytes memory params = _params(it, ownerPk, safe, 0x02, false); // partiallyFillable flag set
        vm.expectRevert(bytes("must be fill-or-kill"));
        auth.authenticate(params, safe);
    }

    function test_reject_ambiguous() public {
        LevAuthV5.LevIntent memory it = _intent();
        bytes memory params = _params(it, ownerPk, safe, 0, true); // two trades for the safe
        vm.expectRevert(bytes("ambiguous: >1 safe trade"));
        auth.authenticate(params, safe);
    }

    function test_reject_expired() public {
        LevAuthV5.LevIntent memory it = _intent();
        it.deadline = block.timestamp; // will be < timestamp after warp
        bytes memory params = _params(it, ownerPk, safe, 0, false);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(bytes("expired"));
        auth.authenticate(params, safe);
    }
}
