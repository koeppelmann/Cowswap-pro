// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

/*
 * TwapBootstrap — shared, immutable, ONE deployment per chain.
 *
 * The CoW "carrier" trick for TWAP: the user signs a single in-kind GPv2 order
 * (sell `sellToken` -> buy the same `sellToken`, receiver = their counterfactual
 * TWAP Safe) whose appData carries a PRE-interaction calling `bootstrap(...)`.
 * During settlement the solver runs this pre-hook FIRST — it CREATE2-deploys the
 * Safe (whose `setup()` delegatecalls TwapSafeInitializer to arm the ComposableCoW
 * TWAP and approve the vault relayer) — and then the carrier fill delivers the
 * sell tokens to the now-deployed Safe. No allowance to a counterfactual address,
 * no separate relayer deploy tx: one signature bootstraps the whole TWAP.
 *
 * Idempotent & grief-free: the Safe address commits to (singleton, setup, saltNonce)
 * and `setup` commits to the owner + the exact TWAP order, so a front-run with any
 * different parameters lands on a DIFFERENT address; an identical front-run just
 * deploys the same Safe (skipped here if already present) and cannot harm anyone.
 */
interface IProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address);
    function proxyCreationCode() external pure returns (bytes memory);
}

contract TwapBootstrap {
    /// Safe v1.3.0 canonical proxy factory — identical address on every chain.
    address constant FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;

    event Bootstrapped(address indexed safe);

    /// Counterfactual Safe address for a given singleton + setup() calldata + saltNonce.
    /// Matches SafeProxyFactory.createProxyWithNonce's CREATE2 derivation exactly.
    function safeOf(address singleton, bytes memory setup, uint256 saltNonce) public view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(setup), saltNonce));
        bytes32 initCodeHash = keccak256(abi.encodePacked(IProxyFactory(FACTORY).proxyCreationCode(), uint256(uint160(singleton))));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, salt, initCodeHash)))));
    }

    /// Deploy the Safe if it does not yet exist. Safe to call by anyone (a CoW
    /// pre-interaction); repeated/raced calls with the same args are no-ops.
    function bootstrap(address singleton, bytes memory setup, uint256 saltNonce) external returns (address safe) {
        safe = safeOf(singleton, setup, saltNonce);
        if (safe.code.length == 0) {
            address d = IProxyFactory(FACTORY).createProxyWithNonce(singleton, setup, saltNonce);
            require(d == safe, "addr mismatch");
        }
        emit Bootstrapped(safe);
    }
}
