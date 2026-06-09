// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

/// @dev Minimal subset of CoW Protocol / ComposableCoW interfaces needed by the
///      TwapSafeInitializer. Mirrors the canonical definitions in
///      github.com/cowprotocol/composable-cow.

interface IConditionalOrder {
    /// @dev A struct that uniquely identifies a conditional order. The tuple
    ///      H(handler || salt || staticInput) MUST be unique for an owner.
    struct ConditionalOrderParams {
        address handler; // IConditionalOrder
        bytes32 salt;
        bytes staticInput;
    }
}

interface IValueFactory {
    function getValue(bytes calldata data) external view returns (bytes32);
}

interface IComposableCoW {
    function create(IConditionalOrder.ConditionalOrderParams calldata params, bool dispatch) external;

    function createWithContext(
        IConditionalOrder.ConditionalOrderParams calldata params,
        IValueFactory factory,
        bytes calldata data,
        bool dispatch
    ) external;

    function hash(IConditionalOrder.ConditionalOrderParams memory params) external pure returns (bytes32);

    function singleOrders(address owner, bytes32 hash) external view returns (bool);

    function cabinet(address owner, bytes32 ctx) external view returns (bytes32);

    function domainSeparator() external view returns (bytes32);
}

/// @dev The GPv2Settlement contract exposes the EIP-712 domain separator that
///      identifies the CoW Protocol deployment on the current chain.
interface IGPv2Settlement {
    function domainSeparator() external view returns (bytes32);
}

interface ISafeSignatureVerifier {}

/// @dev Implemented by the ExtensibleFallbackHandler. `setDomainVerifier` is
///      `onlySelf`, i.e. it must be invoked as the Safe calling itself.
interface ISignatureVerifierMuxer {
    function setDomainVerifier(bytes32 domainSeparator, ISafeSignatureVerifier verifier) external;
}
