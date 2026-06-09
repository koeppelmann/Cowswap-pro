import { NextResponse } from 'next/server';
import { cowBase } from '../../../lib/cowApiBase';

export const runtime = 'nodejs';

const COW_NET: Record<number, string> = { 1: 'mainnet', 100: 'xdai' };

export type Leg = { sellAmount: string; buyAmount: string; orderUid: string; txHash?: string; blockNumber?: number };

// Lazily fetch the individual fills (legs) of one TWAP Safe from CoW — called
// only when an order row is expanded, so it's one CoW request per opened order.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chainId = Number(u.searchParams.get('chainId'));
  const safe = u.searchParams.get('safe');
  const net = COW_NET[chainId];
  if (!net || !safe) return NextResponse.json({ legs: [] }, { status: 400 });
  try {
    const { url, headers } = cowBase(net);
    const r = await fetch(`${url}/api/v1/trades?owner=${safe}`, { cache: 'no-store', headers });
    if (!r.ok) return NextResponse.json({ legs: [] });
    const raw = (await r.json()) as Array<Record<string, unknown>>;
    const legs: Leg[] = raw.map((t) => ({
      sellAmount: String(t.sellAmount ?? '0'),
      buyAmount: String(t.buyAmount ?? '0'),
      orderUid: String(t.orderUid ?? ''),
      txHash: typeof t.txHash === 'string' ? t.txHash : undefined,
      blockNumber: typeof t.blockNumber === 'number' ? t.blockNumber : undefined,
    }));
    return NextResponse.json({ legs });
  } catch {
    return NextResponse.json({ legs: [] });
  }
}
