// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {CoWSafeWrapper} from "../src/CoWSafeWrapper.sol";
import {CoWSafeSigHandler} from "../src/CoWSafeSigHandler.sol";
import {CowFlashLoanWrapper, IAavePoolFL} from "../src/CowFlashLoanWrapper.sol";
import {CowAaveLevWrapper, IAavePoolLev} from "../src/CowAaveLevWrapper.sol";
import {LevSafeInit} from "../src/LevSafeInit.sol";
import {ICowSettlement} from "../src/CowWrapper.sol";

/*
 * E2E GAS COMPARISON — full "open a leverage position" user journey for both wrapper models,
 * measured per step on the same fork (each test starts from identical cold state):
 *   1. create the position Safe (incl. module + fallback-handler wiring; A also needs the standing
 *      vault-relayer approval its flow requires, B sets allowances in-flow)
 *   2. fund equity (identical for both — measured for completeness)
 *   3. register the bundle (A: MetaOrder w/ pre/post hashes · B: semantic LevParams)
 *   4. execute the bundle (wrappedSettle → flash loan → swap → supply+borrow → repay)
 *
 * Run: GNOSIS_RPC=… forge test --match-path test/CowLevGas.fork.t.sol -vv
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
interface ISafeFactory { function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address); }
interface ISafeSetup {
    function setup(address[] calldata owners, uint256 threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver) external;
}
interface ISettlement {
    function domainSeparator() external view returns (bytes32);
    function vaultRelayer() external view returns (address);
    function authenticator() external view returns (address);
    function filledAmount(bytes calldata) external view returns (uint256);
}
interface IAuth { function addSolver(address) external; function manager() external view returns (address); }
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function getUserAccountData(address user) external view returns (uint256,uint256,uint256,uint256,uint256,uint256);
    function ADDRESSES_PROVIDER() external view returns (address);
}
interface IAddressesProvider { function getPriceOracle() external view returns (address); }
interface IAaveOracle { function getAssetPrice(address asset) external view returns (uint256); }

/// minimal Safe-setup delegate for Model B: enable the module, nothing else (no standing approvals)
contract BareInit {
    function setup(address module) external {
        (bool ok,) = address(this).call(abi.encodeWithSignature("enableModule(address)", module));
        ok; // delegatecall context: address(this) == the Safe; enableModule is onlySelf-equivalent via delegatecall
    }
}

contract CowLevGasForkTest is Test {
    address constant FACTORY    = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address constant SINGLETON  = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    address constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address constant MULTISEND  = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
    address constant WXDAI      = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    address constant WETH       = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;
    address constant POOL       = 0xb50201558B00496A145fE76f7424749556E326D8;

    bytes32 constant ORDER_TYPE_HASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 constant KIND_SELL       = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 constant BALANCE_ERC20   = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;
    bytes4  constant SETTLE_SELECTOR = 0x13d79a0b;

    CoWSafeWrapper safeWrapper;
    CowFlashLoanWrapper flashWrapper;
    CowAaveLevWrapper lev;
    CoWSafeSigHandler handlerA;
    CoWSafeSigHandler handlerB;
    LevSafeInit initA;
    BareInit initB;
    address solver;
    address owner;
    uint256 ownerPk = 0xA11CE;
    address vaultRelayer;
    address funder = address(0xF0DDE2);

    uint256 constant EQUITY  = 100e18;
    uint256 constant FLASH   = 200e18;
    uint256 constant PREMIUM = 1e17;
    uint256 constant REPAY   = FLASH + PREMIUM;
    uint256 constant BORROW  = REPAY - EQUITY;
    uint256 BUY_WETH;
    uint32 validTo;

    struct Trade {
        uint256 sellTokenIndex; uint256 buyTokenIndex; address receiver; uint256 sellAmount; uint256 buyAmount;
        uint32 validTo; bytes32 appData; uint256 feeAmount; uint256 flags; uint256 executedAmount; bytes signature;
    }
    struct Interaction { address target; uint256 value; bytes callData; }

    function setUp() public {
        vm.createSelectFork(vm.envString("GNOSIS_RPC"));
        owner = vm.addr(ownerPk);
        solver = address(0x5012E2);
        validTo = uint32(block.timestamp + 3600);
        vaultRelayer = ISettlement(SETTLEMENT).vaultRelayer();

        safeWrapper = new CoWSafeWrapper(ICowSettlement(SETTLEMENT));
        flashWrapper = new CowFlashLoanWrapper(ICowSettlement(SETTLEMENT), IAavePoolFL(POOL));
        lev = new CowAaveLevWrapper(ICowSettlement(SETTLEMENT), IAavePoolLev(POOL), vaultRelayer);
        handlerA = new CoWSafeSigHandler(address(safeWrapper), SETTLEMENT);
        handlerB = new CoWSafeSigHandler(address(lev), SETTLEMENT);
        initA = new LevSafeInit();
        initB = new BareInit();

        IAuth auth = IAuth(ISettlement(SETTLEMENT).authenticator());
        vm.startPrank(IAuth(address(auth)).manager());
        auth.addSolver(solver);
        auth.addSolver(address(flashWrapper));
        auth.addSolver(address(safeWrapper));
        auth.addSolver(address(lev));
        vm.stopPrank();

        address oracle = IAddressesProvider(IAavePool(POOL).ADDRESSES_PROVIDER()).getPriceOracle();
        BUY_WETH = (FLASH * IAaveOracle(oracle).getAssetPrice(WXDAI)) / IAaveOracle(oracle).getAssetPrice(WETH);

        deal(WXDAI, funder, EQUITY * 4); // the "user wallet" that funds equity
    }

    // ---------- shared helpers ----------
    function _digestFor(address s) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPE_HASH, WXDAI, WETH, s, FLASH, BUY_WETH, validTo, bytes32(0), uint256(0),
            KIND_SELL, false, BALANCE_ERC20, BALANCE_ERC20
        ));
        return keccak256(abi.encodePacked("\x19\x01", ISettlement(SETTLEMENT).domainSeparator(), structHash));
    }
    function _uidFor(address s) internal view returns (bytes memory) { return abi.encodePacked(_digestFor(s), s, validTo); }
    function _settleCd(address s) internal view returns (bytes memory) {
        address[] memory tokens = new address[](2); tokens[0] = WXDAI; tokens[1] = WETH;
        uint256[] memory prices = new uint256[](2); prices[0] = BUY_WETH; prices[1] = FLASH;
        Trade[] memory trades = new Trade[](1);
        trades[0] = Trade({
            sellTokenIndex: 0, buyTokenIndex: 1, receiver: s, sellAmount: FLASH, buyAmount: BUY_WETH,
            validTo: validTo, appData: bytes32(0), feeAmount: 0, flags: 0x40, executedAmount: FLASH, signature: abi.encodePacked(s)
        });
        Interaction[] memory empty = new Interaction[](0);
        Interaction[][3] memory interactions = [empty, empty, empty];
        return abi.encodeWithSelector(SETTLE_SELECTOR, tokens, prices, trades, interactions);
    }
    function _ms(address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, uint256(0), data.length, data);
    }
    function _h(CoWSafeWrapper.SafeTx memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(t.to, t.value, t.data, t.operation));
    }

    // ================= MODEL A: full e2e open =================
    function test_gas_e2e_open_modelA() public {
        // 1) CREATE SAFE — owner + enable CoWSafeWrapper module + fallback handler + approve vault relayer (required by A's open)
        address[] memory owners = new address[](1); owners[0] = owner;
        bytes memory initData = abi.encodeWithSelector(LevSafeInit.setup.selector, address(safeWrapper), WXDAI, vaultRelayer);
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), address(initA), initData, address(handlerA), address(0), uint256(0), address(0)
        );
        uint256 g = gasleft();
        address safe = ISafeFactory(FACTORY).createProxyWithNonce(SINGLETON, initializer, 0xA11);
        emit log_named_uint("A.1 create safe            ", g - gasleft());

        // 2) FUND EQUITY (same for both models)
        vm.prank(funder);
        g = gasleft();
        IERC20(WXDAI).transfer(safe, EQUITY);
        emit log_named_uint("A.2 fund equity            ", g - gasleft());

        // 3) REGISTER BUNDLE — MetaOrder with pre/post hashes
        CoWSafeWrapper.SafeTx memory pre = CoWSafeWrapper.SafeTx({ to: WETH, value: 0, data: abi.encodeWithSelector(IERC20.approve.selector, POOL, type(uint256).max), operation: 0 });
        bytes memory calls = bytes.concat(
            _ms(POOL,  abi.encodeWithSelector(IAavePool.supply.selector, WETH, BUY_WETH, safe, uint16(0))),
            _ms(POOL,  abi.encodeWithSelector(IAavePool.borrow.selector, WXDAI, BORROW, uint256(2), uint16(0), safe)),
            _ms(WXDAI, abi.encodeWithSelector(IERC20.transfer.selector, address(flashWrapper), REPAY))
        );
        CoWSafeWrapper.SafeTx memory post = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", calls), operation: 1 });
        CoWSafeWrapper.MetaOrder memory m = CoWSafeWrapper.MetaOrder({
            uid: _uidFor(safe), expectedFill: FLASH, preHash: _h(pre), postHash: _h(post), notBefore: 0, deadline: 0, status: 0
        });
        vm.prank(safe);
        g = gasleft();
        safeWrapper.registerMetaOrder(1, m);
        emit log_named_uint("A.3 register bundle        ", g - gasleft());

        // 4) EXECUTE — flash wrapper -> safe wrapper -> settle
        deal(WETH, SETTLEMENT, BUY_WETH);
        CowFlashLoanWrapper.Loan[] memory loans = new CowFlashLoanWrapper.Loan[](1);
        loans[0] = CowFlashLoanWrapper.Loan({ token: WXDAI, amount: FLASH, recipient: safe });
        CoWSafeWrapper.OrderExec[] memory ex = new CoWSafeWrapper.OrderExec[](1);
        ex[0] = CoWSafeWrapper.OrderExec({ safe: safe, nonce: 1, pre: pre, post: post });
        bytes memory flData = abi.encode(loans);
        bytes memory safeData = abi.encode(ex);
        bytes memory chain = bytes.concat(
            bytes2(uint16(flData.length)), flData, bytes20(address(safeWrapper)), bytes2(uint16(safeData.length)), safeData
        );
        bytes memory settleCd = _settleCd(safe);
        vm.prank(solver);
        g = gasleft();
        flashWrapper.wrappedSettle(settleCd, chain);
        emit log_named_uint("A.4 execute bundle (settle)", g - gasleft());
        emit log_named_uint("A.4b   settle calldata bytes", settleCd.length + chain.length);

        (uint256 coll, uint256 debt,,,,) = IAavePool(POOL).getUserAccountData(safe);
        assertGt(coll, 0); assertGt(debt, 0); // position is real
    }

    // ================= MODEL B: full e2e open =================
    function test_gas_e2e_open_modelB() public {
        // 1) CREATE SAFE — owner + enable CowAaveLevWrapper module + fallback handler (no standing approvals)
        address[] memory owners = new address[](1); owners[0] = owner;
        bytes memory initData = abi.encodeWithSelector(BareInit.setup.selector, address(lev));
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), address(initB), initData, address(handlerB), address(0), uint256(0), address(0)
        );
        uint256 g = gasleft();
        address safe = ISafeFactory(FACTORY).createProxyWithNonce(SINGLETON, initializer, 0xB22);
        emit log_named_uint("B.1 create safe            ", g - gasleft());

        // 2) FUND EQUITY
        vm.prank(funder);
        g = gasleft();
        IERC20(WXDAI).transfer(safe, EQUITY);
        emit log_named_uint("B.2 fund equity            ", g - gasleft());

        // 3) REGISTER BUNDLE — semantic LevParams
        CowAaveLevWrapper.LevParams memory p = CowAaveLevWrapper.LevParams({
            uid: _uidFor(safe), expectedFill: FLASH, kind: 0,
            collateral: WETH, debt: WXDAI, flashAmount: FLASH, borrowAmount: BORROW,
            withdrawAmount: 0, payout: address(0), deadline: 0, status: 0
        });
        vm.prank(safe);
        g = gasleft();
        lev.registerLeverage(1, p);
        emit log_named_uint("B.3 register bundle        ", g - gasleft());

        // 4) EXECUTE — single wrapper -> settle
        deal(WETH, SETTLEMENT, BUY_WETH);
        bytes memory wd = abi.encode(safe, uint256(1));
        bytes memory chain = bytes.concat(bytes2(uint16(wd.length)), wd);
        bytes memory settleCd = _settleCd(safe);
        vm.prank(solver);
        g = gasleft();
        lev.wrappedSettle(settleCd, chain);
        emit log_named_uint("B.4 execute bundle (settle)", g - gasleft());
        emit log_named_uint("B.4b   settle calldata bytes", settleCd.length + chain.length);

        (uint256 coll, uint256 debt,,,,) = IAavePool(POOL).getUserAccountData(safe);
        assertGt(coll, 0); assertGt(debt, 0); // position is real
    }
}
