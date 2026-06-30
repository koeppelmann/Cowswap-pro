import { formatUnits, getAddress, parseAbiItem, type Address, type PublicClient } from 'viem';
import { erc20Abi } from './abi';
import { appCodeOf, LEV_CARRIER_APP_CODE } from './carrierHistory';
import { positionMetrics, type PositionMetrics } from './leverage';
import { ONBOARD, LEV_MODULE, LEV_MODULE_V4, POOL_ADDR } from './onboard';

// ---------------------------------------------------------------------------
// Shared leverage-position loading. The same live Aave read powers BOTH the Swap
// tab's position selector and the /orders portfolio view, so it lives here once.
// ---------------------------------------------------------------------------

const O = ONBOARD;

export type PosTok = { address: Address; symbol: string; decimals: number };
export type LivePos = {
  safe: Address; m: PositionMetrics; collQty: bigint; debtQty: bigint; availBase: bigint;
  collTok: PosTok; debtTok: PosTok;
  module: Address; // which LevManagerModule version this Safe has enabled (v4 Safes predate withdrawExtra)
};

// /api/aave-market shapes (which pairs can be levered + eMode categories)
export type AaveReserve = {
  address: Address; symbol: string; decimals: number; ltvBps: number; liqThresholdBps: number;
  collateralEnabled: boolean; borrowEnabled: boolean; active: boolean; frozen: boolean; paused: boolean; flashEnabled: boolean;
  aToken: Address; vDebtToken: Address;
};
export type AaveEMode = { id: number; label: string; ltvBps: number; liqThresholdBps: number; collateral: Address[]; borrowable: Address[] };
export type Market = { reserves: AaveReserve[]; emodes: AaveEMode[] };

