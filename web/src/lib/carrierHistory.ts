import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { SAFE_1_3_0_PROXY_CREATION_CODE } from './__fixtures__/proxyCreationCode';
import { predictSafeAddress } from './predict';
import { buildConditionalOrderParams, conditionalOrderHash } from './twap';
import { safeAbi, twapBalanceInitializerAbi, twapDataAbi, twapSafeInitializerAbi } from './abi';
import type { ChainConfig } from './chains';
import type { EnrichedOrder } from './orderState';

// ---------------------------------------------------------------------------
// Frontend-only TWAP history.
//
// Every TWAP is created by ONE in-kind "carrier" CoW order (sell==buy, receiver
// = the counterfactual Safe) whose appData pre-interaction calls
// TwapBootstrap.bootstrap(singleton, setup, saltNonce). That single record is
// self-describing: decoding the pre-hook recovers the Safe's setup() calldata,
// which embeds the full TWAP params. So the owner's whole history is just:
//
//   GET cow/account/{owner}/orders  →  keep carriers  →  decode  →  enrich.
//
// No server, no database: the public CoW orderbook (CORS-open) is the index, and
// a public RPC supplies on-chain state. A user sees their TWAPs from any device.
// ---------------------------------------------------------------------------

const COW_NET: Record<number, string> = { 1: 'mainnet', 100: 'xdai' };
export function cowApiBaseClient(chainId: number): string | null {
  const net = COW_NET[chainId];
  return net ? `https://api.cow.fi/${net}` : null;
}

const CARRIER_APP_CODE_PREFIX = 'koeppelmann/twap_carrier';

const bootstrapAbi = parseAbi(['function bootstrap(address singleton, bytes setup, uint256 saltNonce)']);

// TwapOrderLens — deployed deterministically on both chains. One call returns
// {deployed, active, allowance, safeBalance} for every Safe at once.
const LENS = '0xd1a12ba577A161a486EE53FA62C5b8Ccf14Fd963' as const;
const lensAbi = parseAbi([
  'struct State { bool deployed; bool active; uint256 allowance; uint256 safeBalance; }',
  'function check(address[] safes, address[] owners, address[] sellTokens, bytes32[] orderHashes) view returns (State[])',
]);

/** A CoW order as returned by the orderbook (only the fields we read). */
type CowOrder = {
  uid: string;
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: string;
  status: string; // open | fulfilled | expired | cancelled | presignaturePending
  creationDate: string;
  fullAppData?: string | null;
  kind: string;
  executedSellAmount?: string;
  executedBuyAmount?: string; // for a fulfilled in-kind carrier: exactly what the Safe received
};

export type CarrierStatus = 'open' | 'fulfilled' | 'expired' | 'cancelled' | string;

/** A plain (non-TWAP, non-leverage) wallet swap, for the history list. */
export type SwapRow = {
  uid: string;
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;   // signed
  buyAmount: string;    // signed min-receive
  executedSell: string; // actually traded
  executedBuy: string;  // actually received
  status: CarrierStatus;
  createdAt: number;
};

/** A history row = an enriched order plus its originating carrier's identity. */
export type HistoryOrder = EnrichedOrder & {
  carrierUid: string;
  carrierStatus: CarrierStatus;
};

type CommonTwap = {
  sellToken: Address; buyToken: Address; receiver: Address;
  n: bigint; t: bigint; span: bigint; appData: Hex;
};
type DecodedCarrier = {
  singleton: Address;
  setup: Hex; // Safe.setup(...) calldata == the proxy initializer
  saltNonce: bigint;
  safeOwner: Address;
  common: CommonTwap;
  salt: Hex; // conditional-order salt (for re-deriving the order hash)
  // Legacy fixed-amount flow: the part size is baked into the order.
  fixed?: { partSellAmount: bigint; minPartLimit: bigint };
  // Balance-sizing flow: the part size is `delivered/n`, resolved at deploy; the
  // limit is a rate. Reconstruct the exact order once the carrier has filled.
  balance?: { limitNum: bigint; limitDen: bigint };
};

/**
 * Decode a carrier's fullAppData back into the TWAP it bootstraps. Returns null
 * if the document is not a TWAP carrier (wrong/missing hook), so callers can
 * cheaply filter. Handles both the balance-sizing (post-hook) and legacy
 * fixed-amount (pre-hook) initializers. When `twapBootstrap` is given, the hook
 * target must match.
 */
