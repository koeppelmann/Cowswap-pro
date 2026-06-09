import { type Address, type Hex, concatHex, getAddress, keccak256, pad, toHex } from 'viem';

/**
 * Reproduces SafeProxyFactory.createProxyWithNonce's CREATE2 derivation:
 *
 *   salt           = keccak256(keccak256(initializer) ++ saltNonce)
 *   deploymentData = proxyCreationCode ++ uint256(singleton)
 *   address        = keccak256(0xff ++ factory ++ salt ++ keccak256(deploymentData))[12:]
 *
 * Verified against on-chain deployment by contracts/test/...fork.t.sol and the
 * cross-check vector in twap.test.ts.
 */
export function predictSafeAddress(opts: {
  factory: Address;
  singleton: Address;
  proxyCreationCode: Hex;
  initializer: Hex;
  saltNonce: bigint;
}): Address {
  const salt = keccak256(
    concatHex([keccak256(opts.initializer), pad(toHex(opts.saltNonce), { size: 32 })]),
  );
  const deploymentData = concatHex([
    opts.proxyCreationCode,
    pad(opts.singleton, { size: 32 }),
  ]);
  const hash = keccak256(
    concatHex(['0xff', opts.factory, salt, keccak256(deploymentData)]),
  );
  return getAddress(`0x${hash.slice(-40)}`);
}
