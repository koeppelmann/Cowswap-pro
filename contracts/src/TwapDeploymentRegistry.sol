// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

interface ISafeProxyFactory {
    function proxyCreationCode() external pure returns (bytes memory);
}

/**
 * @title TwapDeploymentRegistry
 * @notice Trustless, permanent backstop against fund loss.
 *
 *         Funds for a TWAP are sent to an *undeployed* CREATE2 Safe. Deploying it
 *         requires the exact `initializer` (Safe setup calldata). If that data is
 *         lost everywhere off-chain, the funds are stranded forever.
 *
 *         This registry records the `initializer` on-chain, indexed by the
 *         deterministic Safe address it produces — which the registry computes
 *         itself, so the indexed address is trustworthy. Anyone can later read the
 *         `Registered` log for a funded address and reconstruct the exact
 *         `SafeProxyFactory.createProxyWithNonce(singleton, initializer, saltNonce)`
 *         call to deploy it. The chain is the durable, permissionless backup.
 *
 * @dev Deploy once per chain (deterministically). The app's relayer should call
 *      `register(...)` at order-creation time, before revealing the funding
 *      address, so the recovery data exists before any funds can arrive.
 */
contract TwapDeploymentRegistry {
    ISafeProxyFactory public constant SAFE_PROXY_FACTORY =
        ISafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);

    event Registered(
        address indexed safe,
        address indexed registrant,
        address singleton,
        uint256 saltNonce,
        bytes initializer
    );

    /// @notice Record an initializer; returns and indexes the Safe it will deploy to.
    function register(address singleton, uint256 saltNonce, bytes calldata initializer)
        external
        returns (address safe)
    {
        safe = predict(singleton, saltNonce, initializer);
        emit Registered(safe, msg.sender, singleton, saltNonce, initializer);
    }

    /// @notice The CREATE2 address `SafeProxyFactory.createProxyWithNonce` would produce.
    function predict(address singleton, uint256 saltNonce, bytes calldata initializer)
        public
        view
        returns (address)
    {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        bytes memory deploymentData =
            abi.encodePacked(SAFE_PROXY_FACTORY.proxyCreationCode(), uint256(uint160(singleton)));
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(SAFE_PROXY_FACTORY), salt, keccak256(deploymentData))
        );
        return address(uint160(uint256(h)));
    }
}
