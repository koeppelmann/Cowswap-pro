import { type Address, formatUnits, parseUnits } from 'viem';

export function shortAddress(addr?: string, chars = 4): string {
  if (!addr) return '';
  return `${addr.slice(0, 2 + chars)}…${addr.slice(-chars)}`;
}

/** Parse a human decimal string to base units; returns null on invalid input. */
export function tryParseUnits(value: string, decimals: number): bigint | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^\d*\.?\d*$/.test(v) || v === '.') return null;
  try {
    return parseUnits(v, decimals);
  } catch {
    return null;
  }
}

/** Human-friendly amount: thousands separators, ~5 significant figures, trimmed. */
export function dispAmount(value: bigint, decimals: number): string {
  const n = Number(formatUnits(value, decimals));
  if (n === 0) return '0';
  const abs = Math.abs(n);
  // magnitude-aware: 2 decimals for ≥100 (grouped), 4 sig figs otherwise.
  if (abs >= 100) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return Number(n.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });
  return Number(n.toPrecision(4)).toString();
}

export function fmtAmount(value: bigint, decimals: number, maxFrac = 6): string {
  const s = formatUnits(value, decimals);
  if (!s.includes('.')) return s;
  const [int, frac] = s.split('.');
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, '');
  return trimmed ? `${int}.${trimmed}` : int;
}

export type Duration = { value: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' };

const UNIT_SECONDS: Record<Duration['unit'], number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
  weeks: 604800,
  months: 2592000, // 30 days
};

export function durationToSeconds(d: Duration): bigint {
  return BigInt(Math.round(d.value * UNIT_SECONDS[d.unit]));
}

/** Human label for a Duration, e.g. "1 day", "30 min", "1 week". */
export function durationLabel(d: Duration): string {
  const short = d.unit === 'minutes' ? 'min' : d.unit;
  const unit = d.value === 1 ? short.replace(/s$/, '') : short;
  return `${d.value} ${unit}`;
}

export function humanizeSeconds(total: bigint): string {
  const s = Number(total);
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

export function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Format a buy-per-sell rate, optionally flipped to sell-per-buy. */
export function fmtRate(
  buyPerSell: number | null | undefined,
  flip: boolean,
  sellSym: string,
  buySym: string,
): string {
  if (buyPerSell == null || !isFinite(buyPerSell) || buyPerSell <= 0) return '—';
  const v = flip ? 1 / buyPerSell : buyPerSell;
  const unit = flip ? `${sellSym}/${buySym}` : `${buySym}/${sellSym}`;
  const num = Number(v.toPrecision(5));
  return `${num.toLocaleString('en-US', { maximumSignificantDigits: 5 })} ${unit}`;
}

/** Like fmtRate but returns the number and unit separately (for styling the unit). */
export function rateParts(
  buyPerSell: number | null | undefined,
  flip: boolean,
  sellSym: string,
  buySym: string,
): { num: string; unit: string } | null {
  if (buyPerSell == null || !isFinite(buyPerSell) || buyPerSell <= 0) return null;
  const v = flip ? 1 / buyPerSell : buyPerSell;
  const unit = flip ? `${sellSym}/${buySym}` : `${buySym}/${sellSym}`;
  const num = Number(v.toPrecision(5)).toLocaleString('en-US', { maximumSignificantDigits: 5 });
  return { num, unit };
}
