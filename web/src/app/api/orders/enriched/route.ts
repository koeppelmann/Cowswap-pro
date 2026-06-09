import { NextResponse } from 'next/server';
import { listOrders, type OrderRow, type OrderStatusJSON } from '../../../../lib/db';
import { refreshOwnerIfStale } from '../../../../lib/refresh';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 24;
const BLANK: OrderStatusJSON = { deployed: false, active: false, filledParts: 0, executedSell: '0', executedBuy: '0', remainingSell: '0', startTime: 0 };

// Instant: pure DB read. On-chain status is refreshed in the background and
// written to the DB, so the request path never blocks on (rate-limited) RPCs.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chainId = Number(u.searchParams.get('chainId'));
  const owner = u.searchParams.get('owner');
  const all = u.searchParams.get('all') === '1';
  const limit = Number(u.searchParams.get('limit')) || DEFAULT_LIMIT;
  if (!chainId || !owner) return NextResponse.json({ error: 'bad params' }, { status: 400 });

  const allRows = listOrders(chainId, owner); // newest-first

  // kick a background refresh (debounced) — one lens eth_call covers ALL orders
  refreshOwnerIfStale(chainId, owner);

  // Always parse all rows (DB read is cheap). Drafts/Not-started are collapsed
  // client-side, so returning everything ensures real orders are never buried
  // below recently-created drafts. `all`/`limit` kept for API compatibility.
  const parsed = allRows.map((o: OrderRow) => {
    let st: OrderStatusJSON = BLANK;
    try { if (o.status) st = JSON.parse(o.status) as OrderStatusJSON; } catch { /* keep blank */ }
    return { ...o, ...st, statusAt: o.statusAt ?? 0 };
  });

  void all; void limit; // accepted for API compatibility; lens makes full read cheap
  return NextResponse.json({ orders: parsed, total: allRows.length, shown: parsed.length });
}