const poolAbi = [
  { type: 'function', name: 'getUserAccountData', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
] as const;
const safeAbi = [
  { type: 'function', name: 'isOwner', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isModuleEnabled', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;

// localStorage helpers (shared with /onboard + /manage via the `levSafes` key)
export function loadSavedSafes(): Address[] {
  const set = new Set<string>();
  for (const k of ['levSafes', 'lev_safe_positions']) {
    try {
      const raw = JSON.parse(localStorage.getItem(k) || '[]');
      for (const e of raw) { const a = typeof e === 'string' ? e : e?.safe; if (a) set.add(a.toLowerCase()); }
    } catch { /* */ }
  }
  return [...set] as Address[];
}
export function saveSafe(safe: Address) {
  try {
    const a: string[] = JSON.parse(localStorage.getItem('levSafes') || '[]');
    if (!a.some((x) => x.toLowerCase() === safe.toLowerCase())) { a.unshift(safe); localStorage.setItem('levSafes', JSON.stringify(a.slice(0, 30))); }
  } catch { /* */ }
}

// A leverage funding carrier the owner signed: it deposited `initialEquity` of the
// debt token into the position Safe (receiver). One per open attempt.
export type LevCarrier = { safe: Address; initialEquity: bigint; debtToken: Address; createdAt: number; status: string };

// Discovering Safes from the barn leverage carriers (appCode LEV_CARRIER_APP_CODE,
// receiver = the Safe) means positions show up on ANY device, not just the browser
// that opened them — same frontend-only approach as TWAP history.
/**
 * Discover the account's leverage carriers from its barn orders (server-proxied).
 * Time-bounded so a slow/hung staging barn can never block rendering — on timeout
 * returns [] and callers fall back to localStorage Safes. De-duped per Safe (a
 * fulfilled carrier wins over an open/failed one for the same Safe).
 */
export async function discoverLeverageCarriers(owner: Address, timeoutMs = 6000): Promise<LevCarrier[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let j: { body?: Array<{ sellToken?: string; buyToken?: string; receiver?: string; fullAppData?: string | null; sellAmount?: string; creationDate?: string; status?: string }> };
    try {
      const r = await fetch('/api/barn', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'accountOrders', owner, limit: 200 }), signal: ctrl.signal,
      });
      j = await r.json();
    } finally { clearTimeout(t); }
    const bySafe = new Map<string, LevCarrier>();
    for (const o of j.body ?? []) {
      // one malformed order (missing/invalid tokens, bad checksum) must never nuke
      // the whole discovered set — skip it, keep the rest.
      try {
        if (!o.receiver || !o.sellToken || !o.buyToken || o.sellToken.toLowerCase() !== o.buyToken.toLowerCase()) continue; // in-kind carriers only
        if (appCodeOf(o.fullAppData) !== LEV_CARRIER_APP_CODE) continue;
        let eq = 0n; try { eq = BigInt(o.sellAmount ?? '0'); } catch { /* */ }
        const c: LevCarrier = {
          safe: getAddress(o.receiver), initialEquity: eq, debtToken: getAddress(o.sellToken),
          createdAt: Math.floor(new Date(o.creationDate ?? 0).getTime() / 1000) || 0, status: o.status ?? 'open',
        };
        const k = c.safe.toLowerCase();
        const prev = bySafe.get(k);
        if (!prev || (prev.status !== 'fulfilled' && c.status === 'fulfilled')) bySafe.set(k, c);
      } catch { /* skip this order */ }
    }
    return [...bySafe.values()].sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

/** Just the Safe addresses (localStorage callers / readPositions input). */
export async function discoverLeverageSafes(owner: Address, timeoutMs = 6000): Promise<Address[]> {
  return (await discoverLeverageCarriers(owner, timeoutMs)).map((c) => c.safe);
}

/**
 * Read live leverage positions for an explicit Safe list. Two multicalls TOTAL,
 * regardless of how many Safes: (1) a cheap gate (isOwner + both modules + Aave
 * account) for every candidate, then (2) reserve balances ONLY for the Safes that
 * survive the gate. The candidate set can be large (barn discovery returns one
 * Safe per past leverage carrier, mostly closed), so we never issue the heavy
 * per-reserve balance reads for Safes that aren't owned/open.
 *
 * Returns [] only for a GENUINE empty result (no owned/open Safes). A transport
 * failure (RPC down) PROPAGATES — callers must distinguish "no positions" from
 * "couldn't read", otherwise a blip would reclassify open positions as closed.
 */
export async function readPositions(publicClient: PublicClient, address: Address | undefined, safes: Address[], market: Market | null): Promise<LivePos[]> {
  if (!publicClient || !market || !address || safes.length === 0) return [];
  {
    // ── Phase 1: gate every candidate Safe (4 calls each, one multicall) ──
    const gate = await publicClient.multicall({
      allowFailure: true,
      contracts: safes.flatMap((safe) => [
        { address: safe, abi: safeAbi, functionName: 'isOwner', args: [address] } as const,
        { address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [LEV_MODULE] } as const,
        { address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [LEV_MODULE_V4] } as const,
        { address: POOL_ADDR as Address, abi: poolAbi, functionName: 'getUserAccountData', args: [safe] } as const,
      ]),
    });
    type Survivor = { safe: Address; module: Address; acct: readonly bigint[] };
    const survivors: Survivor[] = [];
    safes.forEach((safe, i) => {
      const o = i * 4;
      // owned by the connected account?
      if (!(gate[o]?.status === 'success' && gate[o].result === true)) return;
      // a known LevManagerModule enabled? (v4 Safes predate withdrawExtra — still manageable)
      const module = (gate[o + 1]?.status === 'success' && gate[o + 1].result) ? (LEV_MODULE as Address)
        : (gate[o + 2]?.status === 'success' && gate[o + 2].result) ? (LEV_MODULE_V4 as Address) : null;
      if (!module) return;
      const acct = gate[o + 3]?.status === 'success' ? (gate[o + 3].result as readonly bigint[]) : undefined;
      if (!acct || (acct[0] === 0n && acct[1] === 0n)) return; // closed / empty
      survivors.push({ safe, module, acct });
    });
    if (survivors.length === 0) return [];

    // ── Phase 2: reserve balances for survivors only (one multicall) ──
    const perSafe = market.reserves.length * 2;
    const bals = await publicClient.multicall({
      allowFailure: true,
      contracts: survivors.flatMap((s) => market.reserves.flatMap((r) => [
        { address: r.aToken, abi: erc20Abi, functionName: 'balanceOf', args: [s.safe] } as const,
        { address: r.vDebtToken, abi: erc20Abi, functionName: 'balanceOf', args: [s.safe] } as const,
      ])),
    });

    const live: LivePos[] = [];
    survivors.forEach((s, si) => {
      const base = si * perSafe;
      // a position is one collateral + one debt by construction — take the largest of each.
      let collR: AaveReserve | null = null, collQty = 0n, debtR: AaveReserve | null = null, debtQty = 0n;
      market.reserves.forEach((r, ri) => {
        const a = bals[base + ri * 2]?.status === 'success' ? (bals[base + ri * 2].result as bigint) : 0n;
        const v = bals[base + ri * 2 + 1]?.status === 'success' ? (bals[base + ri * 2 + 1].result as bigint) : 0n;
        if (a > collQty) { collQty = a; collR = r; }
        if (v > debtQty) { debtQty = v; debtR = r; }
      });
      if (!collR || collQty === 0n) return;
      const cR = collR as AaveReserve;
      const dR = (debtR ?? market.reserves.find((r) => r.address.toLowerCase() === (O.wxdai as string).toLowerCase())!) as AaveReserve;
      const collQtyF = Number(formatUnits(collQty, cR.decimals));
      const acct = s.acct;
      // acct[3] = the account's CURRENT weighted liquidation threshold (bps) — eMode-aware
      const m = positionMetrics({ collateralBase: acct[0], debtBase: acct[1], liqThresholdBps: Number(acct[3]), healthFactor1e18: acct[5], collateralQty: collQtyF, collateralPriceUsd: collQtyF > 0 ? (Number(acct[0]) / 1e8) / collQtyF : 0 });
      live.push({ safe: s.safe, m, collQty, debtQty, availBase: acct[2],
        collTok: { address: cR.address, symbol: cR.symbol, decimals: cR.decimals },
        debtTok: { address: dR.address, symbol: dR.symbol, decimals: dR.decimals },
        module: s.module });
    });
    return live;
  }
}

// ── Profit & loss ───────────────────────────────────────────────────────────
export type PnL = { equityUsd: number; initialEquityUsd: number; pnlUsd: number; pnlPct: number };

/**
 * Unrealized P&L of an OPEN position vs the equity originally deposited (carrier).
 * Assumes the carrier's deposited token IS the position's debt token (true for every
 * pair here — you deposit and borrow the same stable, e.g. WXDAI/sDAI), so `p.debtTok`
 * gives both the decimals and the USD price of `initialEquity`. When the position has
 * no live debt (1x) we fall back to $1 — correct for the USD-pegged debt tokens in use.
 */
export function positionPnl(p: LivePos, initialEquity: bigint): PnL | null {
  // price the deposited debt token from the position's own balances (handles EURe ≠ $1)
  const debtPrice = p.debtQty > 0n ? p.m.debtUsd / Number(formatUnits(p.debtQty, p.debtTok.decimals)) : 1;
  const initialEquityUsd = Number(formatUnits(initialEquity, p.debtTok.decimals)) * debtPrice;
  if (!(initialEquityUsd > 0)) return null;
  const equityUsd = Math.max(p.m.equityUsd, 0);
  const pnlUsd = equityUsd - initialEquityUsd;
  return { equityUsd, initialEquityUsd, pnlUsd, pnlPct: (pnlUsd / initialEquityUsd) * 100 };
}

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * Realized P&L of a CLOSED position, denominated in whatever token actually came
 * back to the owner — so it works whether you closed into the debt token OR kept
 * the collateral asset. `token` says which; `returned` is what you got; `basis`
 * is the apples-to-apples benchmark in the SAME token. P&L = returned − basis.
 *   • debt close:       basis = your initial equity (debt deposited).
 *   • collateral close: basis = what your equity ALONE would have bought at the
 *     opening swap's own rate (no leverage) — i.e. "did leverage get me more of
 *     the asset than just buying it outright?". Oracle-free: the benchmark price
 *     is the realized open-swap rate, not any external feed.
 * null = indeterminate (RPC couldn't serve the range, or no payout to the owner —
 * e.g. a pre-v5 close that left funds in the Safe). Caller shows "—".
 */
export type RealizedPnL = { token: Address; returned: bigint; basis: bigint; parked?: boolean };

/** The position's opening swap from the Safe's barn orders: debt spent → collateral bought. */
async function fetchOpenSwap(safe: Address, debtToken: Address): Promise<{ collateral: Address; collBought: bigint; debtSpent: bigint } | null> {
  try {
    const r = await fetch('/api/barn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'accountOrders', owner: safe, limit: 200 }),
    });
    const j = await r.json() as { body?: Array<{ sellToken?: string; buyToken?: string; status?: string; executedSellAmount?: string; executedBuyAmount?: string }> };
    const debt = debtToken.toLowerCase();
    // opening/increase legs = the Safe selling debt → buying collateral, filled.
    // Sum same-collateral legs to get a blended open rate robust to increases.
    let collateral: Address | null = null, collBought = 0n, debtSpent = 0n;
    for (const o of j.body ?? []) {
      if (!o.sellToken || !o.buyToken) continue;
      if (o.sellToken.toLowerCase() !== debt || o.buyToken.toLowerCase() === debt) continue;
      let sold = 0n, bought = 0n;
      try { sold = BigInt(o.executedSellAmount ?? '0'); bought = BigInt(o.executedBuyAmount ?? '0'); } catch { continue; }
      if (sold === 0n || bought === 0n) continue;
      const coll = getAddress(o.buyToken);
      if (!collateral) collateral = coll;
      if (coll.toLowerCase() !== collateral.toLowerCase()) continue; // ignore a stray different-collateral leg
      collBought += bought; debtSpent += sold;
    }
    return collateral && debtSpent > 0n ? { collateral, collBought, debtSpent } : null;
  } catch { return null; }
}