export function decodeCarrier(fullAppData: string, twapBootstrap?: Address): DecodedCarrier | null {
  type HookList = Array<{ target?: string; callData?: string }>;
  let doc: { appCode?: unknown; metadata?: { hooks?: { pre?: HookList; post?: HookList } } };
  try { doc = JSON.parse(fullAppData); } catch { return null; }
  const hooks = [...(doc?.metadata?.hooks?.post ?? []), ...(doc?.metadata?.hooks?.pre ?? [])];
  if (hooks.length === 0) return null;
  const want = twapBootstrap?.toLowerCase();
  const hook = hooks.find((h) => h?.callData && (!want || String(h.target).toLowerCase() === want));
  if (!hook?.callData) return null;
  if (!want && typeof doc.appCode === 'string' && !doc.appCode.startsWith(CARRIER_APP_CODE_PREFIX)) return null;

  try {
    const boot = decodeFunctionData({ abi: bootstrapAbi, data: hook.callData as Hex });
    if (boot.functionName !== 'bootstrap') return null;
    const [singleton, setup, saltNonce] = boot.args as readonly [Address, Hex, bigint];

    const su = decodeFunctionData({ abi: safeAbi, data: setup });
    if (su.functionName !== 'setup') return null;
    const owners = su.args[0] as readonly Address[];
    const initData = su.args[3] as Hex;

    const base = { singleton: getAddress(singleton), setup, saltNonce, safeOwner: getAddress(owners[0]) };

    // Try the balance-sizing initializer first (current flow).
    try {
      const init = decodeFunctionData({ abi: twapBalanceInitializerAbi, data: initData });
      if (init.functionName === 'initialize') {
        const c = init.args[0] as {
          sellToken: Address; buyToken: Address; receiver: Address; n: bigint; t: bigint; span: bigint;
          limitNum: bigint; limitDen: bigint; salt: Hex; appData: Hex;
        };
        return {
          ...base, salt: c.salt,
          common: { sellToken: c.sellToken, buyToken: c.buyToken, receiver: c.receiver, n: c.n, t: c.t, span: c.span, appData: c.appData },
          balance: { limitNum: c.limitNum, limitDen: c.limitDen },
        };
      }
    } catch { /* not the balance format — fall through */ }

    // Legacy fixed-amount initializer.
    const init = decodeFunctionData({ abi: twapSafeInitializerAbi, data: initData });
    if (init.functionName !== 'initialize') return null;
    const params = init.args[4] as { handler: Address; salt: Hex; staticInput: Hex };
    const [twap] = decodeAbiParameters([twapDataAbi], params.staticInput) as unknown as [{
      sellToken: Address; buyToken: Address; receiver: Address; partSellAmount: bigint; minPartLimit: bigint;
      t0: bigint; n: bigint; t: bigint; span: bigint; appData: Hex;
    }];
    return {
      ...base, salt: params.salt,
      common: { sellToken: twap.sellToken, buyToken: twap.buyToken, receiver: twap.receiver, n: twap.n, t: twap.t, span: twap.span, appData: twap.appData },
      fixed: { partSellAmount: twap.partSellAmount, minPartLimit: twap.minPartLimit },
    };
  } catch { return null; }
}

