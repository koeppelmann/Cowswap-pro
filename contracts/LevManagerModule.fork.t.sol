// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {LevManagerModule} from "../src/LevManagerModule.sol";
import {LevSupplyHelper} from "../src/LevSupplyHelper.sol";

interface IERC20 { function balanceOf(address) external view returns (uint256); }
interface IERC20A { function approve(address, uint256) external returns (bool); }
interface IAaveP {
    function supply(address, uint256, address, uint16) external;
    function borrow(address, uint256, uint256, uint16, address) external;
    function getUserAccountData(address) external view returns (uint256,uint256,uint256,uint256,uint256,uint256);
}

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
    address constant POOL    = 0xb50201558B00496A145fE76f7424749556E326D8;

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
            receiver: owner, triggerHealthFactor: 0, withdrawExtra: 0
        });
    }

    function _sign(LevManagerModule.Retarget memory r, uint256 key) internal view returns (bytes memory) {
        // all-static fields: two concatenated abi.encode chunks are byte-identical to one (stack-depth workaround)
        bytes32 structHash = keccak256(bytes.concat(
            abi.encode(mod.RETARGET_TYPEHASH(), r.safe, r.nonce, r.deadline, r.mode, r.collateral, r.debt),
            abi.encode(r.sellAmount, r.repayAmount, r.minBuy, r.flash, r.orderValidTo, r.minHealthFactor, r.receiver, r.triggerHealthFactor, r.withdrawExtra)
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

    function test_partial_reduce_payout_semantics() public view {
        LevManagerModule.Retarget memory r = _reduce();
        r.repayAmount = 5e15; r.flash = 6e15; r.withdrawExtra = 2e12; // partial w/ receiver: freed equity pays out
        (, string memory json,) = mod.preview(r);
        assertEq(_count(json, _selHex("closeAndSweep(address,address,address,uint256,address,uint256,address)")), 1, "partial w/ receiver pays out");
        r.receiver = address(0); // legacy: residual stays in the Safe
        (, string memory json2,) = mod.preview(r);
        assertEq(_count(json2, _selHex("closeAndSweep(address,address,address,uint256,address,uint256,address)")), 0, "no payout without receiver");
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

    function test_trigger_encoded_in_pre() public view {
        LevManagerModule.Retarget memory r = _reduce();
        r.triggerHealthFactor = 1.05e18;
        (, string memory json,) = mod.preview(r);
        assertEq(_count(json, _selHex("requireHFBelow(address,uint256)")), 1, "stop trigger in pre");
        r.triggerHealthFactor = 0;
        (, string memory json2,) = mod.preview(r);
        assertEq(_count(json2, _selHex("requireHFBelow(address,uint256)")), 0, "no trigger when 0");
    }

    /// LIVE semantics on the fork: build a real Aave position, then check the gate both ways.
    function test_requireHFBelow_gates_on_live_hf() public {
        address user = address(0xCAFE01);
        deal(WETH, user, 1e16);
        vm.startPrank(user);
        IERC20A(WETH).approve(POOL, type(uint256).max);
        IAaveP(POOL).supply(WETH, 1e16, user, 0);
        IAaveP(POOL).borrow(WXDAI, 1e18, 2, 0, user); // small debt -> finite HF
        vm.stopPrank();
        (,,,,, uint256 hf) = IAaveP(POOL).getUserAccountData(user);
        assertGt(hf, 1e18, "sane fixture");
        mod.requireHFBelow(user, hf + 1);              // HF < trigger -> passes
        vm.expectRevert(bytes("HF above trigger"));
        mod.requireHFBelow(user, hf);                  // HF == trigger -> not below -> reverts
        // no-debt account: HF = max -> can never be below any finite trigger
        vm.expectRevert(bytes("HF above trigger"));
        mod.requireHFBelow(address(0xCAFE02), type(uint256).max);
    }

    /// EXECUTES the open post path (delegatecall, fork): full balance supplied, debt borrowed,
    /// flash repaid — nothing idle in the Safe.
    function test_openPost_supplies_all_borrows_repays() public {
        DelegateBox box = new DelegateBox();
        LevSupplyHelper helper = new LevSupplyHelper();
        address flashwrap = address(0xF1A5);
        deal(WETH, address(box), 12e14); // buyMin would be 1e15; box got positive slippage on top
        box.run(address(helper), abi.encodeWithSignature(
            "openPost(address,address,address,uint256,address,uint256)",
            WETH, POOL, WXDAI, uint256(1e18), flashwrap, uint256(1e18)
        ));
        assertEq(IERC20(WETH).balanceOf(address(box)), 0, "ALL collateral supplied (none idle)");
        assertEq(IERC20(WXDAI).balanceOf(flashwrap), 1e18, "flash repaid");
        (,,,,, uint256 hf) = IAaveP(POOL).getUserAccountData(address(box));
        assertGt(hf, 1e18, "live aave position exists");
    }

    /// eMode unlock (fork): sDAI has base LTV 0 on Gnosis — borrowing USDC.e against it must
    /// REVERT without eMode and SUCCEED inside category 3 ("sDAI/USDCe", LTV 90%). This is what
    /// makes openPostE's category entry load-bearing, not an optimization.
    function test_openPostE_emode_unlocks_sdai_pair() public {
        address SDAI = 0xaf204776c7245bF4147c2612BF6e5972Ee483701;
        address USDCE = 0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0;
        LevSupplyHelper helper = new LevSupplyHelper();
        address flashwrap = address(0xF1A5);

        DelegateBox noEmode = new DelegateBox();
        deal(SDAI, address(noEmode), 1e18);
        vm.expectRevert(); // Aave error 57: LTV 0 outside the category
        noEmode.run(address(helper), abi.encodeWithSignature(
            "openPostE(address,address,address,uint256,address,uint256,uint8)",
            SDAI, POOL, USDCE, uint256(5e5), flashwrap, uint256(5e5), uint8(0)
        ));

        DelegateBox withEmode = new DelegateBox();
        deal(SDAI, address(withEmode), 1e18);
        withEmode.run(address(helper), abi.encodeWithSignature(
            "openPostE(address,address,address,uint256,address,uint256,uint8)",
            SDAI, POOL, USDCE, uint256(5e5), flashwrap, uint256(5e5), uint8(3)
        ));
        assertEq(IERC20(USDCE).balanceOf(flashwrap), 5e5, "borrowed + flash repaid in eMode");
        (,,,,, uint256 hf) = IAaveP(POOL).getUserAccountData(address(withEmode));
        assertGt(hf, 1e18, "healthy eMode position");
    }

    /// ADAPTIVE open post (fork): the Safe received LESS debt token than nominal (settlement
    /// fee) — openPostA borrows exactly the shortfall so the flash repayment still clears, and
    /// with a SURPLUS it borrows less. The user's outlay is exact; fees shift the borrow.
    function test_openPostA_adapts_borrow_to_received_equity() public {
        LevSupplyHelper helper = new LevSupplyHelper();
        address flashwrap = address(0xF1A5);
        // case 1: shortfall — nominal equity 1.0, received 0.98 (2% fee), repay 3.0
        DelegateBox shortfall = new DelegateBox();
        deal(WETH, address(shortfall), 1e15);        // bought collateral
        deal(WXDAI, address(shortfall), 0.98e18);    // received equity (fee-shaved)
        shortfall.run(address(helper), abi.encodeWithSignature(
            "openPostA(address,address,address,address,uint256,uint8,uint256)",
            WETH, POOL, WXDAI, flashwrap, uint256(1.5e18), uint8(0), uint256(0)
        ));
        assertEq(IERC20(WXDAI).balanceOf(flashwrap), 1.5e18, "flash repaid in full");
        assertEq(IERC20(WXDAI).balanceOf(address(shortfall)), 0, "no idle debt token");
        (, uint256 debtUsd,,,,) = IAaveP(POOL).getUserAccountData(address(shortfall));
        assertGt(debtUsd, 0, "borrowed the shortfall (0.52)");
        // case 2: surplus — received MORE than repay: no borrow at all
        DelegateBox surplus = new DelegateBox();
        deal(WETH, address(surplus), 1e15);
        deal(WXDAI, address(surplus), 2e18);
        surplus.run(address(helper), abi.encodeWithSignature(
            "openPostA(address,address,address,address,uint256,uint8,uint256)",
            WETH, POOL, WXDAI, flashwrap, uint256(1.5e18), uint8(0), uint256(0)
        ));
        (, uint256 debt2,,,,) = IAaveP(POOL).getUserAccountData(address(surplus));
        assertEq(debt2, 0, "no borrow needed");
    }

    /// openPostA HF floor (codex high, fork): a too-high minHF (simulating a solver that
    /// under-delivered equity → larger borrow → weaker position) REVERTS; a sane floor passes.
    function test_openPostA_enforces_minHF_floor() public {
        LevSupplyHelper helper = new LevSupplyHelper();
        address flashwrap = address(0xF1A5);
        // healthy: borrow modest debt against the supplied collateral, floor 1.05 → passes
        DelegateBox ok = new DelegateBox();
        deal(WETH, address(ok), 1e15);
        ok.run(address(helper), abi.encodeWithSignature(
            "openPostA(address,address,address,address,uint256,uint8,uint256)",
            WETH, POOL, WXDAI, flashwrap, uint256(0.5e18), uint8(0), uint256(1.05e18)
        ));
        (,,,,, uint256 hf) = IAaveP(POOL).getUserAccountData(address(ok));
        assertGe(hf, 1.05e18, "passes a sane floor");
        // unreachable floor → the whole post reverts (settlement would too)
        DelegateBox bad = new DelegateBox();
        deal(WETH, address(bad), 1e15);
        vm.expectRevert(bytes("HF too low"));
        bad.run(address(helper), abi.encodeWithSignature(
            "openPostA(address,address,address,address,uint256,uint8,uint256)",
            WETH, POOL, WXDAI, flashwrap, uint256(0.5e18), uint8(0), uint256(100e18)
        ));
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
