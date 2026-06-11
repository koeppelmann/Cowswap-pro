// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {CoWSafeWrapper} from "./CoWSafeWrapper.sol";

/*
 * LevManagerModule — owner-signed, anyone-relayed management of a leverage position.
 *
 * The position Safe (1/1, owned by the user) enables this shared immutable module. The owner signs an
 * EIP-712 `Retarget` intent; ANYONE may relay it via execute(). The module verifies the signature,
 * derives the canonical pre/post Safe transactions for the requested state transition ON-CHAIN (the
 * user never signs opaque calldata), reconstructs the GPv2 order appData + UID on-chain, and registers
 * the meta-order on CoWSafeWrapper via the Safe's module slot. The relayer then submits the resulting
 * CoW order (signature "0x") to the orderbook; an organic solver fills it through the wrapper chain.
 *
 * Two modes cover the management verbs:
 *   REDUCE   (Close / Partial close / Decrease-lev): flash debt -> repay debt -> withdraw collateral ->
 *            sell collateral for debt (the order) -> repay flash. Debt-first inside the flash window
 *            keeps Aave LTV valid throughout. Residual (debt token) stays in the Safe = returned equity.
 *   INCREASE (Increase-lev): borrow debt -> sell debt for collateral (the order) -> supply collateral.
 *
 * Security (per codex review): EIP-712 domain binds chainId + this module; `safe` is signed; the module
 * requires it is enabled on `safe`; replay key used[safe][nonce]; metaNonce is module-derived (never
 * relayer-chosen); a signed `minHealthFactor` postcondition is enforced via requireHF() in `post`.
 */

interface ISafeMod {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool);
    function isOwner(address owner) external view returns (bool);
    function isModuleEnabled(address module) external view returns (bool);
}
interface IDomain { function domainSeparator() external view returns (bytes32); }
interface IAavePoolHF { function getUserAccountData(address user) external view returns (uint256,uint256,uint256,uint256,uint256,uint256); }

