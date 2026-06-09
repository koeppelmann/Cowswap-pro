import { formatUnits } from 'viem';
import type { OrderRow } from './useOrders';

export type EnrichedOrder = OrderRow & {
  deployed: boolean;
  active: boolean; // ComposableCoW.singleOrders == true
  filledParts: number;
  executedSell: string;
  executedBuy: string;
  remainingSell: string;
  startTime: number; // cabinet start (0 if not set)
  allowance?: string; // sellToken.allowance(owner, safe)
  statusAt?: number; // when on-chain status was last refreshed (0 = never)
};

export type OrderState = 'awaiting' | 'approved' | 'active' | 'partial' | 'settled' | 'filled' | 'cancelled' | 'expired';

/** Funded parts K = totalSell / partSell (≤ n when a skip buffer adds extra windows). */
export function fundedParts(o: EnrichedOrder): number {
  try {
    const ps = BigInt(o.partSell);
    if (ps > 0n) return Number(BigInt(o.totalSell) / ps);
  } catch { /* ignore */ }
  return o.n;
}

export function deriveState(o: EnrichedOrder, nowSec: number): { state: OrderState; label: string; tone: string } {
  // "Start now" orders begin at deploy ≈ createdAt; use cabinet startTime when known.
  // end uses o.n (the WINDOWS count, incl. skip-buffer tail) = the full schedule.
  const start = o.startTime > 0 ? o.startTime : o.createdAt;
  const end = start > 0 ? start + o.n * o.t : 0;
  if (!o.deployed) {
    // Allowance ≥ total sell means the user approved but the safe was never deployed.
    try {
      if (o.allowance && BigInt(o.allowance) >= BigInt(o.totalSell) && BigInt(o.totalSell) > 0n) {
        return { state: 'approved', label: 'Approved · awaiting deploy', tone: 'warn' };
      }
    } catch { /* ignore */ }
    return { state: 'awaiting', label: 'Not started', tone: '' };
  }

  let remaining = 0n;
  try { remaining = BigInt(o.remainingSell || '0'); } catch { /* ignore */ }
  const K = fundedParts(o);
  const filled = o.filledParts;

  // All funded parts actually filled ⇒ fully executed. (NOT "balance == 0": a
  // partially-filled order whose leftover was withdrawn also has balance 0.)
  if (filled >= K) return { state: 'filled', label: 'Fully executed', tone: 'good' };

  // Can more still fill? Needs the order live, within its window, and still funded.
  const ended = end > 0 && nowSec > end;
  const canFillMore = o.active && !ended && remaining > 0n;
  if (canFillMore) {
    if (filled > 0) return { state: 'partial', label: `Partial · ${filled}/${K}`, tone: 'warn' };
    return { state: 'active', label: `Active · 0/${K}`, tone: '' };
  }

  // Settled — no more fills possible.
  if (filled > 0) return { state: 'settled', label: `Partial · ${filled}/${K}`, tone: 'warn' };
  if (!o.active) return { state: 'cancelled', label: 'Cancelled', tone: 'bad' };
  return { state: 'expired', label: 'Expired · unfilled', tone: 'bad' };
}

/** Orders that can no longer fill any parts but may still hold un-sold sellToken. */
export function isSettled(state: OrderState): boolean {
  return state === 'settled' || state === 'expired' || state === 'cancelled' || state === 'filled';
}

/** Average executed price as buyToken per sellToken (human units), or null if nothing filled. */
export function avgPrice(o: EnrichedOrder, sellDecimals?: number, buyDecimals?: number): number | null {
  if (sellDecimals == null || buyDecimals == null) return null;
  const sell = Number(formatUnits(BigInt(o.executedSell), sellDecimals));
  const buy = Number(formatUnits(BigInt(o.executedBuy), buyDecimals));
  if (sell <= 0) return null;
  return buy / sell;
}
