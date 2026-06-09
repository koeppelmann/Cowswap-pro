// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function flashLoan(
        address receiverAddress, address[] calldata assets, uint256[] calldata amounts,
        uint256[] calldata interestRateModes, address onBehalfOf, bytes calldata params, uint16 referralCode
    ) external;
}

interface IFlashLoanRouter {
    function borrowerCallBack(bytes calldata callBackData) external;
}

interface ISafe {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool);
    function isOwner(address owner) external view returns (bool);
    function getOwners() external view returns (address[] memory);
}

/**
 * @title LevModule
 * @notice A single, shared contract that turns a plain Gnosis Safe into a CoW+Aave
 *         leverage position. Each position Safe sets this as its fallback handler AND
 *         enables it as a module. The Safe itself holds the funds, the Aave position,
 *         and is the CoW order owner.
 *
 *         As the FALLBACK HANDLER it answers the calls the Safe can't:
 *           - isValidSignature  (EIP-1271, validates the owner's ECDSA sig on the order)
 *           - flashLoanAndCallBack / executeOperation  (the flash-loan borrower role)
 *           - openLeg / closePrepare / closeFinalize    (the CoW trampoline hooks)
 *         The Safe's fallback appends the original caller as the last 20 calldata bytes,
 *         which we read via _caller() for authentication.
 *
 *         As an enabled MODULE it performs the actual on-chain actions *as the Safe*
 *         via execTransactionFromModule (supply/borrow/repay/withdraw/approve/transfer).
 *
 *         Stateless and shared across all position Safes (keyed by msg.sender == Safe).
 */
contract LevModule {
    IAavePool public constant POOL = IAavePool(0xb50201558B00496A145fE76f7424749556E326D8);
    IFlashLoanRouter public constant ROUTER = IFlashLoanRouter(0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69);
    address public constant TRAMPOLINE = 0x60Bf78233f48eC42eE3F101b9a05eC7878728006;
    address public constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    /// @dev The original caller, appended by the Safe's FallbackManager as the last 20 bytes.
    function _caller() internal pure returns (address a) {
        assembly { a := shr(96, calldataload(sub(calldatasize(), 20))) }
    }

    /// @dev Execute `data` on `to` AS the Safe (msg.sender is the Safe via fallback).
    function _exec(address to, bytes memory data) internal {
        require(ISafe(msg.sender).execTransactionFromModule(to, 0, data, 0), "module call failed");
    }

    function _arr(address x) private pure returns (address[] memory a) { a = new address[](1); a[0] = x; }
    function _arr(uint256 x) private pure returns (uint256[] memory a) { a = new uint256[](1); a[0] = x; }

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");
    bytes32 private constant SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes32 message)");

    /// @notice EIP-1271. The owner must have signed the order digest wrapped in a SafeMessage whose
    ///         EIP-712 domain's `verifyingContract` is THIS Safe (msg.sender). This binds the
    ///         signature to this exact Safe + chain, so it cannot be replayed as a plain EOA order
    ///         or against any other Safe the user owns. (Same scheme Safe's own handler uses.)
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 domainSep = keccak256(abi.encode(DOMAIN_TYPEHASH, block.chainid, msg.sender));
        bytes32 structHash = keccak256(abi.encode(SAFE_MSG_TYPEHASH, hash));
        bytes32 msgHash = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        address signer = ecrecover(msgHash, v, r, s);
        if (signer != address(0) && ISafe(msg.sender).isOwner(signer)) return 0x1626ba7e;
        return 0xffffffff;
    }

    // ---- Flash-loan borrower role (Safe is the borrower / receiver) ----
    function flashLoanAndCallBack(address lender, address token, uint256 amount, bytes calldata data) external {
        require(_caller() == address(ROUTER), "!router");
        _exec(address(POOL), abi.encodeWithSelector(IAavePool.flashLoan.selector,
            msg.sender, _arr(token), _arr(amount), _arr(uint256(0)), msg.sender, data, uint16(0)));
    }

    function executeOperation(address[] calldata, uint256[] calldata, uint256[] calldata, address, bytes calldata data)
        external returns (bool)
    {
        require(_caller() == address(POOL), "!pool");
        _exec(address(ROUTER), abi.encodeWithSelector(IFlashLoanRouter.borrowerCallBack.selector, data));
        return true;
    }

    // ---- OPEN post-hook: supply bought collateral, borrow, pre-approve flash-loan repay ----
    function openLeg(address collateral, address debtToken, uint256 borrowAmount, uint256 repayApprove) external {
        address safe = msg.sender;
        require(_caller() == TRAMPOLINE || ISafe(safe).isOwner(_caller()), "!auth");
        uint256 cb = IERC20(collateral).balanceOf(safe);
        if (cb > 0) {
            _exec(collateral, abi.encodeWithSelector(IERC20.approve.selector, address(POOL), cb));
            _exec(address(POOL), abi.encodeWithSelector(IAavePool.supply.selector, collateral, cb, safe, uint16(0)));
        }
        if (borrowAmount > 0) {
            _exec(address(POOL), abi.encodeWithSelector(IAavePool.borrow.selector, debtToken, borrowAmount, uint256(2), uint16(0), safe));
        }
        _exec(debtToken, abi.encodeWithSelector(IERC20.approve.selector, address(POOL), repayApprove));
    }

    // ---- REDUCE/CLOSE/DECREASE pre-hook: repay `repayAmount` debt with flash-borrowed debtToken,
    //      withdraw `withdrawAmount` collateral, and approve the relayer to sell it. Pass
    //      type(uint256).max for a full close; specific amounts for a partial reduce or a
    //      leverage decrease (position stays open with the remaining collateral/debt). ----
    function reducePrepare(address collateral, address debtToken, uint256 repayAmount, uint256 withdrawAmount) external {
        address safe = msg.sender;
        require(_caller() == TRAMPOLINE || ISafe(safe).isOwner(_caller()), "!auth");
        _exec(debtToken, abi.encodeWithSelector(IERC20.approve.selector, address(POOL), type(uint256).max));
        _exec(address(POOL), abi.encodeWithSelector(IAavePool.repay.selector, debtToken, repayAmount, uint256(2), safe));
        _exec(address(POOL), abi.encodeWithSelector(IAavePool.withdraw.selector, collateral, withdrawAmount, safe));
        _exec(collateral, abi.encodeWithSelector(IERC20.approve.selector, VAULT_RELAYER, type(uint256).max));
    }

    // ---- CLOSE post-hook: keep repayApprove for the flash-loan pull, forward the rest to the SAFE
    //      OWNER. Funds NEVER go to a caller-supplied address — the hooks are reachable by anyone via
    //      the shared CoW trampoline, so an arbitrary recipient would let a third party drain any
    //      liquid balance in the Safe. Sending only to the owner makes hook abuse griefing, not theft. ----
    function closeFinalize(address collateral, address debtToken, uint256 repayApprove) external {
        address safe = msg.sender;
        require(_caller() == TRAMPOLINE || ISafe(safe).isOwner(_caller()), "!auth");
        address owner = ISafe(safe).getOwners()[0]; // 1/1 position Safe → the user
        _exec(debtToken, abi.encodeWithSelector(IERC20.approve.selector, address(POOL), repayApprove));
        uint256 d = IERC20(debtToken).balanceOf(safe);
        if (d > repayApprove) _exec(debtToken, abi.encodeWithSelector(IERC20.transfer.selector, owner, d - repayApprove));
        uint256 c = IERC20(collateral).balanceOf(safe);
        if (c > 0) _exec(collateral, abi.encodeWithSelector(IERC20.transfer.selector, owner, c));
    }
}
