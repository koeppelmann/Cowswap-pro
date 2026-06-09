import { NextResponse } from 'next/server';
import { cowBase } from '../../../lib/cowApiBase';

const COW_NETWORK: Record<number, string> = {
  1: 'mainnet',
  100: 'xdai',
};

// Server-side proxy to CoW's quote API: avoids browser CORS and keeps the
// eip1271 request shape in one place.
export async function POST(req: Request) {
  let body: {
    chainId?: number;
    sellToken?: string;
    buyToken?: string;
    from?: string;
    sellAmount?: string; // before fee, base units
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const { chainId, sellToken, buyToken, from, sellAmount } = body;
  const network = chainId != null ? COW_NETWORK[chainId] : undefined;
  if (!network) return NextResponse.json({ error: 'unsupported chain' }, { status: 400 });
  if (!sellToken || !buyToken || !sellAmount || !from) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 });
  }

  const { url, headers } = cowBase(network);
  try {
    const r = await fetch(`${url}/api/v1/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        sellToken,
        buyToken,
        from,
        receiver: from,
        sellAmountBeforeFee: sellAmount,
        kind: 'sell',
        signingScheme: 'eip1271',
        onchainOrder: false,
        appData: '{}',
      }),
      // CoW quotes are short-lived; never cache.
      cache: 'no-store',
    });
    const data = await r.json();
    if (!r.ok) {
      return NextResponse.json(
        { error: data?.description || data?.errorType || 'quote failed' },
        { status: r.status },
      );
    }
    const q = data.quote ?? {};
    return NextResponse.json({
      sellAmount: q.sellAmount as string,
      buyAmount: q.buyAmount as string,
      feeAmount: q.feeAmount as string,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
