import { NextResponse } from 'next/server';
import { cowBase } from '../../../lib/cowApiBase';

export const runtime = 'nodejs';

const COW_NET: Record<number, string> = { 1: 'mainnet', 100: 'xdai' };

// Generic CoW orderbook proxy: registers full appData and posts orders.
// kind 'appData' → PUT /app_data/{hash} { fullAppData }
// kind 'order'   → POST /orders { ...orderBody }
export async function POST(req: Request) {
  let b: { chainId?: number; kind?: string; appDataHash?: string; fullAppData?: string; order?: unknown };
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const net = COW_NET[Number(b.chainId)];
  if (!net) return NextResponse.json({ error: 'unsupported chain' }, { status: 400 });
  const { url, headers } = cowBase(net);
  try {
    if (b.kind === 'appData') {
      if (!b.appDataHash || !b.fullAppData) return NextResponse.json({ error: 'missing appData' }, { status: 400 });
      const r = await fetch(`${url}/api/v1/app_data/${b.appDataHash}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ fullAppData: b.fullAppData }), cache: 'no-store' });
      return NextResponse.json({ ok: r.ok || r.status === 400, status: r.status });
    }
    if (b.kind === 'order') {
      if (!b.order) return NextResponse.json({ error: 'missing order' }, { status: 400 });
      const r = await fetch(`${url}/api/v1/orders`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(b.order), cache: 'no-store' });
      const text = await r.text();
      let uid: string | null = null;
      try { uid = JSON.parse(text); } catch { /* error body */ }
      return NextResponse.json({ ok: r.ok, status: r.status, uid, raw: text }, { status: r.ok ? 200 : 200 });
    }
    return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
