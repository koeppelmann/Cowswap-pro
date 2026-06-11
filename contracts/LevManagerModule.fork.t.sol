// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {LevManagerModule} from "../src/LevManagerModule.sol";

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
            minBuy: 1e16, flash: 11e15, orderValidTo: uint32(block.timestamp + 1800), minHealthFactor: 0
        });
    }

    function _sign(LevManagerModule.Retarget memory r, uint256 key) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            mod.RETARGET_TYPEHASH(), r.safe, r.nonce, r.deadline, r.mode, r.collateral, r.debt,
            r.sellAmount, r.repayAmount, r.minBuy, r.flash, r.orderValidTo, r.minHealthFactor
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
