// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {CoWSafeWrapper} from "./CoWSafeWrapper.sol";

/*
 * IntentBootstrap — shared, immutable, ONE deployment for all users.
 *
 * Given ONLY a high-level Intent (owner + a few numbers), it derives everything on-chain:
 *   - the counterfactual Safe address              safeOf(intent)
 *   - the leverage wrapper bytes (flash + Safe pre/post)
 *   - the EXACT order appData JSON + its hash       appData(intent)        ← the crux
 *   - the GPv2 order UID                            uid(intent, validTo)
 *   - registration of that UID on CoWSafeWrapper    bootstrap(intent, validTo)  (via Safe module)
 *
 * No per-deal contract, no UID supplied from outside: a caller controls only `validTo` (bounded),
 * everything price/size/route is a pure function of the committed Intent. This is the "order creation
 * from the Safe happens fully on-chain from high-level info" primitive.
 *
 * This file first proves the hardest part — that appData(intent) reconstructed on-chain hashes to the
 * exact value the off-chain submitter used — so the on-chain UID equals the orderbook UID.
 */

interface IDomain { function domainSeparator() external view returns (bytes32); }
interface IWXDAI { function deposit() external payable; function transfer(address,uint256) external returns (bool); }
interface IOrderStatus { function orderStatus(address safe, uint256 nonce) external view returns (uint8); }
interface IModuleSafe {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool);
}
interface IProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address);
    function proxyCreationCode() external pure returns (bytes memory);
}

