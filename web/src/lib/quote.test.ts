import { describe, expect, it } from 'vitest';
import { minPartLimitFromQuote, twapAdvantageBps } from './quote';

describe('quote pricing math', () => {
  it('applies slippage to derive minPartLimit', () => {
    // 1.0 buy token, 0.5% slippage -> 0.995
    expect(minPartLimitFromQuote(1_000_000_000_000_000_000n, 50)).toBe(995_000_000_000_000_000n);
    // 1% slippage
    expect(minPartLimitFromQuote(1_000_000_000_000_000_000n, 100)).toBe(990_000_000_000_000_000n);
    // 0 slippage -> unchanged
    expect(minPartLimitFromQuote(12_345n, 0)).toBe(12_345n);
  });

  it('clamps slippage to [0, 100%]', () => {
    expect(minPartLimitFromQuote(1000n, -5)).toBe(1000n);
    expect(minPartLimitFromQuote(1000n, 20_000)).toBe(0n);
  });

  it('computes TWAP advantage vs full-size in bps', () => {
    // leg=0.011 GNO, n=5 -> 0.055; full=0.0500 -> +10%
    expect(twapAdvantageBps(11n, 5n, 50n)).toBe(1000);
    // no advantage
    expect(twapAdvantageBps(10n, 5n, 50n)).toBe(0);
    // worse when sliced
    expect(twapAdvantageBps(9n, 5n, 50n)).toBe(-1000);
    expect(twapAdvantageBps(10n, 5n, 0n)).toBe(0);
  });
});
