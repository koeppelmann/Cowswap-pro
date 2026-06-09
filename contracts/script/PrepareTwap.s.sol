// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TwapSafeInitializer} from "../src/TwapSafeInitializer.sol";
import {Twap} from "../src/libraries/Twap.sol";
import {IConditionalOrder} from "../src/interfaces/ICoW.sol";

interface ISafeSetup {
    function setup(address[] calldata o, uint256 t, address to, bytes calldata d, address fh, address pt, uint256 p, address pr) external;
}
interface ISafeProxyFactory { function proxyCreationCode() external view returns (bytes memory); }

/// @notice Funds an undeployed Safe with a GNO->EURe TWAP but does NOT deploy it,
///         so the relayer can be observed deploying it. Logs the DB row fields.
contract PrepareTwap is Script {
    address constant TWAP_INIT = 0x3afA7DB0BEC365b4CF169A3556acDDe6653d0E18;
    address constant FALLBACK = 0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5;
    ISafeProxyFactory constant FACTORY = ISafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
    address constant SINGLETON = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    IERC20 constant GNO = IERC20(0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb);
    address constant EURE = 0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430;

    function compute() external {
        _emit(false);
    }

    function run() external {
        _emit(true);
    }

    function _emit(bool fund) internal {
        uint256 pk = vm.envUint("PK");
        address owner = vm.addr(pk);

        Twap.Data memory d = Twap.Data({
            sellToken: IERC20(EURE), buyToken: GNO, receiver: owner,
            partSellAmount: 0.5 ether, minPartLimit: 0.006 ether, // ~0.006 GNO per 0.5 EURe
            t0: 0, n: 2, t: 300, span: 0, appData: bytes32(0)
        });
        uint256 total = d.partSellAmount * d.n; // 1 EURe
        IConditionalOrder.ConditionalOrderParams memory params = Twap.toParams(d, bytes32(0));
        bytes memory initData = abi.encodeCall(TwapSafeInitializer.initialize, (IERC20(EURE), owner, total, total, params));
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector, owners, uint256(1), TWAP_INIT, initData, FALLBACK, address(0), uint256(0), address(0)
        );

        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), uint256(0)));
        bytes memory dep = abi.encodePacked(FACTORY.proxyCreationCode(), uint256(uint160(SINGLETON)));
        address safe = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(FACTORY), salt, keccak256(dep))))));

        if (fund) {
            vm.startBroadcast(pk);
            IERC20(EURE).approve(safe, total); // allowance model — approve only, no deploy
            vm.stopBroadcast();
        }

        console2.log("SAFE=%s", safe);
        console2.log("OWNER=%s", owner);
        console2.log("SELL=%s", EURE);
        console2.log("BUY=%s", address(GNO));
        console2.log("TOTAL=%s", total);
        console2.log("PART=%s", d.partSellAmount);
        console2.log("MINPART=%s", d.minPartLimit);
        console2.log("ORDERHASH=%s", vm.toString(keccak256(abi.encode(params))));
        console2.log("SINGLETON=%s", SINGLETON);
        console2.log("INITIALIZER=%s", vm.toString(initializer));
    }
}
