// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TwapSafeInitializer} from "../src/TwapSafeInitializer.sol";
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
    function getThreshold() external view returns (uint256);
}

interface IExtensibleFallbackHandler {
    function domainVerifiers(address safe, bytes32 domainSeparator) external view returns (address);
}

interface IGetTradeableOrder {
    // GPv2Order.Data, mirrored so we can decode the return value.
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

/// @notice End-to-end test on a real Gnosis Chain fork. Reproduces the full
///         deterministic-deployment flow: predict address -> fund (pre-deploy)
///         -> deploy via the canonical SafeProxyFactory -> assert the TWAP is
///         live and a valid discrete order can be cut.
///
/// Run with:  forge test --fork-url https://rpc.gnosischain.com --match-contract Fork -vvv
contract TwapSafeInitializerForkTest is Test {
    // --- canonical Gnosis Chain deployments (Safe v1.3.0) ---
    ISafeProxyFactory constant FACTORY = ISafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
    address constant SAFE_L2_SINGLETON = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    address constant EXTENSIBLE_FALLBACK_HANDLER = 0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5;
    IComposableCoW constant COMPOSABLE_COW = IComposableCoW(0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74);
    address constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    // --- tokens on Gnosis ---
    IERC20 constant WXDAI = IERC20(0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d);
    IERC20 constant USDC = IERC20(0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83);

    TwapSafeInitializer initializer;
    address user = address(0xBEEF);

    function setUp() public {
        // Fork only when an RPC is configured; otherwise skip (keeps `forge test` green offline).
        try vm.envString("GNOSIS_RPC_URL") returns (string memory url) {
            vm.createSelectFork(url);
        } catch {
            try vm.activeFork() returns (uint256) {} catch {
                vm.skip(true);
            }
        }
        initializer = new TwapSafeInitializer();
    }

    function _buildTwap() internal pure returns (Twap.Data memory) {
        return Twap.Data({
            sellToken: WXDAI,
            buyToken: USDC,
            receiver: address(0),
            partSellAmount: 100e18, // 100 WXDAI per part
            minPartLimit: 95e6, // >= 95 USDC per part
            t0: 0, // start now (from cabinet)
            n: 5,
            t: 1 hours,
            span: 0,
            appData: bytes32(0)
        });
    }

    function _predict(bytes memory initData, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initData), saltNonce));
        bytes memory deploymentData =
            abi.encodePacked(FACTORY.proxyCreationCode(), uint256(uint160(SAFE_L2_SINGLETON)));
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(FACTORY), salt, keccak256(deploymentData)));
        return address(uint160(uint256(h)));
    }

    function testDeterministicDeployPlacesLiveTwap() public {
        Twap.Data memory twap = _buildTwap();
        uint256 approveAmount = twap.partSellAmount * twap.n; // 500 WXDAI
        IConditionalOrder.ConditionalOrderParams memory params = Twap.toParams(twap, bytes32(0));

        // setup() delegatecall payload -> our initializer. Allowance/pull model:
        // pull `approveAmount` from `user` into the Safe at deploy time.
        bytes memory initData =
            abi.encodeCall(TwapSafeInitializer.initialize, (WXDAI, user, approveAmount, approveAmount, params));

        address[] memory owners = new address[](1);
        owners[0] = user;
        bytes memory initializerCalldata = abi.encodeWithSelector(
            ISafeSetup.setup.selector,
            owners,
            uint256(1),
            address(initializer),
            initData,
            EXTENSIBLE_FALLBACK_HANDLER,
            address(0),
            uint256(0),
            address(0)
        );

        uint256 saltNonce = 0;
        address predicted = _predict(initializerCalldata, saltNonce);

        // (A) Allowance model: tokens stay in the user's wallet; the user approves
        //     the *counterfactual* Safe address. Nothing is sent to the undeployed safe.
        deal(address(WXDAI), user, approveAmount);
        vm.prank(user);
        WXDAI.approve(predicted, approveAmount);
        assertEq(WXDAI.balanceOf(predicted), 0, "safe holds nothing pre-deploy");
        assertEq(predicted.code.length, 0, "must be undeployed before");

        // (B) Anyone can deploy; the setup pulls the tokens via transferFrom.
        address proxy = FACTORY.createProxyWithNonce(SAFE_L2_SINGLETON, initializerCalldata, saltNonce);

        // tokens moved from user into the Safe exactly at deploy.
        assertEq(WXDAI.balanceOf(user), 0, "pulled from user");
        assertEq(WXDAI.balanceOf(proxy), approveAmount, "safe funded at deploy");

        // (C) Address commitment holds.
        assertEq(proxy, predicted, "predicted == deployed");

        // (D) Safe configured with the intended owner / threshold.
        assertTrue(ISafeSetup(proxy).isOwner(user), "user is owner");
        assertEq(ISafeSetup(proxy).getThreshold(), 1, "threshold");

        // (E) Fallback handler routes GPv2 ERC-1271 checks to ComposableCoW.
        assertEq(
            IExtensibleFallbackHandler(proxy).domainVerifiers(proxy, COMPOSABLE_COW.domainSeparator()),
            address(COMPOSABLE_COW),
            "domain verifier set"
        );

        // (F) Order registered + start time stamped + relayer approved.
        bytes32 orderHash = COMPOSABLE_COW.hash(params);
        assertTrue(COMPOSABLE_COW.singleOrders(proxy, orderHash), "order registered");
        assertEq(uint256(COMPOSABLE_COW.cabinet(proxy, orderHash)), block.timestamp, "start = now");
        assertEq(WXDAI.allowance(proxy, VAULT_RELAYER), approveAmount, "relayer approval");

        // (G) The watch-tower can cut a valid first part with a real signature.
        (IGetTradeableOrder.GPv2OrderData memory order, bytes memory signature) =
            IGetTradeableOrder(address(COMPOSABLE_COW)).getTradeableOrderWithSignature(
                proxy, params, "", new bytes32[](0)
            );
        assertEq(address(order.sellToken), address(WXDAI), "order sellToken");
        assertEq(order.sellAmount, twap.partSellAmount, "order sells one part");
        assertGe(order.buyAmount, twap.minPartLimit, "order respects limit");
        assertGt(signature.length, 0, "non-empty 1271 signature");
    }
}
