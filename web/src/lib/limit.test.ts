import { describe, expect, it } from 'vitest';
import { minPartFromSlippage, slippageBpsFromMinPart } from './limit';

describe('limit math', () => {
  const legBuy = 1_000_000_000_000_000_000n; // 1.0 buy per part (market)

  it('positive slippage lowers the min', () => {
    expect(minPartFromSlippage(legBuy, 50)).toBe(995_000_000_000_000_000n); // 0.5%
  });

  it('round-trips slippage <-> minPart', () => {
    expect(slippageBpsFromMinPart(minPartFromSlippage(legBuy, 250), legBuy)).toBe(250);
  });

  it('allows NEGATIVE slippage (min price above market / premium limit)', () => {
    // min = 1.02 (above market) -> slippage = -2%
    const minPart = 1_020_000_000_000_000_000n;
    expect(slippageBpsFromMinPart(minPart, legBuy)).toBe(-200);
    // and back: -2% slippage -> min 1.02
    expect(minPartFromSlippage(legBuy, -200)).toBe(1_020_000_000_000_000_000n);
  });

  it('caps slippage at 100% (min cannot go to/below 0)', () => {
    expect(minPartFromSlippage(legBuy, 12_000)).toBe(0n);
  });
});
