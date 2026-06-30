// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {CoWSafeWrapper} from "../src/CoWSafeWrapper.sol";
import {CowFlashLoanWrapper} from "../src/CowFlashLoanWrapper.sol";

/*
 * Phase B — fork Gnosis at HEAD (which already contains the REAL position Safe + its on-chain meta-order
 * registration from Phase A), then:
 *   1) whitelist both wrappers + a solver by impersonating the STAGING authenticator manager;
 *   2) act as the solver and actually FILL the real registered order:
 *        flash 1.0 WXDAI → CoWSafeWrapper(real safe, nonce 1) → settle → supply+borrow → repay.
 * Proves the exact registered order opens a real 2x ETH position on the real Safe.
 *
 *   GNOSIS_RPC=https://rpc.gnosischain.com forge test --match-path test/StagingForkFill.t.sol -vv
 */

interface IERC20 { function balanceOf(address) external view returns (uint256); }
interface IAuthMgr { function manager() external view returns (address); function addSolver(address) external; }
interface IAavePool { function getUserAccountData(address) external view returns (uint256,uint256,uint256,uint256,uint256,uint256); }

contract StagingForkFillTest is Test {
    // live staging deployment + the real Safe from Phase A
    address constant SETTLEMENT = 0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13;
    address constant AUTHCTR    = 0x02073540567FA1EABcBf74C2F7E6F9029ca7d800;
    address constant WRAPPER    = 0x531636e6e18F3A52c283aCCda39D7185E4597A37;
    address constant FLASHWRAP  = 0x7aC55b24af85C6F5e866293B38E3ff795CAe785d;
    address constant SAFE       = 0x25a9A92F3bD7Ce47cFD48a896C5590Cf8F5A03Fb;
    address constant WXDAI      = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    address constant WETH       = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;
    address constant POOL       = 0xb50201558B00496A145fE76f7424749556E326D8;
    bytes4 constant SETTLE_SELECTOR = 0x13d79a0b;

    // EXACT registered params (match Phase A2 → digest 0xfbc12650…94fee491; uid committed to the
    // appData hash whose fullAppData carries metadata.wrappers = [flash hint, exact safeData])
    uint256 constant FLASH   = 1.0e18;
    uint256 constant BUY_WETH = 609787953379359;        // 1.0 WXDAI @ oracle
    uint256 constant BORROW  = 0.5005e18;
    uint256 constant REPAY   = 1.0005e18;
    uint32  constant VALIDTO = 1783689040;
    uint256 constant NONCE   = 2;
    bytes32 constant APPDATA = 0xaba5ac6d13bdb9382a527ec4f2ac5d6bfb6c0eaf81835ad0b92c36ef2324c4db;
    bytes32 constant DIGEST  = 0xfbc1265018fee113b1168158a81907b3710f03cc85a54d2a6ad8120094fee491;
    address constant MULTISEND = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;

    address solver = address(0x5012E2);

    struct Trade { uint256 sti; uint256 bti; address receiver; uint256 sa; uint256 ba; uint32 vt; bytes32 ad; uint256 fee; uint256 flags; uint256 exec; bytes sig; }
    struct Interaction { address target; uint256 value; bytes callData; }

    function setUp() public { vm.createSelectFork(vm.envString("GNOSIS_RPC")); }

    function _uid() internal pure returns (bytes memory) {
        return abi.encodePacked(DIGEST, SAFE, VALIDTO);
    }
    function _pre() internal pure returns (CoWSafeWrapper.SafeTx memory) {
        return CoWSafeWrapper.SafeTx({ to: WETH, value: 0, data: abi.encodeWithSignature("approve(address,uint256)", POOL, type(uint256).max), operation: 0 });
    }
    function _post() internal pure returns (CoWSafeWrapper.SafeTx memory) {
        bytes memory calls = abi.encodePacked(
            _ms(POOL,  abi.encodeWithSignature("supply(address,uint256,address,uint16)", WETH, BUY_WETH, SAFE, uint16(0))),
            _ms(POOL,  abi.encodeWithSignature("borrow(address,uint256,uint256,uint16,address)", WXDAI, BORROW, uint256(2), uint16(0), SAFE)),
            _ms(WXDAI, abi.encodeWithSignature("transfer(address,uint256)", FLASHWRAP, REPAY))
        );
        return CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", calls), operation: 1 });
    }
    function _ms(address to, bytes memory d) internal pure returns (bytes memory) { return abi.encodePacked(uint8(0), to, uint256(0), d.length, d); }

    function _settleData() internal pure returns (bytes memory) {
        address[] memory tokens = new address[](2); tokens[0] = WXDAI; tokens[1] = WETH;
        uint256[] memory prices = new uint256[](2); prices[0] = BUY_WETH; prices[1] = FLASH; // executedBuy = FLASH*BUY/FLASH = BUY
        Trade[] memory trades = new Trade[](1);
        trades[0] = Trade({ sti:0, bti:1, receiver:SAFE, sa:FLASH, ba:BUY_WETH, vt:VALIDTO, ad:APPDATA, fee:0, flags:0x40, exec:FLASH, sig:abi.encodePacked(SAFE) });
        Interaction[] memory e = new Interaction[](0);
        Interaction[][3] memory inter = [e, e, e];
        return abi.encodeWithSelector(SETTLE_SELECTOR, tokens, prices, trades, inter);
    }

    function _chain() internal pure returns (bytes memory) {
        CowFlashLoanWrapper.Loan[] memory loans = new CowFlashLoanWrapper.Loan[](1);
        loans[0] = CowFlashLoanWrapper.Loan({ token: WXDAI, amount: FLASH, recipient: SAFE });
        bytes[] memory uids = new bytes[](1); uids[0] = _uid();
        CoWSafeWrapper.OrderExec[] memory ex = new CoWSafeWrapper.OrderExec[](1);
        ex[0] = CoWSafeWrapper.OrderExec({ safe: SAFE, nonce: NONCE, pre: _pre(), post: _post() });
        bytes memory flData = abi.encode(loans); // uids now derived from settleData by the wrapper
        bytes memory safeData = abi.encode(ex);
        return bytes.concat(bytes2(uint16(flData.length)), flData, bytes20(WRAPPER), bytes2(uint16(safeData.length)), safeData);
    }

    function test_fill_real_registered_order() public {
        // sanity: the real Safe already holds the equity and the order is registered (from Phase A)
        assertEq(IERC20(WXDAI).balanceOf(SAFE), 0.5e18, "real equity present");
        assertEq(CoWSafeWrapper(WRAPPER).orderStatus(SAFE, NONCE), 1, "order registered on-chain");
        (uint256 c0, uint256 d0,,,,) = IAavePool(POOL).getUserAccountData(SAFE);
        assertEq(c0, 0, "no position yet"); assertEq(d0, 0, "no debt yet");

        // 1) whitelist (impersonate the staging authenticator manager — what Kaze would do)
        address mgr = IAuthMgr(AUTHCTR).manager();
        vm.startPrank(mgr);
        IAuthMgr(AUTHCTR).addSolver(FLASHWRAP);
        IAuthMgr(AUTHCTR).addSolver(WRAPPER);
        IAuthMgr(AUTHCTR).addSolver(solver);
        vm.stopPrank();

        // 2) solver fills it: buffer liquidity for the buy side, then drive the chain
        deal(WETH, SETTLEMENT, BUY_WETH);
        vm.prank(solver);
        CowFlashLoanWrapper(FLASHWRAP).wrappedSettle(_settleData(), _chain());

        // the real Safe now holds a 2x ETH long
        (uint256 c1, uint256 d1,,,,) = IAavePool(POOL).getUserAccountData(SAFE);
        assertGt(c1, 0, "collateral opened"); assertGt(d1, 0, "debt opened");
        assertEq(CoWSafeWrapper(WRAPPER).orderStatus(SAFE, NONCE), 2, "order consumed");
        assertEq(IERC20(WXDAI).balanceOf(SAFE), 0, "equity fully deployed");
        assertEq(IERC20(WXDAI).balanceOf(FLASHWRAP), 0, "flash repaid exactly");
        emit log_named_decimal_uint("collateral USD (1e8)", c1, 8);
        emit log_named_decimal_uint("debt       USD (1e8)", d1, 8);
        emit log_named_decimal_uint("WETH collateral qty", IERC20(WETH).balanceOf(SAFE), 18); // ~0 (supplied)
    }
}
