// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {CoWSafeWrapper} from "./CoWSafeWrapper.sol";

/*
 * LevOnboardRegistrar — per-deal "intent commitment" demo contract (staging).
 *
 * The user's counterfactual Safe enables this contract as a module in its setup, so the Safe's
 * CREATE2 address commits to THIS contract = the high-level trade intent (constants below). The
 * order UID is computed ON-CHAIN at poke time (GPv2 EIP-712 hash over template fields + the two
 * free params validTo/appDataHash), then registered on CoWSafeWrapper via execTransactionFromModule.
 * => the user's only action is approve/permit to the counterfactual Safe; anyone can poke.
 *
 * Free params an (untrusted) poker controls: validTo (<= EXPIRY) and appDataHash (advisory — a
 * wrong hash only yields an unsubmittable/unfillable order; economics are pinned by the template
 * and by pre/post built here). One-shot.
 */

interface IModuleSafe {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool);
}
interface IDomain { function domainSeparator() external view returns (bytes32); }

contract LevOnboardRegistrar {
    // --- the committed intent (template) ---
    address public constant OWNER     = 0x0756979BE1Aa50236F515dfE4665A7956C0a6a9b; // user EOA
    uint256 public constant EQUITY    = 0.025e18;            // pulled from OWNER at fill
    uint256 public constant FLASH     = 0.05e18;             // flash-borrowed + sold (2x)
    uint256 public constant BUY_MIN   = 24172354253817;      // min WETH out (20% slippage)
    uint256 public constant BORROW    = 25025000000000000;   // FLASH*1.0005 - EQUITY
    uint256 public constant REPAY     = 50025000000000000;   // FLASH*1.0005
    uint32  public constant EXPIRY    = 1781357000;          // template dead after this
    uint256 public constant NONCE     = 1;

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

    bool public used;

    event Registered(address indexed safe, bytes uid);

    /// pre/post for a given safe — built at runtime so the template never embeds the safe address
    function prePost(address safe) public pure returns (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) {
        bytes memory preCalls = abi.encodePacked(
            _ms(WXDAI, abi.encodeWithSignature("transferFrom(address,address,uint256)", OWNER, safe, EQUITY)),
            _ms(WXDAI, abi.encodeWithSignature("approve(address,uint256)", RELAYER, FLASH)),
            _ms(WETH,  abi.encodeWithSignature("approve(address,uint256)", POOL, type(uint256).max))
        );
        pre = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", preCalls), operation: 1 });
        bytes memory postCalls = abi.encodePacked(
            _ms(POOL,  abi.encodeWithSignature("supply(address,uint256,address,uint16)", WETH, BUY_MIN, safe, uint16(0))),
            _ms(POOL,  abi.encodeWithSignature("borrow(address,uint256,uint256,uint16,address)", WXDAI, BORROW, uint256(2), uint16(0), safe)),
            _ms(WXDAI, abi.encodeWithSignature("transfer(address,uint256)", FLASHWRAP, REPAY))
        );
        post = CoWSafeWrapper.SafeTx({ to: MULTISEND, value: 0, data: abi.encodeWithSignature("multiSend(bytes)", postCalls), operation: 1 });
    }

    /// the on-chain UID derivation + registration. Anyone may call; economics are template-pinned.
    function poke(address safe, uint32 validTo, bytes32 appDataHash) external returns (bytes memory uid) {
        require(!used, "used");
        require(validTo <= EXPIRY, "expired template");
        used = true;

        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPE_HASH, WXDAI, WETH, safe, FLASH, BUY_MIN, validTo, appDataHash, uint256(0),
            KIND_SELL, false, BALANCE_ERC20, BALANCE_ERC20
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IDomain(SETTLEMENT).domainSeparator(), structHash));
        uid = abi.encodePacked(digest, safe, validTo);

        (CoWSafeWrapper.SafeTx memory pre, CoWSafeWrapper.SafeTx memory post) = prePost(safe);
        CoWSafeWrapper.MetaOrder memory m = CoWSafeWrapper.MetaOrder({
            uid: uid, expectedFill: FLASH, preHash: _h(pre), postHash: _h(post), notBefore: 0, deadline: 0, status: 0
        });
        require(
            IModuleSafe(safe).execTransactionFromModule(
                WRAPPER, 0, abi.encodeWithSelector(CoWSafeWrapper.registerMetaOrder.selector, NONCE, m), 0
            ),
            "register failed"
        );
        emit Registered(safe, uid);
    }

    function _ms(address to, bytes memory d) internal pure returns (bytes memory) { return abi.encodePacked(uint8(0), to, uint256(0), d.length, d); }
    function _h(CoWSafeWrapper.SafeTx memory t) internal pure returns (bytes32) { return keccak256(abi.encode(t.to, t.value, t.data, t.operation)); }
}
