import { NextResponse } from 'next/server';
import { createPublicClient, fallback, http, type Address } from 'viem';
import { gnosis } from 'viem/chains';

export const runtime = 'nodejs';

// Aave V3 Gnosis market snapshot for the leverage UI: per-reserve flags that decide which
// (sell → buy) pairs can be levered (borrow sell against buy), plus eMode categories.
// Served from one multicall sweep, cached in-memory for 10 minutes.
const POOL = '0xb50201558B00496A145fE76f7424749556E326D8' as Address;
const RPC = process.env.GNOSIS_RPC || 'https://rpc.gnosischain.com';

const POOL_ABI = [
  { type: 'function', stateMutability: 'view', name: 'getReservesList', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', stateMutability: 'view', name: 'getConfiguration', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', stateMutability: 'view', name: 'getReserveData', inputs: [{ type: 'address' }],
    outputs: [{
      type: 'tuple', components: [
        { name: 'configuration', type: 'uint256' }, { name: 'liquidityIndex', type: 'uint128' },
        { name: 'currentLiquidityRate', type: 'uint128' }, { name: 'variableBorrowIndex', type: 'uint128' },
        { name: 'currentVariableBorrowRate', type: 'uint128' }, { name: 'currentStableBorrowRate', type: 'uint128' },
        { name: 'lastUpdateTimestamp', type: 'uint40' }, { name: 'id', type: 'uint16' },
        { name: 'aTokenAddress', type: 'address' }, { name: 'stableDebtTokenAddress', type: 'address' },
        { name: 'variableDebtTokenAddress', type: 'address' }, { name: 'interestRateStrategyAddress', type: 'address' },
        { name: 'accruedToTreasury', type: 'uint128' }, { name: 'unbacked', type: 'uint128' }, { name: 'isolationModeTotalDebt', type: 'uint128' },
      ],
    }],
  },
  { type: 'function', stateMutability: 'view', name: 'getEModeCategoryData', inputs: [{ type: 'uint8' }], outputs: [{ type: 'tuple', components: [{ name: 'ltv', type: 'uint16' }, { name: 'liquidationThreshold', type: 'uint16' }, { name: 'liquidationBonus', type: 'uint16' }, { name: 'priceSource', type: 'address' }, { name: 'label', type: 'string' }] }] },
  { type: 'function', stateMutability: 'view', name: 'getEModeCategoryCollateralBitmap', inputs: [{ type: 'uint8' }], outputs: [{ type: 'uint128' }] },
  { type: 'function', stateMutability: 'view', name: 'getEModeCategoryBorrowableBitmap', inputs: [{ type: 'uint8' }], outputs: [{ type: 'uint128' }] },
] as const;
const SYMBOL_ABI = [{ type: 'function', stateMutability: 'view', name: 'symbol', inputs: [], outputs: [{ type: 'string' }] }] as const;

export type AaveReserve = {
  address: Address; symbol: string; decimals: number; id: number;
  ltvBps: number; liqThresholdBps: number;
  collateralEnabled: boolean; borrowEnabled: boolean; active: boolean; frozen: boolean; paused: boolean; flashEnabled: boolean;
  aToken: Address; vDebtToken: Address;
};
export type AaveEMode = { id: number; label: string; ltvBps: number; liqThresholdBps: number; collateral: Address[]; borrowable: Address[] };

let cache: { at: number; body: { reserves: AaveReserve[]; emodes: AaveEMode[] } } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return NextResponse.json(cache.body);
  try {
    // the primary public RPC rate-limits aggressively; fall back through alternates
    const pub = createPublicClient({
      chain: gnosis,
      transport: fallback([http(RPC), http('https://gnosis-rpc.publicnode.com'), http('https://1rpc.io/gnosis')]),
    });
    const list = await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: 'getReservesList' }) as Address[];
    const calls = list.flatMap((a) => [
      { address: POOL, abi: POOL_ABI, functionName: 'getConfiguration', args: [a] } as const,
      { address: POOL, abi: POOL_ABI, functionName: 'getReserveData', args: [a] } as const,
      { address: a, abi: SYMBOL_ABI, functionName: 'symbol' } as const,
    ]);
    const res = await pub.multicall({ contracts: calls, allowFailure: false });
    const reserves: AaveReserve[] = list.map((a, i) => {
      const cfg = res[i * 3] as bigint;
      const rd = res[i * 3 + 1] as { id: number; aTokenAddress: Address; variableDebtTokenAddress: Address };
      const ltv = Number(cfg & 0xffffn);
      return {
        address: a, symbol: res[i * 3 + 2] as string, decimals: Number((cfg >> 48n) & 0xffn), id: Number(rd.id),
        ltvBps: ltv, liqThresholdBps: Number((cfg >> 16n) & 0xffffn),
        collateralEnabled: ltv > 0, borrowEnabled: ((cfg >> 58n) & 1n) === 1n,
        active: ((cfg >> 56n) & 1n) === 1n, frozen: ((cfg >> 57n) & 1n) === 1n, paused: ((cfg >> 60n) & 1n) === 1n,
        flashEnabled: ((cfg >> 63n) & 1n) === 1n,
        aToken: rd.aTokenAddress, vDebtToken: rd.variableDebtTokenAddress,
      };
    });
    const byId = new Map(reserves.map((r) => [r.id, r.address]));
    const emodes: AaveEMode[] = [];
    for (let id = 1; id <= 8; id++) {
      const [data, collBm, borBm] = await pub.multicall({
        contracts: [
          { address: POOL, abi: POOL_ABI, functionName: 'getEModeCategoryData', args: [id] },
          { address: POOL, abi: POOL_ABI, functionName: 'getEModeCategoryCollateralBitmap', args: [id] },
          { address: POOL, abi: POOL_ABI, functionName: 'getEModeCategoryBorrowableBitmap', args: [id] },
        ], allowFailure: false,
      }) as [{ ltv: number; liquidationThreshold: number; label: string }, bigint, bigint];
      if (Number(data.liquidationThreshold) === 0) continue; // unset category
      const fromBitmap = (bm: bigint) => {
        const out: Address[] = [];
        for (let b = 0; b < 64; b++) if ((bm >> BigInt(b)) & 1n) { const addr = byId.get(b); if (addr) out.push(addr); }
        return out;
      };
      emodes.push({ id, label: data.label, ltvBps: Number(data.ltv), liqThresholdBps: Number(data.liquidationThreshold), collateral: fromBitmap(collBm), borrowable: fromBitmap(borBm) });
    }
    cache = { at: Date.now(), body: { reserves, emodes } };
    return NextResponse.json(cache.body);
  } catch (e) {
    console.error('[aave-market] failed:', (e as Error).message);
    // HTTP 200 + error field: Cloudflare swaps origin 5xx bodies for HTML
    return NextResponse.json({ error: (e as Error).message, reserves: [], emodes: [] });
  }
}
