import { NextResponse } from 'next/server';
import { listOrders, upsertOrder, type OrderRow } from '../../../lib/db';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let b: Partial<OrderRow>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const required = [
    'safe', 'chainId', 'owner', 'receiver', 'sellToken', 'buyToken',
    'totalSell', 'partSell', 'minPartLimit', 'n', 't', 'orderHash', 'singleton', 'saltNonce', 'initializer',
  ] as const;
  for (const k of required) {
    if (b[k] === undefined || b[k] === null) return NextResponse.json({ error: `missing ${k}` }, { status: 400 });
  }
  try {
    upsertOrder(b as Omit<OrderRow, 'createdAt'>);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const chainId = Number(u.searchParams.get('chainId'));
  const owner = u.searchParams.get('owner');
  if (!chainId || !owner) return NextResponse.json({ error: 'chainId and owner required' }, { status: 400 });
  return NextResponse.json({ orders: listOrders(chainId, owner) });
}
