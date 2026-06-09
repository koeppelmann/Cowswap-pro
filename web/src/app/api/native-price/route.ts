import { NextResponse } from 'next/server';
import { cowBase } from '../../../lib/cowApiBase';

const COW_NET: Record<number, string> = { 1: 'mainnet', 100: 'xdai' };

async function nativePrice(net: string, token: string): Promise<number | null> {
  try {
    const { url, headers } = cowBase(net);
    const r = await fetch(`${url}/api/v1/token/${token}/native_price`, { cache: 'no-store', headers });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.price === 'number' ? d.price : null;
  } catch {
    return null;
  }
}

// CoW native_price = native atoms per 1 token atom. Returns both so the client
// can compute a size-independent spot rate.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chainId = Number(u.searchParams.get('chainId'));
  const sell = u.searchParams.get('sell');
  const buy = u.searchParams.get('buy');
  const net = COW_NET[chainId];
  if (!net || !sell || !buy) return NextResponse.json({ error: 'bad params' }, { status: 400 });
  const [sellPrice, buyPrice] = await Promise.all([nativePrice(net, sell), nativePrice(net, buy)]);
  return NextResponse.json({ sellPrice, buyPrice });
}
