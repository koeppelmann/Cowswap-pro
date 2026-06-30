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
    if (op === 'accountOrders') {
      // the owner's barn orders — used to discover their leverage Safes (the
      // in-kind carrier's receiver) without relying on browser localStorage.
      const limit = Math.min(Number(b.limit) || 100, 500);
      const r = await fetch(`${BARN}/account/${b.owner}/orders?limit=${limit}`, { cache: 'no-store' });
      if (!r.ok) return NextResponse.json({ status: r.status, body: [] });
      const j = await r.json() as Array<Record<string, unknown>>;
      // slim payload: what Safe-discovery + position P&L need. executed* let us
      // read the realized open-swap rate (debt spent → collateral bought) for
      // oracle-free closed-position P&L.
      const body = (Array.isArray(j) ? j : []).map((o) => ({
        sellToken: o.sellToken, buyToken: o.buyToken, receiver: o.receiver, fullAppData: o.fullAppData,
        sellAmount: o.sellAmount, creationDate: o.creationDate, status: o.status,
        executedSellAmount: o.executedSellAmount, executedBuyAmount: o.executedBuyAmount,
      }));
      return NextResponse.json({ status: r.status, body });
    }
    return NextResponse.json({ error: 'unknown op' }, { status: 400 });
  } catch (e) {
    // HTTP 200 + error field: Cloudflare replaces origin 5xx bodies with its own HTML page,
    // which the browser would then fail to parse as JSON.
    console.error('[barn] failed:', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message });
  }
}
