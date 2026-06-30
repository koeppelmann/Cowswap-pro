// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {CowAaveLevWrapper, IAavePoolLev} from "../src/CowAaveLevWrapper.sol";
import {CoWSafeSigHandler} from "../src/CoWSafeSigHandler.sol";
import {LevSafeInit} from "../src/LevSafeInit.sol";
import {ICowSettlement} from "../src/CowWrapper.sol";

/*
 * MODEL B e2e: SPECIALIZED single-wrapper Aave leverage on a Gnosis shadow-fork.
 *   solver → CowAaveLevWrapper (semantic params; built-in flash loan + Aave ops as the Safe)
 *               → REAL GPv2Settlement.settle (buffer liquidity)
 *
 * Same lifecycle as the Model A test (OPEN 2x, CLOSE with payout), so the two models are directly
 * comparable. Registration is 1 call with ~8 semantic fields — no pre/post calldata, no MultiSend.
 *
 * Run: GNOSIS_RPC=https://rpc.gnosischain.com forge test --match-path test/CowAaveLevWrapper.fork.t.sol -vv
 */

interface IERC20 { function balanceOf(address) external view returns (uint256); }
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
    function getUserAccountData(address user) external view returns (uint256,uint256,uint256,uint256,uint256,uint256);
    function ADDRESSES_PROVIDER() external view returns (address);
}
interface IAddressesProvider { function getPriceOracle() external view returns (address); }
interface IAaveOracle { function getAssetPrice(address asset) external view returns (uint256); }