/** Turn a carrier order + its decode into an un-enriched history row. */
function toRow(chain: ChainConfig, owner: Address, o: CowOrder, d: DecodedCarrier): HistoryOrder | null {
  const safe = predictSafeAddress({
    factory: chain.safeProxyFactory,
    singleton: d.singleton,
    proxyCreationCode: SAFE_1_3_0_PROXY_CREATION_CODE,
    initializer: d.setup,
    saltNonce: d.saltNonce,
  });
  // The carrier must pay into exactly this Safe; otherwise it isn't our order.
  if (safe.toLowerCase() !== o.receiver.toLowerCase()) return null;

  const n = d.common.n;
  // Resolve the per-part size. Balance flow: delivered/n — exact once the carrier
  // filled (executedBuyAmount is what the Safe received), estimated from the
  // signed sellAmount beforehand. Legacy: the baked-in fixed amount.
  let partSell: bigint;
  let minPartLimit: bigint;
  if (d.balance) {
    const funded = o.status === 'fulfilled' && o.executedBuyAmount ? BigInt(o.executedBuyAmount) : BigInt(o.sellAmount);
    partSell = n > 0n ? funded / n : 0n;
    minPartLimit = d.balance.limitDen > 0n ? partSell * d.balance.limitNum / d.balance.limitDen : 0n;
  } else {
    partSell = d.fixed!.partSellAmount;
    minPartLimit = d.fixed!.minPartLimit;
  }

  // Reconstruct the conditional order hash (exact once partSell is known on-chain).
  const orderHash = conditionalOrderHash(buildConditionalOrderParams({
    sellToken: d.common.sellToken, buyToken: d.common.buyToken, receiver: d.common.receiver,
    partSellAmount: partSell, minPartLimit, t0: 0n, n, t: d.common.t, span: d.common.span, appData: d.common.appData,
  }, d.salt));

  const createdAt = Math.floor(new Date(o.creationDate).getTime() / 1000) || 0;
  const recv = d.common.receiver === zeroAddress ? safe : d.common.receiver;
  return {
    safe,
    chainId: chain.chainId,
    owner,
    receiver: recv,
    sellToken: d.common.sellToken,
    buyToken: d.common.buyToken,
    totalSell: o.sellAmount, // what the user signed away in the carrier
    partSell: partSell.toString(),
    minPartLimit: minPartLimit.toString(),
    n: Number(n),
    t: Number(d.common.t),
    orderHash,
    singleton: d.singleton,
    saltNonce: d.saltNonce.toString(),
    initializer: d.setup,
    createdAt,
    // enrichment defaults (filled in by enrichOrders)
    deployed: false,
    active: false,
    filledParts: 0,
    executedSell: '0',
    executedBuy: '0',
    remainingSell: '0',
    startTime: 0,
    carrierUid: o.uid,
    carrierStatus: o.status,
  };
}

