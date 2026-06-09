// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

/**
 * @title LevAuthV5 — Path-1 authentication core (standalone, for de-risking)
 * @notice Proves the brittle part of v5 in isolation: given the CoW FlashLoanRouter callback blob
 *         (`params`) that the Safe receives in Aave's executeOperation, recover and verify the
 *         owner-signed LevIntent for THIS safe by parsing the live settlement calldata.
 *
 *  params layout (FlashLoanRouter LoansWithSettlement, all loans popped → count 0):
 *    [32 bytes loanCount==0][ABI-encoded settle(...) calldata]
 *  settle(IERC20[] tokens, uint256[] clearingPrices, GPv2Trade.Data[] trades, Interaction[3][] interactions)
 *  EIP-1271 trade.signature = abi.encodePacked(verifier(20), innerSig)  where innerSig = abi.encode(intent, ownerSig)
 *  flags: signingScheme = flags >> 5  (EIP1271 == 2); kind = flags & 1; partiallyFillable = flags & 2.
 */
contract LevAuthV5 {
    // GPv2 order EIP-712 type hash (from cowprotocol/contracts GPv2Order).
    bytes32 internal constant GPV2_ORDER_TYPE_HASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 internal constant KIND_SELL = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 internal constant KIND_BUY  = 0x6ed88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc;
    bytes32 internal constant BALANCE_ERC20 = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;

    address public immutable SETTLEMENT;

    struct GPv2TradeData {
        uint256 sellTokenIndex; uint256 buyTokenIndex; address receiver; uint256 sellAmount; uint256 buyAmount;
        uint32 validTo; bytes32 appData; uint256 feeAmount; uint256 flags; uint256 executedAmount; bytes signature;
    }
    struct Interaction { address target; uint256 value; bytes callData; }

    /// What the owner signs (EIP-712, domain.verifyingContract = the Safe). Fully specifies the order + the
    /// flash loan + the Aave action, so nothing else can be derived from the signature.
    struct LevIntent {
        address safe;
        uint8 action;            // 0 OPEN/INCREASE (lever-up) · 1 REDUCE/CLOSE/DECREASE (lever-down)
        address sellToken; address buyToken; uint256 sellAmount; uint256 buyAmount; uint32 validTo; bytes32 appData;
        address flashToken; uint256 flashAmount;
        uint256 aaveBorrowOrRepay;   // lever-up: borrow amount; lever-down: repay amount (max = type(uint).max)
        uint256 aaveWithdraw;        // lever-down: collateral to withdraw (max = type(uint).max); lever-up: 0
        uint256 repayApprove;        // approve POOL for flash-loan pull (loan+premium+buffer)
        address longToken;           // collateral token (for supply/withdraw)
        uint256 nonce; uint256 deadline;
    }
    bytes32 internal constant INTENT_TYPE_HASH = keccak256(
        "LevIntent(address safe,uint8 action,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,address flashToken,uint256 flashAmount,uint256 aaveBorrowOrRepay,uint256 aaveWithdraw,uint256 repayApprove,address longToken,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant EIP712_DOMAIN_TYPE_HASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");

    constructor(address settlement) { SETTLEMENT = settlement; }

    /// EIP-712 digest of an intent, bound to the given safe (domain.verifyingContract = safe).
    function _intentStructHash(LevIntent memory it) internal pure returns (bytes32) {
        // split into two abi.encode chunks (concat == one 17-arg encode) to avoid stack-too-deep
        return keccak256(bytes.concat(
            abi.encode(INTENT_TYPE_HASH, it.safe, it.action, it.sellToken, it.buyToken, it.sellAmount, it.buyAmount, it.validTo, it.appData),
            abi.encode(it.flashToken, it.flashAmount, it.aaveBorrowOrRepay, it.aaveWithdraw, it.repayApprove, it.longToken, it.nonce, it.deadline)
        ));
    }
    function intentDigest(LevIntent memory it, address safe) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(EIP712_DOMAIN_TYPE_HASH, block.chainid, safe));
        return keccak256(abi.encodePacked("\x19\x01", domain, _intentStructHash(it)));
    }

    /// Recompute the GPv2 order digest that GPv2Settlement validates, from the intent's order fields.
    function orderDigest(LevIntent memory it) public view returns (bytes32) {
        bytes32 sep = ISettlementDS(SETTLEMENT).domainSeparator();
        bytes32 structHash = keccak256(abi.encode(
            GPV2_ORDER_TYPE_HASH, it.sellToken, it.buyToken, it.safe /*receiver*/, it.sellAmount, it.buyAmount,
            it.validTo, it.appData, uint256(0) /*feeAmount*/,
            it.action == 0 ? KIND_SELL : KIND_SELL, // both our flows are sell orders here (lever-up sells short→long; lever-down sells long→short)
            false /*partiallyFillable*/, BALANCE_ERC20, BALANCE_ERC20
        ));
        return keccak256(abi.encodePacked("\x19\x01", sep, structHash));
    }

    function _recoverSigner(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        return ecrecover(digest, v, r, s);
    }

    /// Parse the router callback blob, find the EIP-1271 trade whose verifier == `safe`, decode its
    /// inner signature into (intent, ownerSig), verify the owner signed it (bound to `safe`), and that
    /// the trade's order fields exactly match the intent. Reverts unless exactly one matching trade exists.
    function authenticate(bytes calldata params, address safe)
        external view returns (LevIntent memory it, address signer)
    {
        // strip the 32-byte loan count → the rest is the settle(...) calldata (selector + abi args)
        require(params.length > 36, "short params");
        bytes calldata settleCd = params[32:];
        require(bytes4(settleCd[0:4]) == 0x13d79a0b, "not settle");
        (address[] memory tokens, , GPv2TradeData[] memory trades, ) =
            abi.decode(settleCd[4:], (address[], uint256[], GPv2TradeData[], Interaction[3][]));

        bool found;
        for (uint256 i = 0; i < trades.length; i++) {
            if ((trades[i].flags >> 5) != 2) continue;               // not EIP-1271
            if (trades[i].signature.length < 20) continue;
            if (address(bytes20(_first20(trades[i].signature))) != safe) continue;
            require(!found, "ambiguous: >1 safe trade");
            found = true;
            (it, signer) = _matchTrade(trades[i], tokens, safe);
        }
        require(found, "no safe trade in settlement");
    }

    /// Decode + bind a single EIP-1271 trade whose verifier == safe.
    function _matchTrade(GPv2TradeData memory t, address[] memory tokens, address safe)
        internal view returns (LevIntent memory it, address signer)
    {
        bytes memory inner = _slice(t.signature, 20, t.signature.length - 20);
        bytes memory ownerSig;
        (it, ownerSig) = abi.decode(inner, (LevIntent, bytes));
        require(it.safe == safe && t.receiver == safe, "safe/receiver");
        require(tokens[t.sellTokenIndex] == it.sellToken && tokens[t.buyTokenIndex] == it.buyToken, "tokens");
        require(t.sellAmount == it.sellAmount && t.buyAmount == it.buyAmount, "amounts");
        require(t.validTo == it.validTo && t.appData == it.appData, "validTo/appData");
        require(t.flags & 0x02 == 0, "must be fill-or-kill");        // partiallyFillable == false
        signer = _recoverSigner(intentDigest(it, safe), ownerSig);
        require(signer != address(0), "bad sig");
        require(block.timestamp <= it.deadline, "expired");
    }

    function _first20(bytes memory b) private pure returns (bytes20 out) { assembly { out := mload(add(b, 32)) } }
    function _slice(bytes memory b, uint256 start, uint256 len) private pure returns (bytes memory r) {
        r = new bytes(len);
        for (uint256 i = 0; i < len; i++) r[i] = b[start + i];
    }
}

interface ISettlementDS { function domainSeparator() external view returns (bytes32); }
