import { type Address, type Hex, type PublicClient, encodeFunctionData, keccak256 } from 'viem';

/**
 * Native xDAI-bridge withdrawal claim — indexer-free.
 *
 * A Gnosis→mainnet withdrawal (`ReturnRouter.returnToMainnet`) burns xDAI on the
 * Home bridge, which emits a `UserRequestForSignature`-style event and collects 4
 * validator signatures on-chain. To release the funds on Ethereum, someone calls
 * `executeSignatures(message, packedSignatures)` on the Foreign bridge — it is NOT
 * auto-relayed. This builds that claim purely from on-chain reads (validated on
 * real mainnet claims): reconstruct the message from the withdrawal receipt, read
 * the signatures from the Home bridge, pack them, and produce the calldata.
 */

export const HOME_BRIDGE = '0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6' as const; // Gnosis
export const FOREIGN_BRIDGE = '0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016' as const; // mainnet
// topic0 of the Home bridge's withdrawal event (data = recipient, value, nonce, token).
const WITHDRAW_TOPIC = '0xe1e0bc4a1db39a361e3589cae613d7b4862e1f9114dd3ff12ff45be395046968' as const;

const HOME_ABI = [
  { type: 'function', name: 'numMessagesSigned', stateMutability: 'view', inputs: [{ name: 'h', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'signature', stateMutability: 'view', inputs: [{ name: 'h', type: 'bytes32' }, { name: 'i', type: 'uint256' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'requiredSignatures', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'message', stateMutability: 'view', inputs: [{ name: 'h', type: 'bytes32' }], outputs: [{ type: 'bytes' }] },
] as const;
const FOREIGN_ABI = [
  { type: 'function', name: 'relayedMessages', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'executeSignatures', stateMutability: 'nonpayable', inputs: [{ name: 'message', type: 'bytes' }, { name: 'signatures', type: 'bytes' }], outputs: [] },
] as const;

export type Withdrawal = {
  message: Hex;      // the 124-byte validator-signed message
  messageHash: Hex;  // keccak256(message) — key for the Home bridge sig storage
  messageId: Hex;    // the nonce (bytes32) — key for Foreign.relayedMessages
  recipient: Address;
  amount: bigint;
  token: Address;    // token released on mainnet (USDS)
};

/** Reconstruct the withdrawal message from the Home bridge log in a return tx receipt. */
export function parseWithdrawal(logs: Array<{ address: string; topics: readonly string[]; data: string }>): Withdrawal | null {
  const log = logs.find(
    (l) => l.address.toLowerCase() === HOME_BRIDGE.toLowerCase() && l.topics[0]?.toLowerCase() === WITHDRAW_TOPIC,
  );
  if (!log) return null;
  const d = log.data.slice(2); // 4 words: recipient, value, nonce, token
  const w = (i: number) => d.slice(i * 64, (i + 1) * 64);
  const recipient = ('0x' + w(0).slice(24)) as Address;
  const valueHex = w(1);
  const nonceHex = w(2);
  const token = ('0x' + w(3).slice(24)) as Address;
  const foreign = FOREIGN_BRIDGE.slice(2).toLowerCase();
  const message = ('0x' + w(0).slice(24) + valueHex + nonceHex + foreign + token.slice(2).toLowerCase()) as Hex;
  return {
    message,
    messageHash: keccak256(message),
    messageId: ('0x' + nonceHex) as Hex,
    recipient,
    amount: BigInt('0x' + valueHex),
    token,
  };
}

/** Fetch a return tx's receipt and parse its withdrawal. */
export async function withdrawalFromTx(client: PublicClient, txHash: Hex): Promise<Withdrawal | null> {
  const r = await client.getTransactionReceipt({ hash: txHash });
  return parseWithdrawal(r.logs as unknown as Array<{ address: string; topics: readonly string[]; data: string }>);
}

export type ClaimState = { collected: number; required: number; ready: boolean; packed: Hex | null };

/** Read the collected validator signatures from the Home bridge and pack them. */
export async function readClaimState(gnosis: PublicClient, w: Withdrawal): Promise<ClaimState> {
  const required = Number(await gnosis.readContract({ address: HOME_BRIDGE, abi: HOME_ABI, functionName: 'requiredSignatures' }));
  // numMessagesSigned packs (flag<<255 | count); low bits are the count.
  const packedCount = await gnosis.readContract({ address: HOME_BRIDGE, abi: HOME_ABI, functionName: 'numMessagesSigned', args: [w.messageHash] }) as bigint;
  const collected = Number(packedCount & ((1n << 255n) - 1n));
  if (collected < required) return { collected, required, ready: false, packed: null };

  const sigs = (await Promise.all(
    Array.from({ length: required }, (_, i) =>
      gnosis.readContract({ address: HOME_BRIDGE, abi: HOME_ABI, functionName: 'signature', args: [w.messageHash, BigInt(i)] }) as Promise<Hex>,
    ),
  )).map((s) => s.slice(2));
  // packSignatures: count(1) ++ v[..] ++ r[..] ++ s[..]
  const rs = sigs.map((s) => s.slice(0, 64));
  const ss = sigs.map((s) => s.slice(64, 128));
  const vs = sigs.map((s) => s.slice(128, 130));
  const packed = ('0x' + required.toString(16).padStart(2, '0') + vs.join('') + rs.join('') + ss.join('')) as Hex;
  return { collected, required, ready: true, packed };
}

/** Has this withdrawal already been claimed on mainnet? */
export function isClaimed(mainnet: PublicClient, w: Withdrawal): Promise<boolean> {
  return mainnet.readContract({ address: FOREIGN_BRIDGE, abi: FOREIGN_ABI, functionName: 'relayedMessages', args: [w.messageId] }) as Promise<boolean>;
}

/** Calldata for `executeSignatures(message, packed)` on the mainnet Foreign bridge. */
export function executeSignaturesCalldata(message: Hex, packed: Hex): Hex {
  return encodeFunctionData({ abi: FOREIGN_ABI, functionName: 'executeSignatures', args: [message, packed] });
}