/** Page through every CoW order the owner signed (newest first). */
async function pageOwnerOrders(base: string, owner: Address): Promise<CowOrder[]> {
  const PAGE = 100;
  const MAX = 1000; // safety cap
  const all: CowOrder[] = [];
  for (let offset = 0; offset < MAX; offset += PAGE) {
    let batch: CowOrder[];
    try {
      const r = await fetch(`${base}/api/v1/account/${owner}/orders?limit=${PAGE}&offset=${offset}`, { cache: 'no-store' });
      if (!r.ok) break;
      batch = (await r.json()) as CowOrder[];
    } catch { break; }
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  return all;
}

/** Keep the TWAP carriers from a batch of orders, decoded + de-duped by Safe. */
function collectCarriers(chain: ChainConfig, owner: Address, orders: CowOrder[]): HistoryOrder[] {
  if (!chain.twapBootstrap) return [];
  const rows: HistoryOrder[] = [];
  for (const o of orders) {
    if (o.sellToken?.toLowerCase() !== o.buyToken?.toLowerCase()) continue; // (a) in-kind
    if (!o.fullAppData) continue;
    const d = decodeCarrier(o.fullAppData, chain.twapBootstrap); // (b) exact pre-hook
    if (!d) continue;
    const row = toRow(chain, owner, o, d);
    if (row) rows.push(row);
  }
  // De-dupe by Safe (re-signed/re-submitted carriers for the same TWAP), newest first.
  const bySafe = new Map<string, HistoryOrder>();
  for (const row of rows.sort((a, b) => b.createdAt - a.createdAt)) {
    const k = row.safe.toLowerCase();
    const prev = bySafe.get(k);
    if (!prev) { bySafe.set(k, row); continue; }
    // Prefer a carrier that actually funded the Safe (fulfilled) over an open/expired one.
    if (prev.carrierStatus !== 'fulfilled' && row.carrierStatus === 'fulfilled') bySafe.set(k, row);
  }
  return Array.from(bySafe.values()).sort((a, b) => b.createdAt - a.createdAt);
}

// doSwap stamps this appCode on every plain swap it submits (see SwapTab.doSwap).
// Filtering on it keeps /orders to THIS app's swaps — not the user's unrelated
// cowswap.exchange (or other-frontend) history under the same wallet. Exported so
// the producer (doSwap) and the filter here can never drift.
export const SWAP_APP_CODE = 'CoW Leverage';
// The leverage funding carrier (in-kind order the EOA signs on barn) stamps this
// appCode; its receiver is the position Safe. Shared so the producer
// (SwapTab.carrierAppData) and the discovery filter (positions.ts) can't drift.
export const LEV_CARRIER_APP_CODE = 'koeppelmann/cowswap_wrapper';
/** Read the appCode out of a CoW order's fullAppData document (null if absent/invalid). */
export function appCodeOf(fullAppData?: string | null): string | null {
  if (!fullAppData) return null;
  try { return (JSON.parse(fullAppData) as { appCode?: unknown }).appCode as string ?? null; } catch { return null; }
}

/** Keep this app's plain wallet swaps (non-in-kind, stamped with our appCode). */
function collectSwaps(chainId: number, orders: CowOrder[]): SwapRow[] {
  const out: SwapRow[] = [];
  for (const o of orders) {
    if (o.sellToken?.toLowerCase() === o.buyToken?.toLowerCase()) continue; // skip in-kind carriers
    if (appCodeOf(o.fullAppData) !== SWAP_APP_CODE) continue;               // only this app's swaps
    out.push({
      uid: o.uid,
      chainId,
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      sellAmount: o.sellAmount,
      buyAmount: o.buyAmount,
      executedSell: o.executedSellAmount ?? '0',
      executedBuy: o.executedBuyAmount ?? '0',
      status: o.status,
      createdAt: Math.floor(new Date(o.creationDate).getTime() / 1000) || 0,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** One pass over the owner's orderbook → both TWAP carriers and app swaps. */
export async function fetchOwnerHistory(chain: ChainConfig, owner: Address): Promise<{ carriers: HistoryOrder[]; swaps: SwapRow[] }> {
  const base = cowApiBaseClient(chain.chainId);
  if (!base) return { carriers: [], swaps: [] };
  const orders = await pageOwnerOrders(base, owner);
  return { carriers: collectCarriers(chain, owner, orders), swaps: collectSwaps(chain.chainId, orders) };
}

/** Real per-Safe fills from CoW (the watchtower posts part orders under the Safe). */
export type Leg = { sellAmount: string; buyAmount: string; orderUid: string; txHash?: string; blockNumber?: number };
export async function fetchSafeLegs(chainId: number, safe: string): Promise<Leg[]> {
  const base = cowApiBaseClient(chainId);
  if (!base) return [];
  try {
    const r = await fetch(`${base}/api/v1/trades?owner=${safe}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const raw = (await r.json()) as Array<Record<string, unknown>>;
    return raw.map((t) => ({
      sellAmount: String(t.sellAmount ?? '0'),
      buyAmount: String(t.buyAmount ?? '0'),
      orderUid: String(t.orderUid ?? ''),
      txHash: typeof t.txHash === 'string' ? t.txHash : undefined,
      blockNumber: typeof t.blockNumber === 'number' ? t.blockNumber : undefined,
    }));
  } catch { return []; }
}

/**
 * Enrich rows with on-chain state (one lens eth_call for all Safes) and real
 * fills (CoW trades per deployed Safe). Mutates copies; never throws — on RPC
 * failure rows keep their carrier-only state so the list still renders.
 */
export async function enrichOrders(
  client: PublicClient,
  rows: HistoryOrder[],
): Promise<HistoryOrder[]> {
  if (rows.length === 0) return rows;
  let states: readonly { deployed: boolean; active: boolean; allowance: bigint; safeBalance: bigint }[] = [];
  try {
    states = (await client.readContract({
      address: LENS,
      abi: lensAbi,
      functionName: 'check',
      args: [
        rows.map((r) => r.safe as Address),
        rows.map((r) => r.owner as Address),
        rows.map((r) => r.sellToken as Address),
        rows.map((r) => r.orderHash as Hex),
      ],
    })) as typeof states;
  } catch { states = []; }

  const out = rows.map((r, i) => {
    const s = states[i];
    if (!s) return { ...r };
    return {
      ...r,
      deployed: s.deployed,
      active: s.active,
      allowance: s.allowance.toString(),
      remainingSell: s.deployed ? s.safeBalance.toString() : '0',
    };
  });

  // Real fills for deployed Safes (balance can't tell sold from withdrawn).
  const deployedIdx = out.map((r, i) => (r.deployed ? i : -1)).filter((i) => i >= 0);
  const CONC = 4;
  for (let i = 0; i < deployedIdx.length; i += CONC) {
    await Promise.all(deployedIdx.slice(i, i + CONC).map(async (idx) => {
      const legs = await fetchSafeLegs(out[idx].chainId, out[idx].safe);
      let execSell = 0n, execBuy = 0n;
      for (const l of legs) { execSell += BigInt(l.sellAmount); execBuy += BigInt(l.buyAmount); }
      out[idx].filledParts = legs.length;
      out[idx].executedSell = execSell.toString();
      out[idx].executedBuy = execBuy.toString();
    }));
  }
  return out;
}
