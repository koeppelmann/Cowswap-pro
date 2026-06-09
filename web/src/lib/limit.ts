import { formatUnits, parseUnits } from 'viem';

// All conversions revolve around `minPartLimit` (min buyToken per part, base units)
// given the market per-part quote `legBuy`. The three user-facing views —
// slippage %, total min-receive, and min price (buy per sell) — are equivalent.

export function minPartFromSlippage(legBuy: bigint, slippageBps: number): bigint {
  // Negative slippage = a premium limit (min price above market) — allowed.
  // Upper bound 100% (minPart -> 0); lower bound caps the premium at ~100x.
  const bps = BigInt(Math.max(-1_000_000, Math.min(10_000, Math.round(slippageBps))));
  return (legBuy * (10_000n - bps)) / 10_000n;
}

export function slippageBpsFromMinPart(minPart: bigint, legBuy: bigint): number {
  if (legBuy <= 0n) return 0;
  const ratio = Number(minPart) / Number(legBuy);
  // allow negative (premium); cap upper at 100%.
  return Math.max(-1_000_000, Math.min(10_000, Math.round((1 - ratio) * 10_000)));
}

export function minReceiveTotalStr(minPart: bigint, n: bigint, buyDec: number, maxFrac = 6): string {
  return trim(formatUnits(minPart * n, buyDec), maxFrac);
}

export function minPriceStr(minPart: bigint, partSell: bigint, buyDec: number, sellDec: number): string {
  if (partSell <= 0n) return '';
  const price = Number(formatUnits(minPart, buyDec)) / Number(formatUnits(partSell, sellDec));
  return Number(price.toPrecision(8)).toString();
}

/** total min-receive (human) -> minPartLimit (base units), or null if unparseable */
export function minPartFromReceiveTotal(recv: string, n: bigint, buyDec: number): bigint | null {
  if (n <= 0n) return null;
  try {
    return parseUnits(recv.trim() || '0', buyDec) / n;
  } catch {
    return null;
  }
}

/** min price (buy per sell, human) -> minPartLimit (base units), or null */
export function minPartFromPrice(price: string, partSell: bigint, buyDec: number, sellDec: number): bigint | null {
  const p = Number(price);
  if (!isFinite(p) || p < 0) return null;
  const partSellHuman = Number(formatUnits(partSell, sellDec));
  const minPartHuman = p * partSellHuman;
  try {
    return parseUnits(minPartHuman.toFixed(Math.min(buyDec, 18)), buyDec);
  } catch {
    return null;
  }
}

function trim(s: string, maxFrac: number): string {
  if (!s.includes('.')) return s;
  const [i, f] = s.split('.');
  const t = f.slice(0, maxFrac).replace(/0+$/, '');
  return t ? `${i}.${t}` : i;
}
