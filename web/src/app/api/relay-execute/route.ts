import { NextResponse } from 'next/server';
import { createWalletClient, createPublicClient, http, decodeEventLog, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const runtime = 'nodejs';

// Relay a signed Retarget intent through LevManagerModule.execute (gas paid by the relay EOA).
// The relay can only land what the owner signed; it cannot forge intents.
const MODULE = '0xd504138eD8d6bF01A6C2c3e6f83298aE7242E985';
const RPC = process.env.GNOSIS_RPC || 'https://rpc.gnosischain.com';

const RETARGET = {
  type: 'tuple', name: 'r', components: [
    { name: 'safe', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'mode', type: 'uint8' }, { name: 'collateral', type: 'address' }, { name: 'debt', type: 'address' },
    { name: 'sellAmount', type: 'uint256' }, { name: 'repayAmount', type: 'uint256' }, { name: 'minBuy', type: 'uint256' },
    { name: 'flash', type: 'uint256' }, { name: 'orderValidTo', type: 'uint32' }, { name: 'minHealthFactor', type: 'uint256' },
  ],
} as const;
const ABI = [
  { type: 'function', stateMutability: 'nonpayable', name: 'execute', inputs: [RETARGET, { name: 'sig', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'event', name: 'Registered', inputs: [
    { name: 'safe', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'mode', type: 'uint8' },
    { name: 'uid', type: 'bytes' }, { name: 'appDataHash', type: 'bytes32' }, { name: 'fullAppData', type: 'string' }] },
] as const;

function relayAccount() {
  const key = process.env.RELAY_KEY ?? JSON.parse(readFileSync(`${homedir()}/.relay-key/safe-relay.json`, 'utf8'))[0].private_key;
  return privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
}

export async function POST(req: Request) {
  let b: { intent?: Record<string, string>; sig?: Hex };
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  if (!b.intent || !b.sig) return NextResponse.json({ error: 'missing intent/sig' }, { status: 400 });
  const i = b.intent;
  const tuple = {
    safe: i.safe as Hex, nonce: BigInt(i.nonce), deadline: BigInt(i.deadline), mode: Number(i.mode),
    collateral: i.collateral as Hex, debt: i.debt as Hex, sellAmount: BigInt(i.sellAmount), repayAmount: BigInt(i.repayAmount),
    minBuy: BigInt(i.minBuy), flash: BigInt(i.flash), orderValidTo: Number(i.orderValidTo), minHealthFactor: BigInt(i.minHealthFactor),
  };
  try {
    const account = relayAccount();
    const wallet = createWalletClient({ account, chain: gnosis, transport: http(RPC) });
    const pub = createPublicClient({ chain: gnosis, transport: http(RPC) });
    // Price the tx explicitly with a buffer above the live gas price. viem's default 1559
    // estimation on the Gnosis public RPC can pick a priority fee of a few wei, leaving the tx
    // permanently under-priced and unmineable — which made the relay request hang until the edge
    // proxy returned an HTML timeout page. Legacy gasPrice = 2× live (+ a floor) guarantees inclusion.
    const live = await pub.getGasPrice();
    const gasPrice = (live > 2_000_000_000n ? live : 2_000_000_000n) * 2n; // ≥ ~2 gwei, then ×2
    const hash = await wallet.writeContract({ address: MODULE as Hex, abi: ABI, functionName: 'execute', args: [tuple, b.sig], gasPrice });
    // Bounded wait: never let this request run long enough to trip an edge/proxy HTML timeout
    // (a Cloudflare 524 HTML page would make the client's `.json()` choke on "<!DOCTYPE"). On
    // Gnosis (~5s blocks) 90s is ample; if it isn't mined we return JSON with the hash to poll.
    // NOTE: error responses below use HTTP 200 + ok:false. Cloudflare replaces origin 5xx
    // responses with its own HTML error page, so a JSON 502 never reaches the browser.
    let rcpt;
    try {
      rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    } catch {
      return NextResponse.json({ ok: false, pending: true, error: 'relay tx not mined within 90s — it may still land', txHash: hash });
    }
    if (rcpt.status !== 'success') return NextResponse.json({ ok: false, error: 'execute reverted', txHash: hash });
    // parse Registered
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== MODULE.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
        if (ev.eventName === 'Registered') {
          const a = ev.args as { uid: Hex; appDataHash: Hex; fullAppData: string };
          return NextResponse.json({ ok: true, txHash: hash, uid: a.uid, appDataHash: a.appDataHash, fullAppData: a.fullAppData });
        }
      } catch { /* not our event */ }
    }
    return NextResponse.json({ ok: false, error: 'no Registered event', txHash: hash });
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[relay-execute] failed:', msg);
    // surface a short reason (viem errors bury the revert string in a multi-line message)
    const m = msg.match(/reverted with the following reason:\s*\n?([^\n]+)/);
    return NextResponse.json({ ok: false, error: m ? `execute would revert: ${m[1].trim()}` : msg.split('\n')[0] });
  }
}
