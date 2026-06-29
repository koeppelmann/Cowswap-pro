import { formatUnits, type Address, type PublicClient } from 'viem';
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

// Discovering Safes from the barn leverage carriers (appCode LEV_CARRIER_APP_CODE,
// receiver = the Safe) means positions show up on ANY device, not just the browser
// that opened them — same frontend-only approach as TWAP history.
/**
 * Discover the account's leverage Safes from its barn carrier orders (server-proxied).
 * Time-bounded so a slow/hung staging barn can never block position rendering — on
 * timeout we return [] and callers fall back to localStorage Safes.
 */
export async function discoverLeverageSafes(owner: Address, timeoutMs = 6000): Promise<Address[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let j: { body?: Array<{ sellToken?: string; buyToken?: string; receiver?: string; fullAppData?: string | null }> };
    try {
      const r = await fetch('/api/barn', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'accountOrders', owner, limit: 200 }), signal: ctrl.signal,
      });
      j = await r.json();
    } finally { clearTimeout(t); }
    const safes = new Set<string>();
    for (const o of j.body ?? []) {
      if (!o.receiver || o.sellToken?.toLowerCase() !== o.buyToken?.toLowerCase()) continue; // in-kind carriers only
      if (appCodeOf(o.fullAppData) === LEV_CARRIER_APP_CODE) safes.add(o.receiver.toLowerCase());
    }
    return [...safes] as Address[];
  } catch { return []; }
}

/**
 * Read live leverage positions for an explicit Safe list. Two multicalls TOTAL,
 * regardless of how many Safes: (1) a cheap gate (isOwner + both modules + Aave
 * account) for every candidate, then (2) reserve balances ONLY for the Safes that
 * survive the gate. The candidate set can be large (barn discovery returns one
 * Safe per past leverage carrier, mostly closed), so we never issue the heavy
 * per-reserve balance reads for Safes that aren't owned/open. Never throws.
 */
export async function readPositions(publicClient: PublicClient, address: Address | undefined, safes: Address[], market: Market | null): Promise<LivePos[]> {
  if (!publicClient || !market || !address || safes.length === 0) return [];
  try {
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
  } catch { return []; }
}
