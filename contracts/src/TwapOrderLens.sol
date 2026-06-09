// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IComposableCoW {
    function singleOrders(address owner, bytes32 hash) external view returns (bool);
}

/**
 * @title TwapOrderLens
 * @notice Batch read of the on-chain state of many TWAP orders in a single
 *         `eth_call`. For each (safe, owner, sellToken, orderHash) it returns:
 *           - deployed:    is there code at the CREATE2 Safe address?
 *           - allowance:   sellToken.allowance(owner, safe)  (the approve-flow check)
 *           - safeBalance: sellToken.balanceOf(safe)         (what's left to sell)
 *           - active:      ComposableCoW.singleOrders(safe, orderHash) (order registered & not removed)
 *
 *         From these + the order params the app derives status accurately
 *         (not started / approved-awaiting-deploy / in-progress / fully-executed /
 *         cancelled) without per-order RPC. Each token call is try/caught so one
 *         bad token can't break the batch.
 */
contract TwapOrderLens {
    IComposableCoW constant CCOW = IComposableCoW(0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74);

    struct State {
        bool deployed;
        bool active;
        uint256 allowance;
        uint256 safeBalance;
    }

    function check(
        address[] calldata safes,
        address[] calldata owners,
        address[] calldata sellTokens,
        bytes32[] calldata orderHashes
    ) external view returns (State[] memory out) {
        uint256 n = safes.length;
        out = new State[](n);
        for (uint256 i; i < n; i++) {
            address safe = safes[i];
            out[i].deployed = safe.code.length > 0;
            try IERC20(sellTokens[i]).allowance(owners[i], safe) returns (uint256 a) {
                out[i].allowance = a;
            } catch {}
            try IERC20(sellTokens[i]).balanceOf(safe) returns (uint256 b) {
                out[i].safeBalance = b;
            } catch {}
            try CCOW.singleOrders(safe, orderHashes[i]) returns (bool ok) {
                out[i].active = ok;
            } catch {}
        }
    }
}
