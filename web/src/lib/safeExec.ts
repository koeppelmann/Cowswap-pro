import { type Address, type Hex, concatHex, encodeFunctionData, pad } from 'viem';
import { composableCowAbi, erc20Abi } from './abi';

/**
 * Safe "pre-validated" signature for a single owner. Valid when the executor
 * (msg.sender) IS that owner — so the owner can `execTransaction` directly with
 * no separate signing step. Layout: r = owner (left-padded), s = 0, v = 1.
 */
export function prevalidatedSignature(owner: Address): Hex {
  return concatHex([pad(owner, { size: 32 }), pad('0x', { size: 32 }), '0x01']);
}

/** execTransaction args to send `inner` (a call to `to`) from the Safe, owner-signed. */
export function buildExec(opts: { to: Address; data: Hex; owner: Address; value?: bigint }) {
  return [
    opts.to,
    opts.value ?? 0n,
    opts.data,
    0, // operation: CALL
    0n,
    0n,
    0n,
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000',
    prevalidatedSignature(opts.owner),
  ] as const;
}

export function erc20TransferData(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
}

export function composableCowRemoveData(orderHash: Hex): Hex {
  return encodeFunctionData({ abi: composableCowAbi, functionName: 'remove', args: [orderHash] });
}