contract IntentBootstrap7 {
    // canonical / pre-existing (Gnosis staging)
    address constant SETTLEMENT = 0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13;
    address constant RELAYER    = 0xC7242d167563352E2BCA4d71C043fbe542DB8FB2;
    address constant WRAPPER    = 0x531636e6e18F3A52c283aCCda39D7185E4597A37; // CoWSafeWrapper
    address constant FLASHWRAP  = 0x2E3fdEe28D7224ED140B4ea08C57F47546679363; // CowFlashLoanWrapper
    address constant MULTISEND  = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
    address constant WXDAI      = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    address constant WETH       = 0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1;
    address constant POOL       = 0xb50201558B00496A145fE76f7424749556E326D8;

    // Safe + sim handler (counterfactual deploy)
    address constant FACTORY    = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address constant SINGLETON  = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    address constant MODSETUP   = 0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47; // SafeModuleSetup.enableModules
    address constant SIMHANDLER = 0xf2044b74959F6bC291dc803C24bF0D7E6379fcC8; // CoWSafeSigHandlerSim2 (combined)
    address constant LEVMANAGER = 0xBf629ED089625c0E649A9ba264144894E3b65E89; // LevManagerModule (signed-intent mgmt)

    event Bootstrapped(address indexed safe, bytes uid);
    uint256 constant TRIGGER_DUST = 1e12; // pulled from owner to fund the self-settling trigger order

    bytes32 constant ORDER_TYPE_HASH = 0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 constant KIND_SELL       = 0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 constant BALANCE_ERC20   = 0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;

    /// The whole user intent. `owner` + the 2x-long economics. (A production version would derive
    /// flash/borrow/repay/buyMin from {equity, leverage, slippage, oraclePrice}; kept explicit here so
    /// the reconstruction can be checked byte-for-byte against an already-filled deal.)
    struct Intent {
        address owner;
        uint256 equity;   // delivered to the Safe by the carrier trade
        uint256 flash;    // flash-borrowed + sold
        uint256 buyMin;   // min WETH out
        uint256 borrow;   // WXDAI borrowed from Aave
        uint256 repay;    // flash repayment (flash * (1+premium))
        uint32  validTo;  // committed (binds the order's validTo into the Safe address)
        uint256 nonce;    // meta-order nonce on the wrapper
    }

    /// CREATE2 salt-nonce derived from the FULL intent: the Safe address commits to every economic
    /// field incl. validTo, so a front-running bootstrap() with different params lands on a DIFFERENT
    /// Safe (not the user's). This is what makes public bootstrap() safe from grief/mis-registration.
    function _saltNonce(Intent memory it) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(
            it.owner, it.equity, it.flash, it.buyMin, it.borrow, it.repay, it.validTo, it.nonce
        )));
    }

    // ---- counterfactual Safe (address commits to owner + modules[wrapper, THIS] + sim handler) ----
    function _initializer(address owner) public view returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        address[] memory mods = new address[](3);
        mods[0] = WRAPPER;
        mods[1] = address(this);
        mods[2] = LEVMANAGER;
        bytes memory enable = abi.encodeWithSignature("enableModules(address[])", mods);
        return abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners, uint256(1), MODSETUP, enable, SIMHANDLER, address(0), uint256(0), address(0)
        );
    }

    function safeOf(Intent memory it) public view returns (address) {
        bytes memory init = _initializer(it.owner);
        bytes32 salt = keccak256(abi.encodePacked(keccak256(init), _saltNonce(it)));
        bytes32 initCodeHash = keccak256(abi.encodePacked(IProxyFactory(FACTORY).proxyCreationCode(), uint256(uint160(SINGLETON))));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, salt, initCodeHash)))));
    }

    /// The whole point: ONE call, only high-level intent + a bounded validTo, deploys the Safe (if
    /// needed) and registers the on-chain-derived leverage UID + pre/post in CoWSafeWrapper. Callable by
    /// anyone (e.g. a solver pre-interaction) — every economic field is pinned by the committed Intent.
    function bootstrap(Intent memory it) external returns (address safe, bytes memory orderUid) {
        safe = safeOf(it);
        if (safe.code.length == 0) {
            address d = IProxyFactory(FACTORY).createProxyWithNonce(SINGLETON, _initializer(it.owner), _saltNonce(it));
            require(d == safe, "addr mismatch");
        }
        orderUid = uid(it, safe);

        // Idempotent: only register if the (safe,nonce) slot is free. Repeated calls / discarded
        // sims / front-runs do not revert and cannot overwrite a registration.
        if (IOrderStatus(WRAPPER).orderStatus(safe, it.nonce) == 0) {
            (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) = prePost(it, safe);
            CoWSafeWrapper.MetaOrder memory m = CoWSafeWrapper.MetaOrder({
                uid: orderUid, expectedFill: it.flash, preHash: _h(pre), postHash: _h(post), notBefore: 0, deadline: 0, status: 0
            });
            require(
                IModuleSafe(safe).execTransactionFromModule(
                    WRAPPER, 0, abi.encodeWithSelector(CoWSafeWrapper.registerMetaOrder.selector, it.nonce, m), 0
                ),
                "register failed"
            );
        }
        emit Bootstrapped(safe, orderUid);
    }

    function _h(CoWSafeWrapper.SafeTx memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(t.to, t.value, t.data, t.operation));
    }

    // ---- pre/post derived from intent (the Safe's enforced actions) ----
    function prePost(Intent memory it, address safe)
        public pure returns (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post)
    {
        // equity is pre-funded in the Safe by the user's single transfer; pre only sets approvals
        bytes memory preCalls = abi.encodePacked(
            _ms(WXDAI, abi.encodeWithSignature("approve(address,uint256)", RELAYER, it.flash)),
            _ms(WETH,  abi.encodeWithSignature("approve(address,uint256)", POOL, type(uint256).max))
        );
        pre = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", preCalls), operation: 1 });
        bytes memory postCalls = abi.encodePacked(
            _ms(POOL,  abi.encodeWithSignature("supply(address,uint256,address,uint16)", WETH, it.buyMin, safe, uint16(0))),
            _ms(POOL,  abi.encodeWithSignature("borrow(address,uint256,uint256,uint16,address)", WXDAI, it.borrow, uint256(2), uint16(0), safe)),
            _ms(WXDAI, abi.encodeWithSignature("transfer(address,uint256)", FLASHWRAP, it.repay))
        );
        post = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", postCalls), operation: 1 });
    }

    struct Loan { address token; uint256 amount; address recipient; }

    /// the two wrapper data blobs that go into appData.metadata.wrappers[].data
    function wrapperBytes(Intent memory it, address safe)
        public pure returns (bytes memory flData, bytes memory safeData)
    {
        Loan[] memory loans = new Loan[](1);
        loans[0] = Loan({ token: WXDAI, amount: it.flash, recipient: safe });
        flData = abi.encode(loans);

        (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) = prePost(it, safe);
        CoWSafeWrapper.OrderExec[] memory ex = new CoWSafeWrapper.OrderExec[](1);
        ex[0] = CoWSafeWrapper.OrderExec({ safe: safe, nonce: it.nonce, pre: pre, post: post });
        safeData = abi.encode(ex);
    }

    /// Reconstruct the EXACT appData JSON bytes the off-chain submitter used, and its hash.
    /// JSON must be byte-identical to what was PUT to the orderbook (keccak of the UTF-8 string).
    function appData(Intent memory it, address safe) public pure returns (string memory json, bytes32 hash) {
        (bytes memory flData, bytes memory safeData) = wrapperBytes(it, safe);
        json = string(abi.encodePacked(
            '{"appCode":"koeppelmann/cowswap_wrapper","environment":"barn","metadata":{"wrappers":[{"address":"',
            _checksum(FLASHWRAP), '","data":"', _hex(flData), '","isOmittable":false},{"address":"',
            _checksum(WRAPPER),   '","data":"', _hex(safeData), '","isOmittable":false}]},"version":"1.6.0"}'
        ));
        hash = keccak256(bytes(json));
    }

    function uid(Intent memory it, address safe) public view returns (bytes memory) {
        (, bytes32 appHash) = appData(it, safe);
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPE_HASH, WXDAI, WETH, safe, it.flash, it.buyMin, it.validTo, appHash, uint256(0),
            KIND_SELL, false, BALANCE_ERC20, BALANCE_ERC20
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IDomain(SETTLEMENT).domainSeparator(), structHash));
        return abi.encodePacked(digest, safe, it.validTo);
    }

    // ---- helpers ----
    function _ms(address to, bytes memory d) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, uint256(0), d.length, d);
    }

    /// lowercase 0x-prefixed hex of arbitrary bytes (matches Python bytes.hex())
    function _hex(bytes memory b) internal pure returns (string memory) {
        bytes memory HEX = "0123456789abcdef";
        bytes memory out = new bytes(2 + b.length * 2);
        out[0] = "0"; out[1] = "x";
        for (uint256 i = 0; i < b.length; i++) {
            out[2 + i * 2]     = HEX[uint8(b[i]) >> 4];
            out[2 + i * 2 + 1] = HEX[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }

    /// EIP-55 checksummed address string (the orderbook/appData uses checksummed wrapper addresses)
    function _checksum(address a) internal pure returns (string memory) {
        bytes memory HEX = "0123456789abcdef";
        bytes20 ab = bytes20(a);
        // lowercase hex (40 chars) for the keccak of the address hex
        bytes memory lower = new bytes(40);
        for (uint256 i = 0; i < 20; i++) {
            lower[i * 2]     = HEX[uint8(ab[i]) >> 4];
            lower[i * 2 + 1] = HEX[uint8(ab[i]) & 0x0f];
        }
        bytes32 h = keccak256(lower);
        bytes memory out = new bytes(42);
        out[0] = "0"; out[1] = "x";
        for (uint256 i = 0; i < 40; i++) {
            uint8 nibbleHashByte = uint8(h[i / 2]);
            uint8 hashNibble = (i % 2 == 0) ? (nibbleHashByte >> 4) : (nibbleHashByte & 0x0f);
            bytes1 c = lower[i];
            if (c >= 0x61 && c <= 0x66 && hashNibble >= 8) {
                out[2 + i] = bytes1(uint8(c) - 32); // uppercase the letter
            } else {
                out[2 + i] = c;
            }
        }
        return string(out);
    }
}
