// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TwapBalanceInitializer} from "../src/TwapBalanceInitializer.sol";
import {Twap} from "../src/libraries/Twap.sol";
import {IComposableCoW, IConditionalOrder} from "../src/interfaces/ICoW.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function proxyCreationCode() external view returns (bytes memory);
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;
    function isOwner(address owner) external view returns (bool);
}

interface IGetTradeableOrder {
    struct GPv2OrderData {
        IERC20 sellToken;
        IERC20 buyToken;
        address receiver;
        uint256 sellAmount;
        uint256 buyAmount;
        uint32 validTo;
        bytes32 appData;
        uint256 feeAmount;
        bytes32 kind;
        bool partiallyFillable;
        bytes32 sellTokenBalance;
        bytes32 buyTokenBalance;
    }

    function getTradeableOrderWithSignature(
        address owner,
        IConditionalOrder.ConditionalOrderParams calldata params,
        bytes calldata offchainInput,
        bytes32[] calldata proof
    ) external view returns (GPv2OrderData memory order, bytes memory signature);
}

/// @notice Gnosis-fork proof of the zero-dust carrier flow: the Safe address is
///         funded BEFORE deploy (as a CoW post-interaction would leave it), then
///         deployed; the initializer reads its own balance and arms a TWAP whose
///         parts sum to exactly the balance.
///
/// Run with:  forge test --fork-url https://rpc.gnosischain.com --match-contract BalanceInitializerFork -vvv
contract TwapBalanceInitializerForkTest is Test {
    ISafeProxyFactory constant FACTORY = ISafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
    address constant SAFE_L2_SINGLETON = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    address constant EXTENSIBLE_FALLBACK_HANDLER = 0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5;
    IComposableCoW constant COMPOSABLE_COW = IComposableCoW(0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74);
    address constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    IERC20 constant WXDAI = IERC20(0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d);
    IERC20 constant USDC = IERC20(0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83);

    TwapBalanceInitializer initializer;
    address user = address(0xBEEF);

    function setUp() public {
        try vm.envString("GNOSIS_RPC_URL") returns (string memory url) {
            vm.createSelectFork(url);
        } catch {
            try vm.activeFork() returns (uint256) {} catch {
                vm.skip(true);
            }
        }
        initializer = new TwapBalanceInitializer();
    }

    // ~0.95 USDC (6dp) per 1 WXDAI (18dp): limitNum/limitDen = estMinPartLimit / estPartSell.
    uint256 constant LIMIT_NUM = 95e6;
    uint256 constant LIMIT_DEN = 100e18;
    uint256 constant N = 7; // deliberately non-divisible to exercise the remainder

    function _cfg() internal view returns (TwapBalanceInitializer.Config memory) {
        return TwapBalanceInitializer.Config({
            sellToken: WXDAI, buyToken: USDC, receiver: user,
            n: N, t: 1 hours, span: 0,
            limitNum: LIMIT_NUM, limitDen: LIMIT_DEN,
            salt: keccak256("twap-1"), appData: bytes32(0)
        });
    }

    function _setupCalldata() internal view returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = user;
        return abi.encodeWithSelector(
            ISafeSetup.setup.selector,
            owners, uint256(1), address(initializer),
            abi.encodeCall(TwapBalanceInitializer.initialize, (_cfg())),
            EXTENSIBLE_FALLBACK_HANDLER, address(0), uint256(0), address(0)
        );
    }

    function _expectedParams(uint256 partSell)
        internal
        view
        returns (IConditionalOrder.ConditionalOrderParams memory)
    {
        return Twap.toParams(
            Twap.Data({
                sellToken: WXDAI, buyToken: USDC, receiver: user,
                partSellAmount: partSell, minPartLimit: partSell * LIMIT_NUM / LIMIT_DEN,
                t0: 0, n: N, t: 1 hours, span: 0, appData: bytes32(0)
            }),
            _cfg().salt
        );
    }

    function testBalanceSizedDeployHasNoDust() public {
        bytes memory setupCalldata = _setupCalldata();
        address predicted = _predict(setupCalldata, 0);

        // (A) Carrier fill simulation: funds land on the (undeployed) Safe address.
        uint256 delivered = 1000e18 + 3; // not divisible by 7
        deal(address(WXDAI), predicted, delivered);
        assertEq(predicted.code.length, 0, "undeployed before");

        // (B) Post-interaction: deploy. setup() delegatecalls the initializer,
        //     which sizes from the live balance.
        address proxy = FACTORY.createProxyWithNonce(SAFE_L2_SINGLETON, setupCalldata, 0);
        assertEq(proxy, predicted, "predicted == deployed");
        assertTrue(ISafeSetup(proxy).isOwner(user), "owner");

        // (C) Exact split: partSell = balance / n; relayer approved full balance.
        uint256 partSell = delivered / N;
        assertEq(WXDAI.allowance(proxy, VAULT_RELAYER), delivered, "relayer approved full balance");

        IConditionalOrder.ConditionalOrderParams memory params = _expectedParams(partSell);
        bytes32 orderHash = COMPOSABLE_COW.hash(params);
        assertTrue(COMPOSABLE_COW.singleOrders(proxy, orderHash), "TWAP armed with bal/n sizing");
        assertEq(uint256(COMPOSABLE_COW.cabinet(proxy, orderHash)), block.timestamp, "start now");

        // (D) Dust after all n parts < n wei.
        assertLt(delivered - partSell * N, N, "dust below one wei-per-part");

        // (E) A real first part can be cut, selling exactly one part.
        (IGetTradeableOrder.GPv2OrderData memory order,) = IGetTradeableOrder(address(COMPOSABLE_COW))
            .getTradeableOrderWithSignature(proxy, params, "", new bytes32[](0));
        assertEq(order.sellAmount, partSell, "part sells bal/n");
        assertGe(order.buyAmount, partSell * LIMIT_NUM / LIMIT_DEN, "limit respected");
    }

    function _predict(bytes memory initData, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initData), saltNonce));
        bytes memory deploymentData =
            abi.encodePacked(FACTORY.proxyCreationCode(), uint256(uint160(SAFE_L2_SINGLETON)));
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(FACTORY), salt, keccak256(deploymentData)));
        return address(uint160(uint256(h)));
    }
}
