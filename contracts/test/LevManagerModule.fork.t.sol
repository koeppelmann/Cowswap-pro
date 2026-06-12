// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {LevManagerModule} from "../src/LevManagerModule.sol";
import {LevSupplyHelper} from "../src/LevSupplyHelper.sol";

interface IERC20 { function balanceOf(address) external view returns (uint256); }

/// Delegatecall stand-in for the Safe executing a post SafeTx with operation == 1.
contract DelegateBox {
    function run(address target, bytes memory data) external {
        (bool ok, bytes memory ret) = target.delegatecall(data);
        if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
    }
}

/// Minimal Safe stand-in: owner + module gates, forwards execTransactionFromModule to the target.
contract MockSafe {
    address public ownerAddr;
    address public moduleAddr;
    constructor(address o, address m) { ownerAddr = o; moduleAddr = m; }
    function isOwner(address a) external view returns (bool) { return a == ownerAddr; }
    function isModuleEnabled(address m) external view returns (bool) { return m == moduleAddr; }
    function execTransactionFromModule(address to, uint256 val, bytes calldata data, uint8) external returns (bool) {
        require(msg.sender == moduleAddr, "only module");
        (bool ok,) = to.call{value: val}(data);
        return ok;
    }
}

contract LevManagerModuleForkTest is Test {
    address constant WRAPPER = 0x531636e6e18F3A52c283aCCda39D7185E4597A37;
    address constant WXDAI   = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    address constant WETH    = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;

    LevManagerModule mod;
    MockSafe safe;
    uint256 ownerKey = 0xA11CE;
    address owner;

    function setUp() public {
        vm.createSelectFork("https://rpc.gnosischain.com");
        mod = new LevManagerModule();
        owner = vm.addr(ownerKey);
        safe = new MockSafe(owner, address(mod));
    }

    function _reduce() internal view returns (LevManagerModule.Retarget memory r) {
        r = LevManagerModule.Retarget({
            safe: address(safe), nonce: 1, deadline: block.timestamp + 3600, mode: 0,
            collateral: WETH, debt: WXDAI, sellAmount: 1e13, repayAmount: type(uint256).max,
            minBuy: 1e16, flash: 11e15, orderValidTo: uint32(block.timestamp + 1800), minHealthFactor: 0,
            receiver: owner
        });
    }

    function _sign(LevManagerModule.Retarget memory r, uint256 key) internal view returns (bytes memory) {
        // all-static fields: two concatenated abi.encode chunks are byte-identical to one (stack-depth workaround)
        bytes32 structHash = keccak256(bytes.concat(
            abi.encode(mod.RETARGET_TYPEHASH(), r.safe, r.nonce, r.deadline, r.mode, r.collateral, r.debt),
            abi.encode(r.sellAmount, r.repayAmount, r.minBuy, r.flash, r.orderValidTo, r.minHealthFactor, r.receiver)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", mod.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(key, digest);
        return abi.encodePacked(rr, ss, v);
    }

    function test_reduce_registers_and_uid_matches_preview() public {
        LevManagerModule.Retarget memory r = _reduce();
        (bytes memory previewUid,, ) = mod.preview(r);
        bytes memory uid = mod.execute(r, _sign(r, ownerKey));
        assertEq(keccak256(uid), keccak256(previewUid), "uid == preview");
        uint256 metaNonce = mod.metaNonceOf(r);
        (bool ok, bytes memory ret) = WRAPPER.staticcall(abi.encodeWithSignature("orderStatus(address,uint256)", address(safe), metaNonce));
        require(ok, "orderStatus");
        assertEq(abi.decode(ret, (uint8)), 1, "meta-order registered");
    }

    function test_reverts_wrong_signer() public {
        LevManagerModule.Retarget memory r = _reduce();
        bytes memory sig = _sign(r, 0xBEEF); // build BEFORE arming expectRevert (it makes view calls)
        vm.expectRevert(bytes("not owner"));
        mod.execute(r, sig);
    }

    function test_reverts_replay() public {
        LevManagerModule.Retarget memory r = _reduce();
        bytes memory sig = _sign(r, ownerKey);
        mod.execute(r, sig);
        vm.expectRevert(bytes("used"));
        mod.execute(r, sig);
    }

    function test_reverts_module_disabled() public {
        MockSafe other = new MockSafe(owner, address(0xdead)); // module not enabled
        LevManagerModule.Retarget memory r = _reduce();
        r.safe = address(other);
        bytes memory sig = _sign(r, ownerKey);
        vm.expectRevert(bytes("module disabled"));
        mod.execute(r, sig);
    }

    function test_fullclose_sweeps_to_receiver() public view {
        // full close + receiver: the post blob must contain exactly one sweepAll(debt, collateral, receiver) call
        LevManagerModule.Retarget memory r = _reduce(); // repayAmount == MAX, receiver == owner
        (, string memory json,) = mod.preview(r);
        string memory sel = _selHex("closeAndSweep(address,address,address,uint256,address,uint256,address)");
        assertEq(_count(json, sel), 1, "full close sweeps");
    }

    function test_fullclose_no_receiver_no_sweep() public view {
        LevManagerModule.Retarget memory r = _reduce();
        r.receiver = address(0); // 0 = leave residual in the Safe (legacy behaviour)
        (, string memory json,) = mod.preview(r);
        assertEq(_count(json, _selHex("closeAndSweep(address,address,address,uint256,address,uint256,address)")), 0, "no sweep without receiver");
    }

    function test_partial_reduce_never_sweeps() public view {
        LevManagerModule.Retarget memory r = _reduce();
        r.repayAmount = 5e15; r.flash = 6e15; // partial: residual is returned equity, stays as position buffer
        (, string memory json,) = mod.preview(r);
        assertEq(_count(json, _selHex("closeAndSweep(address,address,address,uint256,address,uint256,address)")), 0, "partial keeps residual in Safe");
    }

    /// EXECUTES the full-close post path (delegatecall, fork): flash repay leaves, BOTH residual
    /// tokens land at the receiver, nothing stays behind. (A preview-only test missed that the
    /// canonical MultiSend is CallOnly — never again: this one actually runs the post.)
    function test_closeAndSweep_executes_and_sweeps_funds() public {
        DelegateBox box = new DelegateBox();
        LevSupplyHelper helper = new LevSupplyHelper();
        address flashwrap = address(0xF1A5);
        uint256 repayAmt = 0.4e18;
        deal(WXDAI, address(box), 1e18);    // debt-token proceeds after the sell
        deal(WETH, address(box), 1e15);     // collateral dust
        box.run(address(helper), abi.encodeWithSignature(
            "closeAndSweep(address,address,address,uint256,address,uint256,address)",
            WXDAI, WETH, flashwrap, repayAmt, address(0), uint256(0), owner
        ));
        assertEq(IERC20(WXDAI).balanceOf(flashwrap), repayAmt, "flash repaid");
        assertEq(IERC20(WXDAI).balanceOf(owner), 1e18 - repayAmt, "debt proceeds swept");
        assertEq(IERC20(WETH).balanceOf(owner), 1e15, "collateral dust swept");
        assertEq(IERC20(WXDAI).balanceOf(address(box)), 0, "no WXDAI left");
        assertEq(IERC20(WETH).balanceOf(address(box)), 0, "no WETH left");
    }

    function _selHex(string memory sigStr) internal pure returns (string memory) {
        bytes4 sel = bytes4(keccak256(bytes(sigStr)));
        bytes memory HEX = "0123456789abcdef";
        bytes memory out = new bytes(8);
        for (uint256 i = 0; i < 4; i++) { out[i*2] = HEX[uint8(sel[i]) >> 4]; out[i*2+1] = HEX[uint8(sel[i]) & 0x0f]; }
        return string(out);
    }

    function test_increase_one_wrapper_appdata() public view {
        LevManagerModule.Retarget memory r = _reduce();
        r.mode = 1; r.flash = 0; r.repayAmount = 0;
        (, string memory json,) = mod.preview(r);
        // INCREASE appData has exactly ONE wrapper entry (no flash layer)
        assertEq(_count(json, '"address":"'), 1, "increase = 1 wrapper");
    }

    function _count(string memory hay, string memory needle) internal pure returns (uint256 n) {
        bytes memory h = bytes(hay); bytes memory nd = bytes(needle);
        if (nd.length == 0 || h.length < nd.length) return 0;
        for (uint256 i = 0; i <= h.length - nd.length; i++) {
            bool m = true;
            for (uint256 j = 0; j < nd.length; j++) { if (h[i+j] != nd[j]) { m = false; break; } }
            if (m) n++;
        }
    }
}
