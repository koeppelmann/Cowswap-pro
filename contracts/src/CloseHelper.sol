// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {CoWSafeWrapper} from "cowswap-wrapper/src/CoWSafeWrapper.sol";

/*
 * CloseHelper — pure/view derivation of a leverage-CLOSE meta-order for an existing Safe.
 *
 * The Safe is already deployed (from onboarding). To close, the owner signs ONE gasless Safe
 * transaction = `registerMetaOrder(nonce, closeMeta)` against CoWSafeWrapper; a relay EOA executes
 * it (paying gas); then the close order (signature "0x", bless-validated) fills through the wrapper
 * chain: flash WXDAI -> repay debt -> withdraw WETH -> sell WETH -> repay flash, remainder = returned
 * equity. This contract derives the appData/UID/pre/post (all on-chain, like IntentBootstrap) and the
 * exact `registerMetaOrder` calldata the Safe must execute, so the front-end needs no encoding.
 */

interface IDomain { function domainSeparator() external view returns (bytes32); }

contract CloseHelper {
    address constant SETTLEMENT = 0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13;
    address constant RELAYER    = 0xC7242d167563352E2BCA4d71C043fbe542DB8FB2;
    address constant WRAPPER    = 0x531636e6e18F3A52c283aCCda39D7185E4597A37;
    address constant FLASHWRAP  = 0x2E3fdEe28D7224ED140B4ea08C57F47546679363;
    address constant MULTISEND  = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
    address constant WXDAI      = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    address constant WETH       = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;
    address constant POOL       = 0xb50201558B00496A145fE76f7424749556E326D8;

    bytes32 constant ORDER_TYPE_HASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 constant KIND_SELL       = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 constant BALANCE_ERC20   = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;

    /// Close parameters (front-end reads the live position + a quote and fills these in).
    struct Close {
        address safe;
        uint256 sellWeth;  // collateral WETH to sell (== the order sell amount, expectedFill)
        uint256 buyMin;    // min WXDAI out
        uint256 flash;     // WXDAI flash-borrowed to repay the debt before withdrawing collateral
        uint256 repay;     // flash repayment (flash * (1+premium))
        uint32  validTo;
        uint256 nonce;     // meta-order nonce on the wrapper (must be unused on this Safe)
    }

    function prePost(Close memory c) public pure returns (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) {
        bytes memory preCalls = abi.encodePacked(
            _ms(WXDAI, abi.encodeWithSignature("approve(address,uint256)", POOL, c.flash)),
            _ms(POOL,  abi.encodeWithSignature("repay(address,uint256,uint256,address)", WXDAI, type(uint256).max, uint256(2), c.safe)),
            _ms(POOL,  abi.encodeWithSignature("withdraw(address,uint256,address)", WETH, type(uint256).max, c.safe)),
            _ms(WETH,  abi.encodeWithSignature("approve(address,uint256)", RELAYER, c.sellWeth))
        );
        pre = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", preCalls), operation: 1 });
        bytes memory postCalls = _ms(WXDAI, abi.encodeWithSignature("transfer(address,uint256)", FLASHWRAP, c.repay));
        post = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", postCalls), operation: 1 });
    }

    struct Loan { address token; uint256 amount; address recipient; }

    function wrapperBytes(Close memory c) public pure returns (bytes memory flData, bytes memory safeData) {
        Loan[] memory loans = new Loan[](1);
        loans[0] = Loan({ token: WXDAI, amount: c.flash, recipient: c.safe });
        flData = abi.encode(loans);
        (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) = prePost(c);
        CoWSafeWrapper.OrderExec[] memory ex = new CoWSafeWrapper.OrderExec[](1);
        ex[0] = CoWSafeWrapper.OrderExec({ safe: c.safe, nonce: c.nonce, pre: pre, post: post });
        safeData = abi.encode(ex);
    }

    function appData(Close memory c) public pure returns (string memory json, bytes32 hash) {
        (bytes memory flData, bytes memory safeData) = wrapperBytes(c);
        json = string(abi.encodePacked(
            '{"appCode":"koeppelmann/cowswap_wrapper","environment":"barn","metadata":{"wrappers":[{"address":"',
            _checksum(FLASHWRAP), '","data":"', _hex(flData), '","isOmittable":false},{"address":"',
            _checksum(WRAPPER),   '","data":"', _hex(safeData), '","isOmittable":false}]},"version":"1.6.0"}'
        ));
        hash = keccak256(bytes(json));
    }

    function uid(Close memory c) public view returns (bytes memory) {
        (, bytes32 appHash) = appData(c);
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPE_HASH, WETH, WXDAI, c.safe, c.sellWeth, c.buyMin, c.validTo, appHash, uint256(0),
            KIND_SELL, false, BALANCE_ERC20, BALANCE_ERC20
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IDomain(SETTLEMENT).domainSeparator(), structHash));
        return abi.encodePacked(digest, c.safe, c.validTo);
    }

    /// Everything the front-end needs: the appData JSON+hash, the order UID, and the exact
    /// `registerMetaOrder` calldata for the Safe to execute (to = WRAPPER).
    function build(Close memory c)
        external view
        returns (address target, bytes memory registerCalldata, string memory json, bytes32 hash, bytes memory orderUid)
    {
        orderUid = uid(c);
        (string memory j, bytes32 h) = appData(c);
        json = j; hash = h;
        (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) = prePost(c);
        CoWSafeWrapper.MetaOrder memory m = CoWSafeWrapper.MetaOrder({
            uid: orderUid, expectedFill: c.sellWeth, preHash: _h(pre), postHash: _h(post), notBefore: 0, deadline: 0, status: 0
        });
        target = WRAPPER;
        registerCalldata = abi.encodeWithSelector(CoWSafeWrapper.registerMetaOrder.selector, c.nonce, m);
    }

    // ---- helpers (same as IntentBootstrap) ----
    function _h(CoWSafeWrapper.SafeTx memory t) internal pure returns (bytes32) { return keccak256(abi.encode(t.to, t.value, t.data, t.operation)); }
    function _ms(address to, bytes memory d) internal pure returns (bytes memory) { return abi.encodePacked(uint8(0), to, uint256(0), d.length, d); }
    function _hex(bytes memory b) internal pure returns (string memory) {
        bytes memory HEX = "0123456789abcdef";
        bytes memory out = new bytes(2 + b.length * 2);
        out[0] = "0"; out[1] = "x";
        for (uint256 i = 0; i < b.length; i++) { out[2 + i*2] = HEX[uint8(b[i]) >> 4]; out[2 + i*2 + 1] = HEX[uint8(b[i]) & 0x0f]; }
        return string(out);
    }
    function _checksum(address a) internal pure returns (string memory) {
        bytes memory HEX = "0123456789abcdef";
        bytes20 ab = bytes20(a);
        bytes memory lower = new bytes(40);
        for (uint256 i = 0; i < 20; i++) { lower[i*2] = HEX[uint8(ab[i]) >> 4]; lower[i*2 + 1] = HEX[uint8(ab[i]) & 0x0f]; }
        bytes32 hh = keccak256(lower);
        bytes memory out = new bytes(42);
        out[0] = "0"; out[1] = "x";
        for (uint256 i = 0; i < 40; i++) {
            uint8 hb = uint8(hh[i/2]);
            uint8 hn = (i % 2 == 0) ? (hb >> 4) : (hb & 0x0f);
            bytes1 ch = lower[i];
            out[2 + i] = (ch >= 0x61 && ch <= 0x66 && hn >= 8) ? bytes1(uint8(ch) - 32) : ch;
        }
        return string(out);
    }
}
