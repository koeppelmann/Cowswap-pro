import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Server-side proxy to CoW's STAGING/barn orderbook (no key needed; avoids browser CORS).
// One route, dispatched on `op`: quote | appdata | order | status.
const BARN = 'https://barn.api.cow.fi/xdai/api/v1';

export async function POST(req: Request) {
  let b: { op?: string; [k: string]: unknown };
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const op = b.op;

  try {
    if (op === 'quote') {
      const r = await fetch(`${BARN}/quote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sellToken: b.sellToken, buyToken: b.buyToken, from: b.from,
          kind: 'sell', sellAmountBeforeFee: b.sellAmount, signingScheme: 'eip1271',
        }), cache: 'no-store',
      });
      const j = await r.json();
      return NextResponse.json({ status: r.status, body: j });
    }
    if (op === 'appdata') {
      const r = await fetch(`${BARN}/app_data/${b.hash}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullAppData: b.fullAppData }), cache: 'no-store',
      });
      return NextResponse.json({ ok: r.ok || r.status === 400, status: r.status });
    }
    if (op === 'order') {
      const r = await fetch(`${BARN}/orders`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b.order), cache: 'no-store',
      });
      const txt = await r.text();
      let j: unknown; try { j = JSON.parse(txt); } catch { j = txt; }
      return NextResponse.json({ status: r.status, body: j });
    }
    if (op === 'status') {
      const r = await fetch(`${BARN}/orders/${b.uid}`, { cache: 'no-store' });
      if (!r.ok) return NextResponse.json({ status: r.status, body: null });
      const j = await r.json();
      return NextResponse.json({
        status: r.status,
        body: { status: j.status, executedBuyAmount: j.executedBuyAmount, executedSellAmount: j.executedSellAmount },
      });
    }
    return NextResponse.json({ error: 'unknown op' }, { status: 400 });
  } catch (e) {
    // HTTP 200 + error field: Cloudflare replaces origin 5xx bodies with its own HTML page,
    // which the browser would then fail to parse as JSON.
    console.error('[barn] failed:', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message });
  }
}
