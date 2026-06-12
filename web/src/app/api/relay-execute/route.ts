import { NextResponse } from 'next/server';
import { createWalletClient, createPublicClient, http, decodeEventLog, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const runtime = 'nodejs';

// Relay a signed Retarget intent through LevManagerModule.execute (gas paid by the relay EOA).
// The relay can only land what the owner signed; it cannot forge intents.
const MODULE_V5 = '0x239D413A6Ac5322D3ccAaaf43e34045bdAcD7E74'; // current
const MODULE_V4 = '0xbd913B8626DD7ACe1810E1797C93f27dD7906A5C'; // Safes opened before v5 still use this
const MODULES: Record<string, string> = { v5: MODULE_V5, v4: MODULE_V4 };
const RPC = process.env.GNOSIS_RPC || 'https://rpc.gnosischain.com';

const FIELDS_V4 = [
  { name: 'safe', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  { name: 'mode', type: 'uint8' }, { name: 'collateral', type: 'address' }, { name: 'debt', type: 'address' },
  { name: 'sellAmount', type: 'uint256' }, { name: 'repayAmount', type: 'uint256' }, { name: 'minBuy', type: 'uint256' },
  { name: 'flash', type: 'uint256' }, { name: 'orderValidTo', type: 'uint32' }, { name: 'minHealthFactor', type: 'uint256' },
  { name: 'receiver', type: 'address' }, { name: 'triggerHealthFactor', type: 'uint256' },
];
const REGISTERED_EVT = { type: 'event', name: 'Registered', inputs: [
  { name: 'safe', type: 'address', indexed: true }, { name: 'nonce', type: 'uint256' }, { name: 'mode', type: 'uint8' },
  { name: 'uid', type: 'bytes' }, { name: 'appDataHash', type: 'bytes32' }, { name: 'fullAppData', type: 'string' }] };
const abiFor = (v4: boolean) => [
  { type: 'function', stateMutability: 'nonpayable', name: 'execute',
    inputs: [{ type: 'tuple', name: 'r', components: v4 ? FIELDS_V4 : [...FIELDS_V4, { name: 'withdrawExtra', type: 'uint256' }] }, { name: 'sig', type: 'bytes' }],
    outputs: [{ type: 'bytes' }] },
  REGISTERED_EVT,
] as const;

function relayAccount() {
  const key = process.env.RELAY_KEY ?? JSON.parse(readFileSync(`${homedir()}/.relay-key/safe-relay.json`, 'utf8'))[0].private_key;
  return privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
}

// idempotency: one in-flight relay per (safe, nonce) — concurrent duplicates of the same valid
// intent would all pass simulation, then all-but-one revert on 'used' with the relay paying gas
// (codex medium finding). Entries are dropped when the request settles.
const inFlight = new Map<string, true>();

export async function POST(req: Request) {
  let b: { intent?: Record<string, string>; sig?: Hex; module?: string };
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  if (!b.intent || !b.sig) return NextResponse.json({ error: 'missing intent/sig' }, { status: 400 });
  // module selection is WHITELISTED — the relay never calls arbitrary addresses
  const MODULE = Object.values(MODULES).find((m) => m.toLowerCase() === (b.module ?? MODULE_V5).toLowerCase());
  if (!MODULE) return NextResponse.json({ error: 'unknown module' }, { status: 400 });
  const isV4 = MODULE.toLowerCase() === MODULE_V4.toLowerCase();
  const ABI = abiFor(isV4) as any;
  const i = b.intent;
  let tuple;
  try {
    tuple = {
      safe: i.safe as Hex, nonce: BigInt(i.nonce), deadline: BigInt(i.deadline), mode: Number(i.mode),
      collateral: i.collateral as Hex, debt: i.debt as Hex, sellAmount: BigInt(i.sellAmount), repayAmount: BigInt(i.repayAmount),
      minBuy: BigInt(i.minBuy), flash: BigInt(i.flash), orderValidTo: Number(i.orderValidTo), minHealthFactor: BigInt(i.minHealthFactor),
      receiver: (i.receiver ?? '0x0000000000000000000000000000000000000000') as Hex,
      triggerHealthFactor: BigInt(i.triggerHealthFactor ?? '0'),
      withdrawExtra: BigInt(i.withdrawExtra ?? '0'),
    };
    if (isV4) delete (tuple as Record<string, unknown>).withdrawExtra; // v4 struct has 14 fields
  } catch { return NextResponse.json({ error: 'malformed intent fields' }, { status: 400 }); }
  const lockKey = `${tuple.safe.toLowerCase()}:${tuple.nonce}`;
  if (inFlight.has(lockKey)) return NextResponse.json({ ok: false, error: 'this intent is already being relayed — wait for it to settle' });
  inFlight.set(lockKey, true);
  try {
    const account = relayAccount();
    const wallet = createWalletClient({ account, chain: gnosis, transport: http(RPC) });
    const pub = createPublicClient({ chain: gnosis, transport: http(RPC) });
    // 1) simulate via eth_call (no fee accounting) — surfaces a clean revert reason up front.
    await pub.simulateContract({ address: MODULE as Hex, abi: ABI, functionName: 'execute', args: [tuple, b.sig], account });
    // 2) send with EXPLICIT gas + price, skipping eth_estimateGas entirely (flaky on the public
    //    RPC) . viem's default 1559 estimation once picked a ~4 wei priority fee, leaving the tx
    //    permanently under-priced and unmineable — the relay request then hung until the edge proxy
    //    returned an HTML timeout page. 3× the live price guarantees inclusion (Gnosis gas is
    //    mwei-scale, so this costs fractions of a cent); 4M gas covers execute (~2.3M measured).
    const gasPrice = (await pub.getGasPrice()) * 3n;
    const hash = await wallet.writeContract({ address: MODULE as Hex, abi: ABI, functionName: 'execute', args: [tuple, b.sig], gas: 4_000_000n, gasPrice });
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
        const ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics }) as { eventName: string; args: unknown };
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
  } finally {
    inFlight.delete(lockKey);
  }
}
