import {
  type Address, type Hex, type PublicClient, type WalletClient,
  encodeAbiParameters, encodeFunctionData, keccak256, maxUint256, toHex,
} from 'viem';
import { VAULT_RELAYER } from './chains';

/**
 * Gasless EIP-2612 permit — mirrors the official CoW Swap UI. Instead of an
 * on-chain `approve`, the user signs a permit (typed data, gasless) and it is
 * added to the order's appData as a PRE-hook that runs `token.permit(...)` at
 * settlement (paid by the solver). Constants match cowprotocol/cowswap:
 * max-value permit, 80k gas, ~5-year deadline, spender = the CoW vault relayer.
 */

export { VAULT_RELAYER };
const PERMIT_GAS_LIMIT = '80000';
const PERMIT_DURATION = 5 * 365 * 24 * 3600; // ~5 years (DEFAULT_PERMIT_DURATION)

const EIP712_DOMAIN_TYPEHASH = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
// The canonical EIP-2612 Permit typehash. DAI-style (allowance-based) permit tokens
// have a different one, so requiring this excludes them (they'd otherwise pass the
// domain check but need a different signature shape → the pre-hook would revert).
const EIP2612_PERMIT_TYPEHASH = keccak256(toHex('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));

/** Split a 65-byte ECDSA signature into (v, r, s), normalizing v to 27/28. */
export function splitSig(sig: Hex): { v: number; r: Hex; s: Hex } {
  const r = ('0x' + sig.slice(2, 66)) as Hex;
  const s = ('0x' + sig.slice(66, 130)) as Hex;
  let v = parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}

const PERMIT_ABI = [
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'PERMIT_TYPEHASH', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'permit', stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ], outputs: [] },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** Detect standard EIP-2612 support + resolve the token's domain (name, version). */
export async function detectPermit(client: PublicClient, token: Address, chainId: number): Promise<{ name: string; version: string } | null> {
  try {
    // Require the canonical EIP-2612 PERMIT_TYPEHASH — this positively identifies
    // standard permit and rejects DAI-style (allowance-based) tokens.
    const typehash = await client.readContract({ address: token, abi: PERMIT_ABI, functionName: 'PERMIT_TYPEHASH' }) as Hex;
    if (typehash.toLowerCase() !== EIP2612_PERMIT_TYPEHASH.toLowerCase()) return null;
    const [name, onchainDomain] = await Promise.all([
      client.readContract({ address: token, abi: PERMIT_ABI, functionName: 'name' }),
      client.readContract({ address: token, abi: PERMIT_ABI, functionName: 'DOMAIN_SEPARATOR' }),
      client.readContract({ address: token, abi: PERMIT_ABI, functionName: 'nonces', args: [token] }), // must exist
    ]);
    // Find the version whose reconstructed EIP-712 domain matches DOMAIN_SEPARATOR().
    let version: string | null = null;
    try { version = await client.readContract({ address: token, abi: PERMIT_ABI, functionName: 'version' }) as string; } catch { /* no version() */ }
    const candidates = version ? [version] : ['1', '2'];
    for (const v of candidates) {
      const reconstructed = keccak256(encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [EIP712_DOMAIN_TYPEHASH, keccak256(toHex(name as string)), keccak256(toHex(v)), BigInt(chainId), token],
      ));
      if (reconstructed.toLowerCase() === (onchainDomain as string).toLowerCase()) return { name: name as string, version: v };
    }
    return null;
  } catch { return null; }
}

export type PermitHook = { target: Address; callData: Hex; gasLimit: string };

/** Sign an EIP-2612 permit and build the CoW pre-hook that executes it. Returns
 *  null if the token doesn't support permit (caller should fall back to approve). */
export async function buildPermitHook(opts: {
  client: PublicClient; walletClient: WalletClient; token: Address; owner: Address; chainId: number;
}): Promise<PermitHook | null> {
  const dom = await detectPermit(opts.client, opts.token, opts.chainId);
  if (!dom) return null;
  const nonce = await opts.client.readContract({ address: opts.token, abi: PERMIT_ABI, functionName: 'nonces', args: [opts.owner] }) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_DURATION);
  const sig = await opts.walletClient.signTypedData({
    account: opts.owner,
    domain: { name: dom.name, version: dom.version, chainId: opts.chainId, verifyingContract: opts.token },
    types: PERMIT_TYPES, primaryType: 'Permit',
    message: { owner: opts.owner, spender: VAULT_RELAYER, value: maxUint256, nonce, deadline } as never,
  });
  const { v, r, s } = splitSig(sig);
  const callData = encodeFunctionData({
    abi: PERMIT_ABI, functionName: 'permit',
    args: [opts.owner, VAULT_RELAYER, maxUint256, deadline, v, r, s],
  });
  return { target: opts.token, callData, gasLimit: PERMIT_GAS_LIMIT };
}