contract LevManagerModule {
    // canonical / pre-existing (Gnosis staging / barn)
    address constant SETTLEMENT = 0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13;
    address constant RELAYER    = 0xC7242d167563352E2BCA4d71C043fbe542DB8FB2;
    address constant WRAPPER    = 0x531636e6e18F3A52c283aCCda39D7185E4597A37; // CoWSafeWrapper
    address constant FLASHWRAP  = 0x2E3fdEe28D7224ED140B4ea08C57F47546679363; // CowFlashLoanWrapper
    address constant MULTISEND  = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
    address constant POOL       = 0xb50201558B00496A145fE76f7424749556E326D8; // Aave V3 pool
    address constant SUPPLYHELP = 0x35a086289db9cA6EcD860f92655C2440f3E5FA7F; // LevSupplyHelper (delegatecall)
    // secp256k1n/2 — reject high-s ECDSA signatures (malleability hardening, codex low finding)
    uint256 constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 constant ORDER_TYPE_HASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 constant KIND_SELL       = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 constant BALANCE_ERC20   = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;

    uint8 constant REDUCE = 0;
    uint8 constant INCREASE = 1;
    uint256 constant MAX = type(uint256).max;

    struct Retarget {
        address safe;
        uint256 nonce;            // replay nonce (per safe)
        uint256 deadline;         // intent expiry
        uint8   mode;             // REDUCE | INCREASE
        address collateral;       // position collateral token
        address debt;             // position debt token
        uint256 sellAmount;       // REDUCE: collateral to sell · INCREASE: debt to borrow+sell
        uint256 repayAmount;      // REDUCE: debt to repay (MAX = full close) · INCREASE: 0
        uint256 minBuy;           // min output of the swap (the user's price floor)
        uint256 flash;            // REDUCE: flash debt amount · INCREASE: 0
        uint32  orderValidTo;     // CoW order validity (<= deadline)
        uint256 minHealthFactor;  // postcondition (Aave 1e18 units); 0 = no check
    }

    bytes32 public constant RETARGET_TYPEHASH = keccak256(
        "Retarget(address safe,uint256 nonce,uint256 deadline,uint8 mode,address collateral,address debt,uint256 sellAmount,uint256 repayAmount,uint256 minBuy,uint256 flash,uint32 orderValidTo,uint256 minHealthFactor)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => mapping(uint256 => bool)) public used; // safe => nonce => consumed

    event Registered(address indexed safe, uint256 nonce, uint8 mode, bytes uid, bytes32 appDataHash, string fullAppData);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("LevManagerModule"), keccak256("1"), block.chainid, address(this)
        ));
    }

    // ---------------------------------------------------------------- execute
    function execute(Retarget calldata r, bytes calldata sig) external returns (bytes memory uid) {
        require(block.timestamp <= r.deadline, "expired");
        require(r.orderValidTo <= r.deadline, "validTo>deadline");
        require(r.mode <= INCREASE, "mode");
        // mode-specific parameter sanity (codex medium): partial REDUCE must be flash-covered; INCREASE has no flash
        if (r.mode == REDUCE && r.repayAmount != MAX) require(r.repayAmount <= r.flash, "repay>flash");
        if (r.mode == INCREASE) require(r.flash == 0 && r.repayAmount == 0, "increase params");

        // authority: the EIP-712 signer must be an owner of the (module-enabled) Safe
        address signer = _recover(_digest(r), sig);
        require(ISafeMod(r.safe).isModuleEnabled(address(this)), "module disabled");
        require(ISafeMod(r.safe).isOwner(signer), "not owner");

        // replay
        require(!used[r.safe][r.nonce], "used");
        used[r.safe][r.nonce] = true;

        uid = _register(r);
    }

    function metaNonceOf(Retarget calldata r) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), r.safe, r.nonce, r.mode)));
    }

    function _register(Retarget calldata r) internal returns (bytes memory uid) {
        uint256 metaNonce = metaNonceOf(r);
        (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) = _prePost(r);
        (string memory json, bytes32 appHash) = _appData(r, safeData(r, pre, post, metaNonce));
        uid = _uid(r, appHash);
        CoWSafeWrapper.MetaOrder memory m = CoWSafeWrapper.MetaOrder({
            uid: uid, expectedFill: r.sellAmount, preHash: _h(pre), postHash: _h(post), notBefore: 0, deadline: 0, status: 0
        });
        require(
            ISafeMod(r.safe).execTransactionFromModule(
                WRAPPER, 0, abi.encodeWithSelector(CoWSafeWrapper.registerMetaOrder.selector, metaNonce, m), 0
            ), "register failed"
        );
        emit Registered(r.safe, r.nonce, r.mode, uid, appHash, json);
    }

    /// abi.encode(OrderExec[]) — the CoWSafeWrapper wrapper-data blob.
    function safeData(Retarget calldata r, CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post, uint256 metaNonce)
        internal pure returns (bytes memory)
    {
        CoWSafeWrapper.OrderExec[] memory ex = new CoWSafeWrapper.OrderExec[](1);
        ex[0] = CoWSafeWrapper.OrderExec({ safe: r.safe, nonce: metaNonce, pre: pre, post: post });
        return abi.encode(ex);
    }

    /// view variant for the front-end: full order derivation without registering.
    function preview(Retarget calldata r) external view returns (bytes memory uid, string memory json, bytes32 appHash) {
        (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) = _prePost(r);
        (json, appHash) = _appData(r, safeData(r, pre, post, metaNonceOf(r)));
        uid = _uid(r, appHash);
    }

    /// Health-factor guard — called as the last `post` step; reverts if HF < minHealthFactor.
    function requireHF(address safe, uint256 minHealthFactor) external view {
        if (minHealthFactor == 0) return;
        (,,,,, uint256 hf) = IAavePoolHF(POOL).getUserAccountData(safe);
        require(hf >= minHealthFactor, "HF too low");
    }

    // ---------------------------------------------------------------- builders
    function _prePost(Retarget calldata r)
        internal view returns (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post)
    {
        if (r.mode == REDUCE) {
            bool full = (r.repayAmount == MAX);
            bytes memory preCalls = abi.encodePacked(
                _ms(r.debt,       abi.encodeWithSignature("approve(address,uint256)", POOL, r.flash)),
                _ms(POOL,         abi.encodeWithSignature("repay(address,uint256,uint256,address)", r.debt, r.repayAmount, uint256(2), r.safe)),
                _ms(POOL,         abi.encodeWithSignature("withdraw(address,uint256,address)", r.collateral, full ? MAX : r.sellAmount, r.safe)),
                _ms(r.collateral, abi.encodeWithSignature("approve(address,uint256)", RELAYER, r.sellAmount))
            );
            pre = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", preCalls), operation: 1 });
            bytes memory postCalls = abi.encodePacked(
                _ms(r.debt, abi.encodeWithSignature("transfer(address,uint256)", FLASHWRAP, _repay(r.flash))),
                _ms(address(this), abi.encodeWithSignature("requireHF(address,uint256)", r.safe, r.minHealthFactor))
            );
            post = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", postCalls), operation: 1 });
        } else {
            bytes memory preCalls = abi.encodePacked(
                _ms(POOL,    abi.encodeWithSignature("borrow(address,uint256,uint256,uint16,address)", r.debt, r.sellAmount, uint256(2), uint16(0), r.safe)),
                _ms(r.debt,  abi.encodeWithSignature("approve(address,uint256)", RELAYER, r.sellAmount))
            );
            pre = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", preCalls), operation: 1 });
            // supply the FULL bought collateral (not just minBuy) so positive slippage isn't left idle:
            // DELEGATECALL the helper (runs AS the Safe → supplies balanceOf(safe)). Then check HF.
            bytes memory postCalls = abi.encodePacked(
                _msd(SUPPLYHELP, abi.encodeWithSignature("supplyAll(address,address)", r.collateral, POOL)),
                _ms(address(this), abi.encodeWithSignature("requireHF(address,uint256)", r.safe, r.minHealthFactor))
            );
            post = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", postCalls), operation: 1 });
        }
    }

    /// flash repayment = flash + ceil(5bps premium); Aave rounds the premium UP, so we ceil.
    function _repay(uint256 flash) internal pure returns (uint256) {
        return flash + (flash * 5 + 9999) / 10000;
    }

    struct Loan { address token; uint256 amount; address recipient; }

    /// Build the order's appData JSON (1 wrapper for INCREASE, 2 for REDUCE) + its hash.
    function _appData(Retarget calldata r, bytes memory safeBlob) internal pure returns (string memory json, bytes32 appHash) {
        if (r.mode == REDUCE) {
            Loan[] memory loans = new Loan[](1);
            loans[0] = Loan({ token: r.debt, amount: r.flash, recipient: r.safe });
            json = string(abi.encodePacked(
                '{"appCode":"koeppelmann/cowswap_wrapper","environment":"barn","metadata":{"wrappers":[{"address":"',
                _ck(FLASHWRAP), '","data":"', _hex(abi.encode(loans)), '","isOmittable":false},{"address":"',
                _ck(WRAPPER),   '","data":"', _hex(safeBlob), '","isOmittable":false}]},"version":"1.6.0"}'
            ));
        } else {
            json = string(abi.encodePacked(
                '{"appCode":"koeppelmann/cowswap_wrapper","environment":"barn","metadata":{"wrappers":[{"address":"',
                _ck(WRAPPER), '","data":"', _hex(safeBlob), '","isOmittable":false}]},"version":"1.6.0"}'
            ));
        }
        appHash = keccak256(bytes(json));
    }

    function _uid(Retarget calldata r, bytes32 appHash) internal view returns (bytes memory) {
        (address sellTok, address buyTok) = r.mode == REDUCE ? (r.collateral, r.debt) : (r.debt, r.collateral);
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPE_HASH, sellTok, buyTok, r.safe, r.sellAmount, r.minBuy, r.orderValidTo, appHash, uint256(0),
            KIND_SELL, false, BALANCE_ERC20, BALANCE_ERC20
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IDomain(SETTLEMENT).domainSeparator(), structHash));
        return abi.encodePacked(digest, r.safe, r.orderValidTo);
    }

    // ---------------------------------------------------------------- EIP-712 + helpers
    function _digest(Retarget calldata r) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            RETARGET_TYPEHASH, r.safe, r.nonce, r.deadline, r.mode, r.collateral, r.debt,
            r.sellAmount, r.repayAmount, r.minBuy, r.flash, r.orderValidTo, r.minHealthFactor
        ));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }
    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "sig len");
        bytes32 rr; bytes32 ss; uint8 v;
        assembly {
            rr := mload(add(sig, 32))
            ss := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        require(uint256(ss) <= HALF_N, "high-s");        // reject malleable signatures
        require(v == 27 || v == 28, "bad v");
        address a = ecrecover(digest, v, rr, ss);
        require(a != address(0), "bad sig");
        return a;
    }
    function _h(CoWSafeWrapper.SafeTx memory t) internal pure returns (bytes32) { return keccak256(abi.encode(t.to, t.value, t.data, t.operation)); }
    function _ms(address to, bytes memory d) internal pure returns (bytes memory) { return abi.encodePacked(uint8(0), to, uint256(0), d.length, d); }
    function _msd(address to, bytes memory d) internal pure returns (bytes memory) { return abi.encodePacked(uint8(1), to, uint256(0), d.length, d); } // MultiSend DELEGATECALL
    function _hex(bytes memory b) internal pure returns (string memory) {
        bytes memory HEX = "0123456789abcdef";
        bytes memory out = new bytes(2 + b.length * 2);
        out[0] = "0"; out[1] = "x";
        for (uint256 i = 0; i < b.length; i++) { out[2 + i*2] = HEX[uint8(b[i]) >> 4]; out[2 + i*2 + 1] = HEX[uint8(b[i]) & 0x0f]; }
        return string(out);
    }
    function _ck(address a) internal pure returns (string memory) {
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
