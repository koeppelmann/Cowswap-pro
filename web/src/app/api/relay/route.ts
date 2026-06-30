import { NextResponse } from 'next/server';
import { createWalletClient, createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const runtime = 'nodejs';

// "Safe relay service": executes an owner-signed Safe transaction (gas paid by the relay EOA).
// The relay can ONLY execute what the owner signed — it cannot forge the signature — so its power
// is limited to landing the user's intent. Key lives outside the repo (~/.relay-key), never committed.
const SAFE_ABI = [{
  type: 'function', stateMutability: 'payable', name: 'execTransaction',
  inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'signatures', type: 'bytes' },
  ], outputs: [{ type: 'bool' }],
}] as const;

const RPC = process.env.GNOSIS_RPC || 'https://rpc.gnosischain.com';
// Only the CoWSafeWrapper is a permitted target (registerMetaOrder), so the relay can't be abused
// as an open relayer for arbitrary calls even with a valid owner signature.
const ALLOWED_TARGET = '0x531636e6e18F3A52c283aCCda39D7185E4597A37'.toLowerCase();

function relayAccount() {
  const key = process.env.RELAY_KEY
    ?? JSON.parse(readFileSync(`${homedir()}/.relay-key/safe-relay.json`, 'utf8'))[0].private_key;
  return privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
}

export async function POST(req: Request) {
  let b: { safe?: Hex; to?: Hex; data?: Hex; signatures?: Hex };
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const { safe, to, data, signatures } = b;
  if (!safe || !to || !data || !signatures) return NextResponse.json({ error: 'missing fields' }, { status: 400 });
  if (to.toLowerCase() !== ALLOWED_TARGET) return NextResponse.json({ error: 'target not allowed' }, { status: 403 });

  try {
    const account = relayAccount();
    const wallet = createWalletClient({ account, chain: gnosis, transport: http(RPC) });
    const pub = createPublicClient({ chain: gnosis, transport: http(RPC) });
    const ZERO = '0x0000000000000000000000000000000000000000' as const;
    const hash = await wallet.writeContract({
      address: safe, abi: SAFE_ABI, functionName: 'execTransaction',
      args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    return NextResponse.json({ ok: rcpt.status === 'success', txHash: hash, relay: account.address });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