contract CowAaveLevWrapperForkTest is Test {
    address constant FACTORY    = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address constant SINGLETON  = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    address constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address constant WXDAI      = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    address constant WETH       = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;
    address constant POOL       = 0xb50201558B00496A145fE76f7424749556E326D8;

    bytes32 constant ORDER_TYPE_HASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 constant KIND_SELL       = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 constant BALANCE_ERC20   = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;
    bytes4  constant SETTLE_SELECTOR = 0x13d79a0b;

    CowAaveLevWrapper lev;
    CoWSafeSigHandler handler;
    address solver;
    address safe;
    address owner;
    uint256 ownerPk = 0xA11CE;
    address vaultRelayer;

    uint256 constant EQUITY  = 100e18;
    uint256 constant FLASH   = 200e18;
    uint256 constant PREMIUM = 1e17;
    uint256 constant REPAY   = FLASH + PREMIUM;
    uint256 constant BORROW  = REPAY - EQUITY;
    uint256 BUY_WETH;

    uint256 constant CFLASH = 101e18;
    uint256 SELL_WETH;
    uint256 CBUY_WXDAI;

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

        lev = new CowAaveLevWrapper(ICowSettlement(SETTLEMENT), IAavePoolLev(POOL), vaultRelayer);
        handler = new CoWSafeSigHandler(address(lev), SETTLEMENT);

        IAuth auth = IAuth(ISettlement(SETTLEMENT).authenticator());
        vm.startPrank(IAuth(address(auth)).manager());
        auth.addSolver(solver);          // drives lev wrapper
        auth.addSolver(address(lev));    // drives settlement
        vm.stopPrank();

        // Safe: module = lev wrapper, fallback handler = its sig handler. NOTE: no standing vault-relayer
        // approval needed — the specialized wrapper sets the exact sell allowance in-flow.
        LevSafeInit init = new LevSafeInit();
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initData = abi.encodeWithSelector(LevSafeInit.setup.selector, address(lev), WXDAI, address(0xdead) /* unused spender */);
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), address(init), initData, address(handler), address(0), uint256(0), address(0)
        );
        safe = ISafeFactory(FACTORY).createProxyWithNonce(SINGLETON, initializer, 0xBEEF01);

        deal(WXDAI, safe, EQUITY);

        address oracle = IAddressesProvider(IAavePool(POOL).ADDRESSES_PROVIDER()).getPriceOracle();
        uint256 pWeth = IAaveOracle(oracle).getAssetPrice(WETH);
        uint256 pDai  = IAaveOracle(oracle).getAssetPrice(WXDAI);
        BUY_WETH   = (FLASH * pDai) / pWeth;
        SELL_WETH  = BUY_WETH - 1e9;                         // aToken withdraw rounding margin
        CBUY_WXDAI = (SELL_WETH * pWeth) / pDai * 99 / 100;  // 1% slippage
    }

    // ---------- helpers ----------
    function _digestOf(address sellT, address buyT, uint256 sellA, uint256 buyA) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPE_HASH, sellT, buyT, safe, sellA, buyA, validTo, bytes32(0), uint256(0),
            KIND_SELL, false, BALANCE_ERC20, BALANCE_ERC20
        ));
        return keccak256(abi.encodePacked("\x19\x01", ISettlement(SETTLEMENT).domainSeparator(), structHash));
    }
    function _uidOf(address sellT, address buyT, uint256 sellA, uint256 buyA) internal view returns (bytes memory) {
        return abi.encodePacked(_digestOf(sellT, buyT, sellA, buyA), safe, validTo);
    }
    function _settleCd(address sellT, address buyT, uint256 sellA, uint256 buyA) internal view returns (bytes memory) {
        address[] memory tokens = new address[](2); tokens[0] = sellT; tokens[1] = buyT;
        uint256[] memory prices = new uint256[](2); prices[0] = buyA; prices[1] = sellA;
        Trade[] memory trades = new Trade[](1);
        trades[0] = Trade({
            sellTokenIndex: 0, buyTokenIndex: 1, receiver: safe, sellAmount: sellA, buyAmount: buyA,
            validTo: validTo, appData: bytes32(0), feeAmount: 0, flags: 0x40, executedAmount: sellA, signature: abi.encodePacked(safe)
        });
        Interaction[] memory empty = new Interaction[](0);
        Interaction[][3] memory interactions = [empty, empty, empty];
        return abi.encodeWithSelector(SETTLE_SELECTOR, tokens, prices, trades, interactions);
    }
    /// single-wrapper chain data: [uint16 len][abi.encode(safe, nonce)]
    function _chain(uint256 nonce) internal view returns (bytes memory) {
        bytes memory wd = abi.encode(safe, nonce);
        return bytes.concat(bytes2(uint16(wd.length)), wd);
    }

    function _registerOpen(uint256 nonce) internal {
        CowAaveLevWrapper.LevParams memory p = CowAaveLevWrapper.LevParams({
            uid: _uidOf(WXDAI, WETH, FLASH, BUY_WETH), expectedFill: FLASH, kind: 0,
            collateral: WETH, debt: WXDAI, flashAmount: FLASH, borrowAmount: BORROW,
            withdrawAmount: 0, payout: address(0), deadline: 0, status: 0
        });
        vm.prank(safe);
        lev.registerLeverage(nonce, p);
    }
    function _registerClose(uint256 nonce) internal {
        CowAaveLevWrapper.LevParams memory p = CowAaveLevWrapper.LevParams({
            uid: _uidOf(WETH, WXDAI, SELL_WETH, CBUY_WXDAI), expectedFill: SELL_WETH, kind: 1,
            collateral: WETH, debt: WXDAI, flashAmount: CFLASH, borrowAmount: 0,
            withdrawAmount: type(uint256).max /* deliberate: close ALL */, payout: owner, deadline: 0, status: 0
        });
        vm.prank(safe);
        lev.registerLeverage(nonce, p);
    }

    function _open() internal {
        _registerOpen(1);
        deal(WETH, SETTLEMENT, BUY_WETH);
        vm.prank(solver);
        uint256 g = gasleft();
        lev.wrappedSettle(_settleCd(WXDAI, WETH, FLASH, BUY_WETH), _chain(1));
        emit log_named_uint("GAS open (model B settle tx)", g - gasleft());
    }

    // ---------- tests ----------
    function test_open_2x_long_specialized() public {
        _open();
        assertEq(ISettlement(SETTLEMENT).filledAmount(_uidOf(WXDAI, WETH, FLASH, BUY_WETH)), FLASH, "filled");
        (uint256 coll, uint256 debt,,,,) = IAavePool(POOL).getUserAccountData(safe);
        assertGt(coll, 0, "collateral supplied");
        assertGt(debt, 0, "debt opened");
        assertEq(IERC20(WXDAI).balanceOf(safe), 0, "no WXDAI dust");
        assertEq(IERC20(WETH).balanceOf(safe), 0, "all proceeds supplied");
        assertEq(IERC20(WXDAI).balanceOf(address(lev)), 0, "flash repaid exactly");
        assertEq(lev.positionStatus(safe, 1), 2, "consumed");
        emit log_named_decimal_uint("collateral (USD 1e8)", coll, 8);
        emit log_named_decimal_uint("debt       (USD 1e8)", debt, 8);
    }

    function test_close_specialized_with_payout() public {
        _open();
        _registerClose(2);
        deal(WXDAI, SETTLEMENT, CBUY_WXDAI);
        uint256 ownerBefore = IERC20(WXDAI).balanceOf(owner);
        vm.prank(solver);
        uint256 g = gasleft();
        lev.wrappedSettle(_settleCd(WETH, WXDAI, SELL_WETH, CBUY_WXDAI), _chain(2));
        emit log_named_uint("GAS close (model B settle tx)", g - gasleft());

        (uint256 coll, uint256 debt,,,,) = IAavePool(POOL).getUserAccountData(safe);
        assertEq(debt, 0, "debt repaid");
        assertEq(coll, 0, "collateral withdrawn");
        // surplus delta went to the REGISTERED payout (the owner) — not getOwners()[0] magic
        uint256 recovered = IERC20(WXDAI).balanceOf(owner) - ownerBefore;
        assertGt(recovered, 90e18, "equity paid out to registered recipient");
        assertEq(IERC20(WXDAI).balanceOf(address(lev)), 0, "flash repaid exactly");
        assertEq(lev.positionStatus(safe, 2), 2, "consumed");
        emit log_named_decimal_uint("equity paid to owner (WXDAI)", recovered, 18);
    }

    function test_delta_protection_preexisting_funds_untouched() public {
        // pre-existing collateral + debt-token balances in the Safe must NOT be supplied/swept
        deal(WETH, safe, 1e18);     // pre-existing 1 WETH
        // (EQUITY WXDAI is part of the action by design; add extra unrelated WXDAI on top)
        deal(WXDAI, safe, EQUITY + 7e18);
        _open();
        assertEq(IERC20(WETH).balanceOf(safe), 1e18, "pre-existing WETH untouched (delta supply)");
        assertEq(IERC20(WXDAI).balanceOf(safe), 7e18, "unrelated WXDAI untouched");
    }

    function test_reject_nonSolver() public {
        _registerOpen(1);
        vm.expectRevert(abi.encodeWithSignature("NotASolver(address)", address(this)));
        lev.wrappedSettle(_settleCd(WXDAI, WETH, FLASH, BUY_WETH), _chain(1));
    }

    function test_reject_unregistered() public {
        vm.prank(solver);
        vm.expectRevert(bytes("not registered"));
        lev.wrappedSettle(_settleCd(WXDAI, WETH, FLASH, BUY_WETH), _chain(9));
    }

    function test_reject_replay() public {
        _open();
        deal(WXDAI, safe, EQUITY);
        deal(WETH, SETTLEMENT, BUY_WETH);
        vm.prank(solver);
        vm.expectRevert(bytes("not registered")); // consumed
        lev.wrappedSettle(_settleCd(WXDAI, WETH, FLASH, BUY_WETH), _chain(1));
    }

    function test_reject_directSettle_bypassBlocked() public {
        _registerOpen(1);
        deal(WETH, SETTLEMENT, BUY_WETH);
        deal(WXDAI, safe, FLASH); // even fully funded…
        vm.prank(solver);
        (bool ok,) = SETTLEMENT.call(_settleCd(WXDAI, WETH, FLASH, BUY_WETH));
        assertFalse(ok, "direct settle must fail (not blessed)");
    }

    function test_reject_notFinalWrapper() public {
        // audit High-1 fix: the specialized wrapper must be LAST in the chain (bless window must cover
        // only the direct settle call). A chain that continues past it must revert.
        _registerOpen(1);
        bytes memory wd = abi.encode(safe, uint256(1));
        bytes memory chainWithMore = bytes.concat(
            bytes2(uint16(wd.length)), wd,
            bytes20(address(0xDEADBEEF)) // pretend another wrapper follows
        );
        vm.prank(solver);
        vm.expectRevert(bytes("must be final wrapper"));
        lev.wrappedSettle(_settleCd(WXDAI, WETH, FLASH, BUY_WETH), chainWithMore);
    }

    function test_reject_thirdParty_flash_callback() public {
        address[] memory assets = new address[](1); assets[0] = WXDAI;
        uint256[] memory amounts = new uint256[](1); amounts[0] = 1e18;
        uint256[] memory modes = new uint256[](1);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        IAavePoolLev(POOL).flashLoan(address(lev), assets, amounts, modes, address(0xBAD), bytes(""), 0);
    }
}
