import { NextResponse } from 'next/server';
import { cowBase } from '../../../lib/cowApiBase';
import { APP_DATA_DOC, APP_DATA_HASH } from '../../../lib/appData';

export const runtime = 'nodejs';

const COW_NET: Record<number, string> = { 1: 'mainnet', 100: 'xdai' };

// Register our static appData document with the CoW orderbook so the hash baked
// into orders resolves to { appCode, orderClass } for attribution/analytics.
// Idempotent: PUT /api/v1/app_data/{hash} { fullAppData }. Best-effort — the hash
// is valid on-chain regardless. Called from the confirm flow.
export async function POST(req: Request) {
  let chainId = 0;
  try { chainId = Number((await req.json())?.chainId); } catch { /* ignore */ }
  const net = COW_NET[chainId];
  if (!net) return NextResponse.json({ error: 'bad chain' }, { status: 400 });
  try {
    const { url, headers } = cowBase(net);
    const r = await fetch(`${url}/api/v1/app_data/${APP_DATA_HASH}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ fullAppData: APP_DATA_DOC }),
      cache: 'no-store',
    });
    // 200/201 = stored; 400 "already exists" is also fine.
    return NextResponse.json({ ok: r.ok || r.status === 400, status: r.status, hash: APP_DATA_HASH });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