/** Sum of Transfer(token, safe → owner) over a bounded window. null = RPC couldn't serve it. */
async function paidToOwner(publicClient: PublicClient, token: Address, safe: Address, owner: Address, fromBlock: bigint, toBlock: bigint): Promise<bigint | null> {
  try {
    const logs = await publicClient.getLogs({ address: token, event: TRANSFER_EVENT, args: { from: safe, to: owner }, fromBlock, toBlock });
    return logs.reduce((sum, l) => sum + ((l.args as { value?: bigint }).value ?? 0n), 0n);
  } catch { return null; }
}

export async function realizedReturn(publicClient: PublicClient, safe: Address, owner: Address, debtToken: Address, initialEquity: bigint): Promise<RealizedPnL | null> {
  try {
    const latest = await publicClient.getBlockNumber();
    const span = 5_000_000n; // ~9 months of Gnosis blocks — covers the leverage era
    const fromBlock = latest > span ? latest - span : 0n;
    const open = await fetchOpenSwap(safe, debtToken);
    // payouts to the owner: debt token always; collateral token when we know it.
    const [debtBack, collBack] = await Promise.all([
      paidToOwner(publicClient, debtToken, safe, owner, fromBlock, latest),
      open ? paidToOwner(publicClient, open.collateral, safe, owner, fromBlock, latest) : Promise.resolve(0n),
    ]);
    if (debtBack === null && collBack === null) return null; // RPC failure on both
    const debtReturned = debtBack ?? 0n;
    const collReturned = collBack ?? 0n;
    // Closed into DEBT if the debt payout is a meaningful fraction (≥1%) of the
    // deposit; otherwise, if collateral came back, it's a collateral close.
    const debtIsPayout = debtReturned > 0n && (initialEquity === 0n || debtReturned * 100n >= initialEquity);
    if (!debtIsPayout && open && collReturned > 0n) {
      // unleveraged-equivalent the equity would have bought at the open rate
      const basis = (open.collBought * initialEquity) / open.debtSpent;
      return { token: open.collateral, returned: collReturned, basis };
    }
    if (debtReturned > 0n) return { token: debtToken, returned: debtReturned, basis: initialEquity };
    if (open && collReturned > 0n) {
      const basis = (open.collBought * initialEquity) / open.debtSpent;
      return { token: open.collateral, returned: collReturned, basis };
    }
    // No payout to the owner. If the equity is still sitting in the Safe — a
    // funding that filled but whose open swap expired, or a pre-v5 close that left
    // funds behind — surface it as RECOVERABLE rather than an indeterminate "—".
    try {
      const debtBal = await publicClient.readContract({ address: debtToken, abi: erc20Abi, functionName: 'balanceOf', args: [safe] }) as bigint;
      if (debtBal > 0n && (initialEquity === 0n || debtBal * 100n >= initialEquity)) {
        return { token: debtToken, returned: debtBal, basis: initialEquity, parked: true };
      }
    } catch { /* fall through to indeterminate */ }
    return null; // no payout, nothing recoverable found → indeterminate
  } catch { return null; }
}
