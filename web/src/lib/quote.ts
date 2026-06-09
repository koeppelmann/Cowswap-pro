import type { Address } from 'viem';

export type Quote = {
  sellAmount: bigint; // net of fee
  buyAmount: bigint;
  feeAmount: bigint;
};

export type QuoteResult = {
  /** quote for one TWAP leg (partSellAmount) */
  leg: Quote;
  /** quote for the whole order in one shot (totalSell) */
  full: Quote;
};

export async function fetchQuote(params: {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  from: Address;
  sellAmount: bigint;
}): Promise<Quote> {
  const res = await fetch('/api/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: params.chainId,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      from: params.from,
      sellAmount: params.sellAmount.toString(),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'quote failed');
  return {
    sellAmount: BigInt(data.sellAmount),
    buyAmount: BigInt(data.buyAmount),
    feeAmount: BigInt(data.feeAmount),
  };
}

/** minPartLimit = leg market buyAmount × (1 − slippage). */
export function minPartLimitFromQuote(legBuyAmount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (legBuyAmount * (10_000n - bps)) / 10_000n;
}

/**
 * Price-impact saved by slicing: expected TWAP proceeds (leg×n) vs selling the
 * whole size at once (full). Positive bps means the TWAP is expected to net more.
 * Returns basis points (can be negative).
 */
export function twapAdvantageBps(legBuyAmount: bigint, n: bigint, fullBuyAmount: bigint): number {
  if (fullBuyAmount === 0n) return 0;
  const twapTotal = legBuyAmount * n;
  const diff = twapTotal - fullBuyAmount;
  return Number((diff * 10_000n) / fullBuyAmount);
}
