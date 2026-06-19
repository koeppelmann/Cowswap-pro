'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { encodeFunctionData, formatUnits, getAddress, hashTypedData, keccak256, parseUnits, toHex, type Address } from 'viem';
import { gnosis } from 'wagmi/chains';
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { TokenIcon } from './TokenIcon';
import { erc20Abi } from '../lib/abi';
import { getChainConfig } from '../lib/chains';
import { isAddress } from '../lib/format';
import { useToken } from '../lib/useToken';
import { useTokenBalances } from '../lib/useTokenBalances';
import { useTokenList } from '../lib/useTokenList';
import { positionMetrics, type PositionMetrics } from '../lib/leverage';
import {
  ONBOARD, IB_ABI, ERC20_ABI, GPV2_ORDER_TYPES, RETARGET_TYPES, RETARGET_TYPES_V4, LEV_MODULE, LEV_MODULE_V4, MODULE_ABI, MODULE_ABI_V4, POOL_ADDR, type Intent,
} from '../lib/onboard';

// ────────────────────────────────────────────────────────────────────────────
// Token universe. The proven on-chain pair on barn is WXDAI (debt/stable, sell)
// → WETH (collateral/long, buy). Everything settles on CoW *barn* with organic
// solvers (no solver privilege) via the carrier-order + LevManagerModule flow.
// ────────────────────────────────────────────────────────────────────────────
const O = ONBOARD;
const WETH_LIQ_THRESHOLD_BPS = 8300; // Aave V3 Gnosis WETH liquidation threshold
const MAXU = (2n ** 256n) - 1n;

type UIToken = { address: Address; symbol: string; decimals: number; kind: 'debt' | 'collateral'; name: string };
const WXDAI: UIToken = { address: O.wxdai as Address, symbol: 'WXDAI', decimals: 18, kind: 'debt', name: 'Wrapped xDAI' };
const WETH: UIToken = { address: O.weth as Address, symbol: 'WETH', decimals: 18, kind: 'collateral', name: 'Wrapped Ether' };
// kind only matters for the leverage path (sell debt → buy collateral); the proven
// pair is WXDAI→WETH — every other pair is a plain barn swap.
const tokenKind = (addr: string): UIToken['kind'] => (addr.toLowerCase() === (O.wxdai as string).toLowerCase() ? 'debt' : 'collateral');

type PosTok = { address: Address; symbol: string; decimals: number };
type LivePos = {
  safe: Address; m: PositionMetrics; collQty: bigint; debtQty: bigint; availBase: bigint;
  collTok: PosTok; debtTok: PosTok;
  module: Address; // which LevManagerModule version this Safe has enabled (v4 Safes predate withdrawExtra)
};

// /api/aave-market shapes (which pairs can be levered + eMode categories)
type AaveReserve = {
  address: Address; symbol: string; decimals: number; ltvBps: number; liqThresholdBps: number;
  collateralEnabled: boolean; borrowEnabled: boolean; active: boolean; frozen: boolean; paused: boolean; flashEnabled: boolean;
  aToken: Address; vDebtToken: Address;
};
type AaveEMode = { id: number; label: string; ltvBps: number; liqThresholdBps: number; collateral: Address[]; borrowable: Address[] };
type Market = { reserves: AaveReserve[]; emodes: AaveEMode[] };

const poolAbi = [
  { type: 'function', name: 'getUserAccountData', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
] as const;
const safeAbi = [
  { type: 'function', name: 'isOwner', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isModuleEnabled', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// slippage in fractional percent (e.g. 0.5) → integer-safe min-out (bps math; BigInt(99.5) would throw)
const minOut = (q: bigint, pct: number) => (q * BigInt(Math.round((100 - pct) * 100))) / 10000n;
// float → wei without exponential notation / >18-decimal strings that parseUnits rejects
const floatToWei = (x: number, decimals = 18) => (!isFinite(x) || x <= 0 ? 0n : BigInt(Math.round(x * 1e6)) * 10n ** BigInt(decimals - 6));
// POST JSON and parse defensively: a non-JSON body (e.g. a Cloudflare/Next HTML error page)
// throws a readable error instead of the cryptic `Unexpected token '<', "<!DOCTYPE"...`.
async function postJson(url: string, body: unknown): Promise<any> {
  let r: Response;
  try { r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { throw new Error('network error reaching ' + url + ' — check your connection and retry'); }
  const txt = await r.text();
  try { return JSON.parse(txt); }
  catch {
    const snippet = txt.trim().slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`server returned a non-JSON response (HTTP ${r.status})${snippet ? ' — ' + snippet : ''}. The relayer/proxy may be busy; retry in a moment.`);
  }
}
async function barn(op: string, extra: Record<string, unknown>) {
  return postJson('/api/barn', { op, ...extra });
}
async function quoteOut(sellToken: Address, buyToken: Address, sellAmount: bigint, from: Address): Promise<bigint | null> {
  const q = await barn('quote', { sellToken, buyToken, from, sellAmount: sellAmount.toString() });
  if (q.status !== 200) return null;
  try { return BigInt(q.body.quote.buyAmount); } catch { return null; }
}
function carrierAppData(bootstrapCalldata: `0x${string}`): { json: string; hash: `0x${string}` } {
  const doc = {
    appCode: 'koeppelmann/cowswap_wrapper', environment: 'barn',
    metadata: { hooks: { pre: [{ target: O.intentBootstrap, callData: bootstrapCalldata, gasLimit: '3000000' }], post: [] } },
    version: '1.6.0',
  };
  const json = JSON.stringify(doc);
  return { json, hash: keccak256(toHex(json)) };
}
async function pollFill(uid: string, onTick?: (s: string) => void, tries = 90): Promise<'fulfilled' | 'expired'> {
  for (let i = 0; i < tries; i++) {
    const st = await barn('status', { uid });
    onTick?.(st.body?.status || 'open');
    if (st.body?.status === 'fulfilled') return 'fulfilled';
    if (['cancelled', 'expired'].includes(st.body?.status)) return 'expired';
    await sleep(8000);
  }
  return 'expired';
}

// external links (barn explorer knows staging orders; Safe app + Gnosisscan for the Safe)
const explorerUrl = (uid: string) => `https://barn.explorer.cow.fi/gc/orders/${uid}`;
const safeAppUrl = (safe: string) => `https://app.safe.global/home?safe=gno:${safe}`;
const scanUrl = (addr: string) => `https://gnosisscan.io/address/${addr}`;
const short = (x: string) => `${x.slice(0, 8)}…${x.slice(-6)}`;
function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" style={{ color: '#6ea8ff', textDecoration: 'none' }}>{children} ↗</a>;
}

// the frozen open plan: everything below is shown to the user BEFORE signing and then used
// verbatim in doOpen — the Safe address commits to every intent field (incl. nonce/validTo/minBuy),
// so displaying one intent and signing another would show the wrong deterministic address.
type OpenPlan = {
  intent: Intent; safe: Address; levUid: string; carrierUid: string;
  levJson: string; levHash: `0x${string}`; carrierJson: string; carrierHash: `0x${string}`;
  carrierOrder: { sellToken: string; buyToken: string; receiver: string; sellAmount: string; buyAmount: string; validTo: number; appData: string; feeAmount: string; kind: string; partiallyFillable: boolean; sellTokenBalance: string; buyTokenBalance: string };
};

// localStorage helpers (shared with /onboard + /manage via the `levSafes` key)
function loadSavedSafes(): Address[] {
  const set = new Set<string>();
  for (const k of ['levSafes', 'lev_safe_positions']) {
    try {
      const raw = JSON.parse(localStorage.getItem(k) || '[]');
      for (const e of raw) { const a = typeof e === 'string' ? e : e?.safe; if (a) set.add(a.toLowerCase()); }
    } catch { /* */ }
  }
  return [...set] as Address[];
}
function saveSafe(safe: Address) {
  try {
    const a: string[] = JSON.parse(localStorage.getItem('levSafes') || '[]');
    if (!a.some((x) => x.toLowerCase() === safe.toLowerCase())) { a.unshift(safe); localStorage.setItem('levSafes', JSON.stringify(a.slice(0, 30))); }
  } catch { /* */ }
}

const GNOSIS_CFG = getChainConfig(100)!;

export function SwapTab({ tabs }: { tabs?: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: gnosis.id });
  const onGnosis = chainId === gnosis.id;

  // full token list (curated Gnosis defaults first, then the official CoW list)
  const listTokens = useTokenList(GNOSIS_CFG);
  const TOKENS: UIToken[] = useMemo(
    () => listTokens.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals, name: t.name, kind: tokenKind(t.address) })),
    [listTokens],
  );

  // sell side is a token or a position; buy side is always a token
  const [sell, setSell] = useState<UIToken | LivePos>(WXDAI);
  const [buy, setBuy] = useState<UIToken>(WETH);
  const [amount, setAmount] = useState('1');   // equity (open) OR percent (reduce)
  const [lev, setLev] = useState(1);
  const [showLev, setShowLev] = useState(false);
  const [slippagePct, setSlippagePct] = useState(1);
  const [posMode, setPosMode] = useState<'close' | 'leverage'>('close');
  const [receiver, setReceiver] = useState('');   // close proceeds receiver; '' = the connected owner
  const [stopHF, setStopHF] = useState('1.15');   // stop protection: trigger health factor
  const [stopPct, setStopPct] = useState('50');   // stop protection: % of position to deleverage
  const isPos = (x: UIToken | LivePos): x is LivePos => 'safe' in x;
  const sellIsPos = isPos(sell);

  // Aave market snapshot: decides for WHICH pairs the 'Add Leverage' option exists
  const [market, setMarket] = useState<Market | null>(null);
  useEffect(() => {
    fetch('/api/aave-market').then((r) => r.json()).then((d) => { if (d?.reserves?.length) setMarket(d); }).catch(() => {});
  }, []);
  // leverage terms for the CURRENT pair: borrow SELL against BUY. eMode preferred when the pair
  // shares a category (higher LTV — and some collaterals, e.g. sDAI, ONLY work inside one).
  const pairLev = useMemo(() => {
    if (sellIsPos || !market) return null;
    const lc = (x: string) => x.toLowerCase();
    const S = market.reserves.find((r) => lc(r.address) === lc((sell as UIToken).address));
    const B = market.reserves.find((r) => lc(r.address) === lc(buy.address));
    if (!S || !B || S.address === B.address) return null;
    const live = (r: AaveReserve) => r.active && !r.frozen && !r.paused;
    if (!live(S) || !live(B) || !S.flashEnabled) return null;
    let best: { eMode: number; label: string; ltvBps: number; liqTBps: number } | null = null;
    // base path needs the reserve's global borrow flag…
    if (B.collateralEnabled && S.borrowEnabled) best = { eMode: 0, label: '', ltvBps: B.ltvBps, liqTBps: B.liqThresholdBps };
    // …but inside an eMode category the borrowable BITMAP overrides it (verified on a fork:
    // WETH borrows fine in cat 1 despite borrowEnabled=false; outside the category it reverts)
    for (const c of market.emodes) {
      if (c.collateral.some((a) => lc(a) === lc(B.address)) && c.borrowable.some((a) => lc(a) === lc(S.address))
          && (!best || c.ltvBps > best.ltvBps)) {
        best = { eMode: c.id, label: c.label, ltvBps: c.ltvBps, liqTBps: c.liqThresholdBps };
      }
    }
    return best;
  }, [sellIsPos, market, sell, buy]);
  // max leverage from the pair's LTV: borrow ≤ ltv·coll → L ≤ 1/(1−ltv), with 3% headroom, cap 10×
  const maxLev = pairLev ? Math.max(1.5, Math.min(10, Math.floor((0.97 / (1 - pairLev.ltvBps / 10000)) * 10) / 10)) : 5;
  // adjust-slider ceiling for a SELECTED POSITION: its own pair's max — never below current leverage
  const posMaxLev = useMemo(() => {
    if (!sellIsPos) return 5;
    const p = sell as LivePos;
    let cap = 5;
    if (market) {
      const lc = (x: string) => x.toLowerCase();
      const B = market.reserves.find((r) => lc(r.address) === lc(p.collTok.address));
      let ltv = B?.collateralEnabled ? B.ltvBps : 0;
      for (const c of market.emodes) {
        if (c.collateral.some((a) => lc(a) === lc(p.collTok.address)) && c.borrowable.some((a) => lc(a) === lc(p.debtTok.address)) && c.ltvBps > ltv) ltv = c.ltvBps;
      }
      if (ltv > 0) cap = Math.min(10, Math.floor((0.97 / (1 - ltv / 10000)) * 10) / 10);
    }
    return Math.max(cap, Math.ceil(p.m.leverage * 10) / 10);
  }, [sellIsPos, sell, market]);
  // leaving an eligible pair drops any selected leverage back to a plain swap
  useEffect(() => { if (!pairLev && !sellIsPos && lev > 1) { setLev(1); setShowLev(false); } }, [pairLev, sellIsPos, lev]);

  // dialogs
  const [selOpen, setSelOpen] = useState(false);

  const [selSide, setSelSide] = useState<'sell' | 'buy'>('sell');
  const [search, setSearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // data
  const [positions, setPositions] = useState<LivePos[]>([]);
  const [bal, setBal] = useState<bigint | null>(null);
  const [previewBuy, setPreviewBuy] = useState<bigint | null>(null);
  const [previewReduce, setPreviewReduce] = useState<bigint | null>(null); // est. WXDAI freed by a close/reduce
  const [openPlan, setOpenPlan] = useState<OpenPlan | null>(null);         // frozen pre-open derivation (Safe + UIDs)
  const [managePlan, setManagePlan] = useState<{ kind: 'close' | 'adjust'; intent: Record<string, bigint | number | string>; uid: string } | null>(null); // frozen manage derivation
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ── load positions (localStorage + live Aave reads) ──
  const loadPositions = useCallback(async () => {
    if (!publicClient || !market) return;
    if (!address) { setPositions([]); return; } // no account → no positions to show
    const safes = loadSavedSafes();
    const live: LivePos[] = [];
    for (const safe of safes) {
      try {
        // only show Safes the *connected* account owns — a saved Safe from another
        // of the user's accounts must not appear under this one (it can't be managed here).
        const owned = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'isOwner', args: [address] }).catch(() => false) as boolean;
        if (!owned) continue;
        // a Safe without a known LevManagerModule enabled can't be managed here. Safes opened
        // before v5 still run v4 (no withdrawExtra) — keep them manageable with degraded features.
        let posModule: Address | null = null;
        for (const m of [LEV_MODULE, LEV_MODULE_V4] as Address[]) {
          const on = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [m] }).catch(() => false) as boolean;
          if (on) { posModule = m; break; }
        }
        if (!posModule) continue;
        const acct = await publicClient.readContract({ address: POOL_ADDR as Address, abi: poolAbi, functionName: 'getUserAccountData', args: [safe] }) as readonly bigint[];
        if (acct[0] === 0n && acct[1] === 0n) continue; // closed / empty
        // ONE multicall over every reserve's aToken + vDebt balance: a position is one
        // collateral + one debt by construction — take the largest of each.
        const calls = market!.reserves.flatMap((r) => [
          { address: r.aToken, abi: erc20Abi, functionName: 'balanceOf', args: [safe] } as const,
          { address: r.vDebtToken, abi: erc20Abi, functionName: 'balanceOf', args: [safe] } as const,
        ]);
        const bals = await publicClient.multicall({ contracts: calls, allowFailure: true });
        let collR: AaveReserve | null = null, collQty = 0n, debtR: AaveReserve | null = null, debtQty = 0n;
        market!.reserves.forEach((r, i) => {
          const a = bals[i * 2].status === 'success' ? (bals[i * 2].result as bigint) : 0n;
          const v = bals[i * 2 + 1].status === 'success' ? (bals[i * 2 + 1].result as bigint) : 0n;
          if (a > collQty) { collQty = a; collR = r; }
          if (v > debtQty) { debtQty = v; debtR = r; }
        });
        if (!collR || collQty === 0n) continue;
        const cR = collR as AaveReserve;
        const dR = (debtR ?? market!.reserves.find((r) => r.address.toLowerCase() === (O.wxdai as string).toLowerCase())!) as AaveReserve;
        const collQtyF = Number(formatUnits(collQty, cR.decimals));
        // acct[3] = the account's CURRENT weighted liquidation threshold (bps) — eMode-aware
        const m = positionMetrics({ collateralBase: acct[0], debtBase: acct[1], liqThresholdBps: Number(acct[3]), healthFactor1e18: acct[5], collateralQty: collQtyF, collateralPriceUsd: collQtyF > 0 ? (Number(acct[0]) / 1e8) / collQtyF : 0 });
        live.push({ safe, m, collQty, debtQty, availBase: acct[2],
          collTok: { address: cR.address, symbol: cR.symbol, decimals: cR.decimals },
          debtTok: { address: dR.address, symbol: dR.symbol, decimals: dR.decimals },
          module: posModule });
      } catch { /* skip */ }
    }
    setPositions(live);
    // keep a live selection fresh after an action (?? cur tolerates a transient RPC blip
    // without deselecting; account-switch deselection is handled by the effect below).
    setSell((cur) => (isPos(cur) ? live.find((p) => p.safe.toLowerCase() === cur.safe.toLowerCase()) ?? cur : cur));
  }, [publicClient, address, market]);
  useEffect(() => { loadPositions(); }, [loadPositions]);
  // on account switch, drop any position selection (it belongs to the previous account)
  useEffect(() => { setSell((cur) => (isPos(cur) ? WXDAI : cur)); }, [address]);

  // wallet balance of the sell token (plain-token sell only)
  useEffect(() => {
    if (!address || !publicClient || sellIsPos) { setBal(null); return; }
    publicClient.readContract({ address: (sell as UIToken).address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }).then((b) => setBal(b as bigint)).catch(() => setBal(null));
  }, [address, publicClient, sell, sellIsPos]);

  // ── derived (open) ──
  const equity = useMemo(() => { if (sellIsPos) return 0n; try { return parseUnits(amount || '0', (sell as UIToken).decimals); } catch { return 0n; } }, [amount, sell, sellIsPos]);
  const openAmts = useMemo(() => {
    if (sellIsPos || lev <= 1 || equity === 0n) return null;
    const flash = (equity * BigInt(Math.round(lev * 1000))) / 1000n;
    const repay = (flash * 10006n) / 10000n;       // 6bps > Aave 5bps premium (covers rounding)
    const borrow = repay > equity ? repay - equity : 0n;
    return { flash, repay, borrow };
  }, [sellIsPos, lev, equity]);
  const insufficient = bal != null && !sellIsPos && equity > bal;

  // preview quote: leveraged flash leg when lev>1, otherwise the plain-swap amount
  useEffect(() => {
    setPreviewBuy(null);
    if (sellIsPos || equity === 0n || (sell as UIToken).address.toLowerCase() === buy.address.toLowerCase()) return;
    const amt = lev > 1 && openAmts ? openAmts.flash : equity;
    if (amt === 0n) return;
    let live = true;
    quoteOut((sell as UIToken).address, buy.address, amt, (address ?? '0x25a9A92F3bD7Ce47cFD48a896C5590Cf8F5A03Fb') as Address).then((q) => { if (live) setPreviewBuy(q); });
    return () => { live = false; };
  }, [sellIsPos, lev, openAmts, equity, sell, buy, address]);

  // derive the FULL open plan before any signature: deterministic Safe, both order UIDs, appData.
  // Reruns whenever the quote/amount/leverage changes; doOpen consumes it verbatim.
  useEffect(() => {
    setOpenPlan(null);
    if (sellIsPos || !address || !publicClient || !openAmts || !previewBuy || lev <= 1) return;
    if (!pairLev) return;
    let live = true;
    (async () => {
      try {
        const validTo = Math.floor(Date.now() / 1000) + 3600;
        const buyMin = minOut(previewBuy, slippagePct);
        const nonce = BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join(''));
        // signed post-open HF floor: 93% of the expected HF (so the ~bps fee shift passes, but a
        // solver under-delivering equity within the carrier tolerance reverts the settlement).
        // expected HF = flash·liqThreshold / borrow (same formula as the estHF display).
        const liqT = pairLev.liqTBps / 10000;
        const hfExp = openAmts.borrow > 0n ? (Number(formatUnits(openAmts.flash, (sell as UIToken).decimals)) * liqT) / Number(formatUnits(openAmts.borrow, (sell as UIToken).decimals)) : 0;
        const minHF = hfExp > 0 && isFinite(hfExp) ? floatToWei(Math.max(1.01, hfExp * 0.93)) : floatToWei(1.01);
        const intent: Intent = { owner: address, equity, flash: openAmts.flash, buyMin, borrow: openAmts.borrow, repay: openAmts.repay, validTo, nonce, collateral: buy.address, debt: (sell as UIToken).address, eMode: pairLev.eMode, minHealthFactor: minHF };
        const safeAddr = await publicClient.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'safeOf', args: [intent] }) as Address;
        const [levJson, levHash] = await publicClient.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'appData', args: [intent, safeAddr] }) as [string, `0x${string}`];
        const levUid = await publicClient.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'uid', args: [intent, safeAddr] }) as `0x${string}`;
        const bootstrapCalldata = encodeFunctionData({ abi: IB_ABI, functionName: 'bootstrap', args: [intent] });
        const { json: carrierJson, hash: carrierHash } = carrierAppData(bootstrapCalldata);
        // EXACT outlay: the carrier sells precisely the user's amount; the adaptive post
        // (openPostA) borrows whatever the settlement fee shaved off. 99% min-receive floor.
        const sellAmt = equity;
        const carrierOrder = {
          sellToken: (sell as UIToken).address, buyToken: (sell as UIToken).address, receiver: safeAddr, sellAmount: sellAmt.toString(),
          buyAmount: ((sellAmt * 99n) / 100n).toString(), validTo, appData: carrierHash, feeAmount: '0', kind: 'sell',
          partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
        };
        // the carrier (funding) order UID is deterministic too: GPv2 digest ++ owner ++ validTo
        const digest = hashTypedData({
          domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 100, verifyingContract: O.settlement as Address },
          types: GPV2_ORDER_TYPES, primaryType: 'Order',
          message: { ...carrierOrder, sellAmount: BigInt(carrierOrder.sellAmount), buyAmount: BigInt(carrierOrder.buyAmount), validTo: BigInt(validTo), feeAmount: 0n } as never,
        });
        const carrierUid = (digest + address.slice(2) + validTo.toString(16).padStart(8, '0')).toLowerCase();
        if (live) setOpenPlan({ intent, safe: safeAddr, levUid, carrierUid, levJson, levHash, carrierJson, carrierHash, carrierOrder });
      } catch { /* leave plan null; CTA stays disabled */ }
    })();
    return () => { live = false; };
  }, [sellIsPos, address, publicClient, openAmts, previewBuy, slippagePct, equity, lev, sell, buy, pairLev]);

  // close/reduce estimate: sell `pct` of collateral → WXDAI, minus the proportional debt repaid.
  // Net is the WXDAI freed (full close ≈ your equity back; partial ≈ small, it mostly deleverages).
  useEffect(() => {
    setPreviewReduce(null);
    if (!sellIsPos || posMode !== 'close') return;
    const p = sell as LivePos;
    const pct = Math.min(100, Math.max(0, parseFloat(amount) || 0));
    if (pct <= 0 || p.collQty === 0n) return;
    const full = pct >= 100;
    const intoColl = buy.address.toLowerCase() === p.collTok.address.toLowerCase();
    const debtPortion = full ? p.debtQty : (p.debtQty * BigInt(Math.round(pct))) / 100n;
    if (intoColl) {
      // freed collateral ≈ the portion minus what must be sold to repay the freed debt (+premium, overshoot)
      const price = p.collQty > 0n ? p.m.collateralUsd / Number(formatUnits(p.collQty, p.collTok.decimals)) : 0;
      const debtPx = p.debtQty > 0n ? p.m.debtUsd / Number(formatUnits(p.debtQty, p.debtTok.decimals)) : 1;
      if (price <= 0) { setPreviewReduce(null); return; }
      const portion = full ? p.collQty : (p.collQty * BigInt(Math.round(pct))) / 100n;
      const sellNeeded = floatToWei((Number(formatUnits(debtPortion, p.debtTok.decimals)) * debtPx * 1.035 / price) * 1.05, p.collTok.decimals);
      setPreviewReduce(portion > sellNeeded ? portion - sellNeeded : 0n);
      return;
    }
    const sellAmount = full ? p.collQty : (p.collQty * BigInt(Math.round(pct))) / 100n;
    let live = true;
    quoteOut(p.collTok.address, p.debtTok.address, sellAmount, p.safe).then((gross) => {
      if (!live) return;
      if (gross == null) { setPreviewReduce(null); return; }
      const premium = (debtPortion * 5n) / 10000n; // ~5bps Aave flash premium
      const net = gross - debtPortion - premium;
      setPreviewReduce(net > 0n ? net : 0n);
    });
    return () => { live = false; };
  }, [sellIsPos, posMode, sell, amount, buy]);

  // derive the manage intent + its DETERMINISTIC order UID (module.preview, no registration)
  // before any signature — what is shown is byte-identical to what executes (consumed on click).
  useEffect(() => {
    setManagePlan(null);
    if (!sellIsPos || !publicClient || !address) return;
    const p = sell as LivePos;
    const t = setTimeout(async () => {
      try {
        let kind: 'close' | 'adjust'; let intent: Record<string, bigint | number | string>;
        if (posMode === 'close') {
          const pct = Math.min(100, Math.max(0, Math.round(parseFloat(amount) || 0)));
          if (pct <= 0) return;
          kind = 'close'; intent = await buildReduceIntent(pct);
        } else {
          if (Math.abs(lev - p.m.leverage) < 0.05 && lev > 1.01) return;
          kind = lev <= 1.01 ? 'close' : 'adjust';
          intent = lev <= 1.01 ? await buildReduceIntent(100) : await buildAdjustIntent(lev);
        }
        const isV4 = p.module.toLowerCase() === (LEV_MODULE_V4 as string).toLowerCase();
        const msg = { ...intent };
        if (isV4) delete (msg as Record<string, unknown>).withdrawExtra;
        const [uid] = await publicClient.readContract({
          address: p.module, abi: isV4 ? MODULE_ABI_V4 : MODULE_ABI, functionName: 'preview', args: [msg as never],
        }) as [string, string, string];
        setManagePlan({ kind, intent, uid });
      } catch { /* preview unavailable (e.g. dust position) — show nothing */ }
    }, 700);
    return () => clearTimeout(t);
  }, [sellIsPos, sell, posMode, amount, lev, buy, receiver, slippagePct, publicClient, address]);

  const estHF = useMemo(() => {
    if (!openAmts || openAmts.borrow === 0n) return null;
    const dec = (sell as UIToken).decimals;
    const liqT = (pairLev?.liqTBps ?? WETH_LIQ_THRESHOLD_BPS) / 10000;
    return (Number(formatUnits(openAmts.flash, dec)) * liqT) / Number(formatUnits(openAmts.borrow, dec));
  }, [openAmts, sell, pairLev]);
  // deleverage (liquidation) price for the OPEN preview, in WXDAI per WETH
  const estLiqPrice = useMemo(() => {
    if (!openAmts || !previewBuy || openAmts.borrow === 0n) return null;
    const collQty = Number(formatUnits(previewBuy, buy.decimals));
    const liqT = (pairLev?.liqTBps ?? WETH_LIQ_THRESHOLD_BPS) / 10000;
    return collQty > 0 ? Number(formatUnits(openAmts.borrow, (sell as UIToken).decimals)) / (liqT * collQty) : null;
  }, [openAmts, previewBuy, buy.decimals, sell, pairLev]);
  const entryPrice = useMemo(() => {
    if (!openAmts || !previewBuy) return null;
    const out = Number(formatUnits(previewBuy, buy.decimals));
    return out > 0 ? Number(formatUnits(openAmts.flash, (sell as UIToken).decimals)) / out : null;
  }, [openAmts, previewBuy, buy.decimals, sell]);

  // ── token selector ──
  function openSelect(side: 'sell' | 'buy') { setSelSide(side); setSearch(''); setSelOpen(true); }
  function pickToken(t: UIToken) {
    if (selSide === 'sell') { setSell(t); setLev(1); setShowLev(false); setAmount('1'); }
    else setBuy(t); // for a position this is one of its two assets (universe is restricted)
    setSelOpen(false);
  }
  function pickPosition(p: LivePos) { setSell(p); setPosMode('close'); setAmount('100'); setBuy({ address: p.debtTok.address, symbol: p.debtTok.symbol, decimals: p.debtTok.decimals, kind: tokenKind(p.debtTok.address), name: p.debtTok.symbol }); setSelOpen(false); }

  // ── sign a Retarget intent over the LevManagerModule domain & relay it ──
  // wait=false: submit and return immediately (stop orders PARK in the auction until triggered)
  async function relayRetarget(intent: Record<string, bigint | number | string>, label: string, wait = true, moduleAddr: Address = LEV_MODULE as Address): Promise<{ uid: string }> {
    setStatus('Sign the management intent (one signature)…');
    const isV4 = moduleAddr.toLowerCase() === (LEV_MODULE_V4 as string).toLowerCase();
    const msg = { ...intent };
    if (isV4) delete (msg as Record<string, unknown>).withdrawExtra; // v4 struct has 14 fields
    const sig = await walletClient!.signTypedData({
      account: address!, domain: { name: 'LevManagerModule', version: '1', chainId: 100, verifyingContract: moduleAddr },
      types: isV4 ? RETARGET_TYPES_V4 : RETARGET_TYPES, primaryType: 'Retarget', message: msg as never,
    });
    setStatus('Relaying through the module…');
    const intentStr = Object.fromEntries(Object.entries(msg).map(([k, v]) => [k, v.toString()]));
    const rl = await postJson('/api/relay-execute', { intent: intentStr, sig, module: moduleAddr });
    if (!rl.ok) throw new Error('relay: ' + (rl.error ?? JSON.stringify(rl)));
    setStatus('Order registered — submitting to the auction…');
    await barn('appdata', { hash: rl.appDataHash, fullAppData: rl.fullAppData });
    await sleep(1200);
    const reduce = Number(intent.mode) === 0;
    const order = {
      sellToken: reduce ? intent.collateral : intent.debt,   // REDUCE sells collateral; INCREASE sells borrowed debt
      buyToken: reduce ? intent.debt : intent.collateral,
      receiver: intent.safe, sellAmount: (intent.sellAmount as bigint).toString(), buyAmount: (intent.minBuy as bigint).toString(),
      validTo: Number(intent.orderValidTo), appData: rl.appDataHash, feeAmount: '0', kind: 'sell', partiallyFillable: false,
      sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', signingScheme: 'eip1271', signature: '0x', from: intent.safe,
    };
    const os = await barn('order', { order });
    if (os.status !== 201) throw new Error('order: ' + JSON.stringify(os.body));
    if (!wait) return { uid: os.body as string };
    setStatus(label + ' — waiting for a solver…');
    if (await pollFill(os.body as string, (s) => setStatus(label + ' (' + s + ')…')) !== 'fulfilled') throw new Error('order expired — no solver settled it. Try again.');
    return { uid: os.body as string };
  }

  // ── STOP PROTECTION: park a REDUCE order that only becomes fillable while HF < trigger ──
  async function doArmStop() {
    if (!walletClient || !publicClient || !address || !sellIsPos) return;
    const p = sell as LivePos;
    const trigger = parseFloat(stopHF);
    const pct = Math.min(99, Math.max(1, Math.round(parseFloat(stopPct) || 0)));
    if (!isFinite(trigger) || trigger <= 1) { setErr('trigger must be > 1.00'); return; }
    if (trigger >= p.m.healthFactor) { setErr(`trigger must be below the current health factor (${p.m.healthFactor.toFixed(2)})`); return; }
    setBusy(true); setErr(null);
    try {
      const sellAmount = (p.collQty * BigInt(pct)) / 100n;
      const repayAmount = (p.debtQty * BigInt(pct)) / 100n;
      const flash = (repayAmount * 103n) / 100n;
      // minBuy priced for the TRIGGER scenario: HF scales 1:1 with price (debt fixed), so the
      // WETH price when HF first touches the trigger is priceNow · trigger / hfNow; 3% slack.
      const priceNow = p.collQty > 0n ? p.m.collateralUsd / Number(formatUnits(p.collQty, p.collTok.decimals)) : 0;
      if (priceNow <= 0 || !isFinite(p.m.healthFactor) || p.m.healthFactor > 100) throw new Error('no live price/HF');
      const priceAtTrigger = priceNow * (trigger / p.m.healthFactor);
      const debtPx = p.debtQty > 0n ? p.m.debtUsd / Number(formatUnits(p.debtQty, p.debtTok.decimals)) : 1;
      const minBuy = floatToWei(Number(formatUnits(sellAmount, p.collTok.decimals)) * priceAtTrigger * 0.97 / debtPx, p.debtTok.decimals);
      const validTo = Math.floor(Date.now() / 1000) + 6 * 3600; // parked for up to 6h
      const intent = {
        safe: getAddress(p.safe), nonce: BigInt(Math.floor(Date.now() / 1000)), deadline: BigInt(validTo + 1800), mode: 0n,
        collateral: p.collTok.address, debt: p.debtTok.address, sellAmount, repayAmount, minBuy, flash, orderValidTo: BigInt(validTo), minHealthFactor: 0n,
        receiver: '0x0000000000000000000000000000000000000000' as Address,
        triggerHealthFactor: floatToWei(trigger), withdrawExtra: 0n,
      };
      const { uid } = await relayRetarget(intent, 'Arming stop', false, p.module);
      setStatus(`🛡 Stop armed — sells ${pct}% if HF < ${trigger.toFixed(2)} · parked until ${new Date(validTo * 1000).toLocaleTimeString()} · ${short(uid)}`);
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ── OPEN: carrier order (one signature, gasless) → solver deploys Safe + opens ──
  async function doOpen() {
    if (!walletClient || !publicClient || !address || !openAmts || !openPlan) return;
    setBusy(true); setErr(null);
    try {
      // consume the displayed plan VERBATIM — the user saw this Safe address and these UIDs
      const { intent, safe: safeAddr, levUid, levJson, levHash, carrierJson, carrierHash, carrierOrder } = openPlan;
      if (intent.validTo - 120 < Math.floor(Date.now() / 1000)) throw new Error('quote went stale — try again');
      // stale-plan guards (codex): the plan must belong to the connected account and pay into its own Safe
      if (intent.owner.toLowerCase() !== address.toLowerCase()) throw new Error('account changed — plan re-deriving, try again');
      if (carrierOrder.receiver.toLowerCase() !== safeAddr.toLowerCase()) throw new Error('inconsistent plan — try again');

      // one-time vault-relayer allowance for the carrier order
      const sellAmt = BigInt(carrierOrder.sellAmount);
      const allowance = await publicClient.readContract({ address: intent.debt, abi: ERC20_ABI, functionName: 'allowance', args: [address, O.relayer as Address] }) as bigint;
      if (allowance < sellAmt) {
        setStatus('One-time CoW approval (same as cowswap.exchange — never asked again)…');
        const h = await walletClient.writeContract({ address: intent.debt, abi: ERC20_ABI, functionName: 'approve', args: [O.relayer as Address, MAXU], chain: undefined, account: address });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }

      setStatus('Sign your leverage swap (your only signature)…');
      const sig = await walletClient.signTypedData({
        account: address, domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 100, verifyingContract: O.settlement as Address },
        types: GPV2_ORDER_TYPES, primaryType: 'Order',
        message: { ...carrierOrder, sellAmount: BigInt(carrierOrder.sellAmount), buyAmount: BigInt(carrierOrder.buyAmount), validTo: BigInt(carrierOrder.validTo), feeAmount: 0n } as never,
      });
      saveSafe(safeAddr);

      setStatus('Solver is deploying your Safe…');
      await barn('appdata', { hash: carrierHash, fullAppData: carrierJson });
      const cs = await barn('order', { order: { ...carrierOrder, signingScheme: 'eip712', signature: sig, from: address } });
      if (cs.status !== 201) throw new Error('carrier rejected: ' + JSON.stringify(cs.body));
      if (await pollFill(cs.body as string, (s) => setStatus('Deploying Safe (' + s + ')…'), 60) !== 'fulfilled') throw new Error('carrier did not settle — equity is safe in your wallet; try again.');

      setStatus('Opening your position (waiting for a solver)…');
      await barn('appdata', { hash: levHash, fullAppData: levJson });
      const lo = { sellToken: intent.debt, buyToken: intent.collateral, receiver: safeAddr, sellAmount: intent.flash.toString(), buyAmount: intent.buyMin.toString(), validTo: intent.validTo, appData: levHash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', signingScheme: 'eip1271', signature: '0x', from: safeAddr };
      const ls = await barn('order', { order: lo });
      if (ls.status !== 201) throw new Error('leverage rejected: ' + JSON.stringify(ls.body));
      if (await pollFill(levUid, (s) => setStatus('Opening position (' + s + ')…')) !== 'fulfilled') throw new Error('leverage order expired — your Safe holds the equity; retry from the position list.');

      setStatus('✅ Position opened'); setAmount('1'); setLev(1); setShowLev(false);
      await loadPositions();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ── REDUCE / CLOSE intent builder (shared by the click path AND the plan preview) ──
  async function buildReduceIntent(pct: number): Promise<Record<string, bigint | number | string>> {
    const p = sell as LivePos;
    {
      const full = pct >= 100;
      // every close (full or partial) pays the freed equity to the receiver — default = the owner
      let recv: Address;
      try { recv = getAddress((receiver.trim() || address) as string); }
      catch { throw new Error('receiver is not a valid address'); }
      const isV4 = p.module.toLowerCase() === (LEV_MODULE_V4 as string).toLowerCase();
      const intoColl = buy.address.toLowerCase() === p.collTok.address.toLowerCase(); // receive collateral instead of debt token
      if (isV4 && intoColl && !full) throw new Error('this position predates collateral payout — receive the debt token, or close and reopen');
      if (isV4 && intoColl && full) throw new Error('this position predates collateral payout — receive the debt token');
      const repayAmount = full ? MAXU : (p.debtQty * BigInt(pct)) / 100n;
      const flash = ((full ? p.debtQty : repayAmount) * 103n) / 100n;
      const flashRepay = flash + (flash * 5n + 9999n) / 10000n;
      let sellAmount: bigint; let withdrawExtra = 0n; let minBuy: bigint;
      if (intoColl) {
        // sell only enough collateral to cover the flash repayment (5% overshoot); the rest of the
        // freed portion is withdrawn as collateral and paid out by the module
        const price = p.collQty > 0n ? p.m.collateralUsd / Number(formatUnits(p.collQty, p.collTok.decimals)) : 0;
        const debtPx = p.debtQty > 0n ? p.m.debtUsd / Number(formatUnits(p.debtQty, p.debtTok.decimals)) : 1;
        if (price <= 0) throw new Error('no price');
        const repayUsd = Number(formatUnits(flashRepay, p.debtTok.decimals)) * debtPx;
        sellAmount = floatToWei((repayUsd / price) * 1.05, p.collTok.decimals);
        const portion = full ? p.collQty : (p.collQty * BigInt(pct)) / 100n;
        if (sellAmount >= portion) throw new Error('position too small to pay out in collateral — receive the debt token instead');
        withdrawExtra = full ? 0n : portion - sellAmount; // full close withdraws everything anyway
        const q = await quoteOut(p.collTok.address, p.debtTok.address, sellAmount, p.safe);
        if (!q) throw new Error('quote failed');
        minBuy = minOut(q, Math.max(slippagePct, 2));
        if (minBuy < flashRepay) throw new Error('quote too low to cover the flash loan — try receiving the debt token');
      } else {
        sellAmount = full ? p.collQty : (p.collQty * BigInt(pct)) / 100n;
        const q = await quoteOut(p.collTok.address, p.debtTok.address, sellAmount, p.safe);
        if (!q) throw new Error('quote failed');
        minBuy = minOut(q, Math.max(slippagePct, 2));
      }
      const validTo = Math.floor(Date.now() / 1000) + 1800;
      // partial close must leave the residual healthy (codex medium): floor = min(currentHF·0.98, 1.1).
      // pure deleverage RAISES HF so it always passes; an into-collateral payout is bounded by it.
      const cur = p.m.healthFactor;
      const closeMinHF = full ? 0n : floatToWei(Math.min(isFinite(cur) && cur < 100 ? cur * 0.98 : 1.1, 1.1));
      const intent = {
        safe: getAddress(p.safe), nonce: BigInt(Math.floor(Date.now() / 1000)), deadline: BigInt(validTo + 1800), mode: 0n,
        collateral: p.collTok.address, debt: p.debtTok.address, sellAmount, repayAmount, minBuy, flash, orderValidTo: BigInt(validTo), minHealthFactor: closeMinHF,
        receiver: recv, triggerHealthFactor: 0n, withdrawExtra,
      };
      if (isV4) {
        // v4 has no partial payout: partial closes leave the freed equity in the Safe
        if (!full) (intent as Record<string, unknown>).receiver = '0x0000000000000000000000000000000000000000';
        (intent as Record<string, unknown>).withdrawExtra = 0n;
      }
      return intent;
    }
  }

  async function doReduce(pct: number) {
    if (!walletClient || !publicClient || !address || !sellIsPos) return;
    const p = sell as LivePos;
    setBusy(true); setErr(null); setStatus('Quoting…');
    try {
      const full = pct >= 100;
      // consume the PREVIEWED intent when fresh — the user saw exactly this UID
      const fresh = managePlan && managePlan.kind === 'close' && Number(managePlan.intent.orderValidTo) - 120 > Math.floor(Date.now() / 1000);
      const intent = fresh ? managePlan!.intent : await buildReduceIntent(pct);
      await relayRetarget(intent, full ? 'Closing position' : `Reducing ${pct}%`, true, p.module);
      setStatus(full ? '✅ Position closed' : `✅ Reduced ${pct}%`);
      if (full) { setSell(WXDAI); setAmount('1'); }
      await loadPositions();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ── ADJUST LEVERAGE (target) via LevManagerModule: INCREASE up / REDUCE down ──
  // adjust intent builder (shared by the click path AND the plan preview)
  async function buildAdjustIntent(target: number): Promise<Record<string, bigint | number | string>> {
    const p = sell as LivePos;
    const cur = p.m.leverage;
    {
      const equityUsd = Math.max(p.m.equityUsd, 0);
      const collPrice = p.collQty > 0n ? p.m.collateralUsd / Number(formatUnits(p.collQty, p.collTok.decimals)) : 0;
      // debt-token USD price from the account's own balances (handles EURe ≠ $1, 6-dec tokens)
      const debtPrice = p.debtQty > 0n ? p.m.debtUsd / Number(formatUnits(p.debtQty, p.debtTok.decimals)) : 1;
      if (collPrice <= 0 || !(debtPrice > 0)) throw new Error('no price');
      const validTo = Math.floor(Date.now() / 1000) + 1800;
      const deltaUsd = Math.abs(target - cur) * equityUsd;       // USD value to move
      const deltaDebt = deltaUsd / debtPrice;                     // in debt-token units
      if (target > cur) {
        // INCREASE: borrow Δ debt, buy collateral, supply it
        const sellAmount = floatToWei(deltaDebt, p.debtTok.decimals);
        const cap = (p.availBase * (10n ** 10n) * 90n) / 100n; // availableBorrowsBase (8dec) → 18dec USD, 90%
        const sellUsd = floatToWei(deltaUsd); // 18-dec USD for the cap comparison
        if (sellUsd > cap) throw new Error('exceeds Aave borrow capacity at that leverage');
        const q = await quoteOut(p.debtTok.address, p.collTok.address, sellAmount, p.safe);
        if (!q) throw new Error('quote failed');
        const minBuy = minOut(q, Math.max(slippagePct, 2));
        const intent = {
          safe: getAddress(p.safe), nonce: BigInt(Math.floor(Date.now() / 1000)), deadline: BigInt(validTo + 1800), mode: 1n,
          collateral: p.collTok.address, debt: p.debtTok.address, sellAmount, repayAmount: 0n, minBuy, flash: 0n, orderValidTo: BigInt(validTo), minHealthFactor: 1050000000000000000n,
          receiver: '0x0000000000000000000000000000000000000000' as Address, triggerHealthFactor: 0n, withdrawExtra: 0n, // not a close — nothing to sweep
        };
        return intent;
      } else {
        // DECREASE: sell Δ-worth collateral (overshoot so guaranteed minBuy still covers flash+premium),
        // repay Δ debt. Any surplus debt token stays in the Safe (small equity bump).
        const repayAmount = floatToWei(deltaDebt, p.debtTok.decimals);
        const sellAmount = floatToWei((deltaUsd / collPrice) * 1.05, p.collTok.decimals); // 5% extra collateral
        const flash = (repayAmount * 103n) / 100n;
        const q = await quoteOut(p.collTok.address, p.debtTok.address, sellAmount, p.safe);
        if (!q) throw new Error('quote failed');
        const minBuy = minOut(q, Math.max(slippagePct, 2));
        const intent = {
          safe: getAddress(p.safe), nonce: BigInt(Math.floor(Date.now() / 1000)), deadline: BigInt(validTo + 1800), mode: 0n,
          collateral: p.collTok.address, debt: p.debtTok.address, sellAmount, repayAmount, minBuy, flash, orderValidTo: BigInt(validTo), minHealthFactor: 0n,
          receiver: '0x0000000000000000000000000000000000000000' as Address, triggerHealthFactor: 0n, withdrawExtra: 0n, // partial reduce — residual stays as position buffer
        };
        return intent;
      }
    }
  }

  async function doAdjust(target: number) {
    if (!walletClient || !publicClient || !address || !sellIsPos) return;
    const p = sell as LivePos;
    const cur = p.m.leverage;
    if (Math.abs(target - cur) < 0.05) { setErr('Target leverage unchanged'); return; }
    setBusy(true); setErr(null); setStatus('Quoting…');
    try {
      const fresh = managePlan && managePlan.kind === 'adjust' && Number(managePlan.intent.orderValidTo) - 120 > Math.floor(Date.now() / 1000);
      const intent = fresh ? managePlan!.intent : await buildAdjustIntent(target);
      await relayRetarget(intent, target > cur ? `Increasing to ${target.toFixed(1)}x` : `Decreasing to ${target.toFixed(1)}x`, true, p.module);
      setStatus('✅ Leverage adjusted');
      await loadPositions();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ── PLAIN SWAP (1×): a normal CoW order from the wallet (no leverage, no Safe) ──
  async function doSwap() {
    if (!walletClient || !publicClient || !address) return;
    const sellTok = sell as UIToken;
    setBusy(true); setErr(null); setStatus('Quoting…');
    try {
      const validTo = Math.floor(Date.now() / 1000) + 1800;
      const q = previewBuy ?? await quoteOut(sellTok.address, buy.address, equity, address);
      if (!q) throw new Error('quote failed');
      const buyMin = minOut(q, slippagePct);
      const allowance = await publicClient.readContract({ address: sellTok.address, abi: ERC20_ABI, functionName: 'allowance', args: [address, O.relayer as Address] }) as bigint;
      if (allowance < equity) {
        setStatus('One-time CoW approval (same as cowswap.exchange — never asked again)…');
        const h = await walletClient.writeContract({ address: sellTok.address, abi: ERC20_ABI, functionName: 'approve', args: [O.relayer as Address, MAXU], chain: undefined, account: address });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }
      const appDoc = JSON.stringify({ appCode: 'CoW Leverage', version: '1.6.0', metadata: {} });
      const appHash = keccak256(toHex(appDoc));
      const order = { sellToken: sellTok.address, buyToken: buy.address, receiver: address, sellAmount: equity.toString(), buyAmount: buyMin.toString(), validTo, appData: appHash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
      setStatus('Sign your swap (your only signature)…');
      const sig = await walletClient.signTypedData({
        account: address, domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 100, verifyingContract: O.settlement as Address },
        types: GPV2_ORDER_TYPES, primaryType: 'Order',
        message: { ...order, sellAmount: BigInt(order.sellAmount), buyAmount: BigInt(order.buyAmount), validTo: BigInt(order.validTo), feeAmount: 0n } as never,
      });
      await barn('appdata', { hash: appHash, fullAppData: appDoc });
      const os = await barn('order', { order: { ...order, signingScheme: 'eip712', signature: sig, from: address } });
      if (os.status !== 201) throw new Error('swap rejected: ' + JSON.stringify(os.body));
      setStatus('Swap in the auction — waiting for a solver…');
      if (await pollFill(os.body as string, (s) => setStatus('Swap (' + s + ')…')) !== 'fulfilled') throw new Error('swap expired — try again.');
      setStatus('✅ Swap filled');
      if (address && publicClient) publicClient.readContract({ address: sellTok.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }).then((b) => setBal(b as bigint)).catch(() => {});
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ── CTA dispatch ──
  const samePair = !sellIsPos && (sell as UIToken).address.toLowerCase() === buy.address.toLowerCase();
  const supportedOpen = !sellIsPos && !!pairLev;
  function onCta() {
    if (!isConnected) return;
    if (!onGnosis) { switchChain({ chainId: gnosis.id }); return; }
    if (sellIsPos) {
      if (posMode === 'leverage') { if (lev <= 1.01) doReduce(100); else doAdjust(lev); }
      else { const pct = Math.min(100, Math.max(1, Math.round(parseFloat(amount) || 0))); doReduce(pct); }
    } else if (lev > 1) doOpen();
    else doSwap();
  }
  let ctaLabel = 'Enter an amount';
  if (sellIsPos && posMode === 'leverage') { const c = (sell as LivePos).m.leverage; ctaLabel = lev <= 1.01 ? 'Close Position' : lev > c + 0.05 ? 'Increase Leverage' : lev < c - 0.05 ? 'Decrease Leverage' : 'Adjust Leverage'; }
  else if (sellIsPos) ctaLabel = parseFloat(amount) >= 100 ? 'Close Position' : `Reduce ${parseFloat(amount) || 0}%`;
  else if (lev > 1 && equity > 0n) ctaLabel = supportedOpen ? (insufficient ? 'Insufficient balance' : `Open ${lev}× Long`) : 'Leverage not available for this pair';
  else if (equity > 0n) ctaLabel = samePair ? 'Select two different tokens' : insufficient ? 'Insufficient balance' : 'Swap';
  const ctaDisabled = busy || !isConnected || !onGnosis
    || (sellIsPos ? (posMode === 'leverage' ? Math.abs(lev - (sell as LivePos).m.leverage) < 0.05 && lev > 1.01 : false)
                  : !(equity > 0n && !insufficient && !samePair && (lev <= 1 || (supportedOpen && !!openPlan))));

  // ── render ──
  const posTokens: UIToken[] = sellIsPos
    ? [(sell as LivePos).debtTok, (sell as LivePos).collTok].map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals, kind: tokenKind(t.address), name: t.symbol }))
    : [];
  // with a position selected, the receive side can ONLY be one of its two assets
  const universe = sellIsPos && selSide === 'buy' ? posTokens : TOKENS;
  const filtered = universe.filter((t) => !search || t.symbol.toLowerCase().includes(search.toLowerCase()) || t.name.toLowerCase().includes(search.toLowerCase()) || t.address.toLowerCase() === search.toLowerCase());
  // one multicall for all listed balances, only while the picker is open (same as the TWAP picker)
  const selBalances = useTokenBalances(selOpen ? listTokens : [], 100, selOpen ? address : undefined);
  const { token: customTok } = useToken(GNOSIS_CFG, isAddress(search) ? (search as Address) : undefined);

  return (
    <div className="lev-scope">
      <div className="lev-wrap">
        <div className="lev-card">
          {/* tabs live inside the card (CoW layout) */}
          <div className="lev-cardtop">
            {tabs}
            <button className="lev-gear" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
          </div>
          {/* SELL */}
          <div className="lev-panel">
            {sellIsPos && (
              <div className="lev-pill" style={{ marginBottom: 12 }}>
                <button className={posMode === 'close' ? 'on' : ''} onClick={() => { setPosMode('close'); setAmount('100'); }}>Close / Reduce</button>
                <button className={posMode === 'leverage' ? 'on' : ''} onClick={() => { setPosMode('leverage'); setLev((sell as LivePos).m.leverage); }}>Adjust Leverage</button>
              </div>
            )}
            {sellIsPos && posMode === 'leverage' ? (
              <>
                <div className="lev-stat"><span className="k">Current Leverage: {(sell as LivePos).m.leverage.toFixed(2)}x</span><span className="v">Target: {lev.toFixed(1)}x</span></div>
                <input className="lev-range" type="range" min={1} max={posMaxLev} step={0.1} value={lev} onChange={(e) => setLev(parseFloat(e.target.value))} />
                <div className="lev-stat" style={{ marginTop: 4 }}><span className="k">1.0x</span><span className="k">{posMaxLev.toFixed(1)}x</span></div>
              </>
            ) : (
              <>
                <div className="lbl"><span>{sellIsPos ? 'Reduce by' : 'Sell'}</span><span>{sellIsPos ? `Collat ${Number(formatUnits((sell as LivePos).collQty, (sell as LivePos).collTok.decimals)).toFixed(4)} ${(sell as LivePos).collTok.symbol}` : bal != null ? `Balance ${Number(formatUnits(bal, (sell as UIToken).decimals)).toFixed(4)}` : ''}</span></div>
                <div className="lev-amtrow">
                  <input className="lev-amt" value={amount} inputMode="decimal" placeholder="0" onChange={(e) => { if (sellIsPos) { const v = parseFloat(e.target.value); setAmount(v > 100 ? '100' : e.target.value); } else setAmount(e.target.value); }} />
                  {sellIsPos && <span style={{ fontSize: 28, color: 'var(--lev-muted)' }}>%</span>}
                  <button className="lev-tok" onClick={() => openSelect('sell')}>
                    {sellIsPos ? <span className="ph"><TokenIcon chainId={100} address={(sell as LivePos).collTok.address} symbol={(sell as LivePos).collTok.symbol} /></span> : <TokenIcon chainId={100} address={(sell as UIToken).address} symbol={(sell as UIToken).symbol} />}
                    {sellIsPos ? `${(sell as LivePos).collTok.symbol} ${(sell as LivePos).m.leverage.toFixed(1)}x` : (sell as UIToken).symbol} ▾
                  </button>
                </div>
                {sellIsPos && <div className="lev-chips">{['25', '50', '75', '100'].map((v) => <button key={v} onClick={() => setAmount(v)}>{v === '100' ? 'Max' : v + '%'}</button>)}</div>}
                {!sellIsPos && bal != null && (
                  <div className="lev-chips">{['25', '50', '75', '100'].map((pc) => <button key={pc} onClick={() => setAmount(formatUnits((bal * BigInt(pc)) / 100n, (sell as UIToken).decimals))}>{pc === '100' ? 'Max' : pc + '%'}</button>)}</div>
                )}
              </>
            )}
          </div>

          <div className="lev-flip"><button onClick={() => { if (!sellIsPos) { const s = sell as UIToken; setSell(buy); setBuy(s); setLev(1); setShowLev(false); } }}>↓</button></div>

          {/* BUY */}
          <div className="lev-panel">
            <div className="lbl">
              <span>{sellIsPos ? (posMode === 'leverage' ? 'New position' : 'Receive') : 'Buy'}</span>
              {!sellIsPos && supportedOpen && (
                <button className={`lev-levbadge ${lev > 1 ? 'on' : 'off'}`} onClick={() => { setShowLev((v) => !v); if (lev === 1) setLev(2); }}>↗ {lev > 1 ? `${lev}x Leverage` : 'Add Leverage'}</button>
              )}
            </div>
            {showLev && !sellIsPos && (
              <div className="lev-levbox">
                <div className="top"><span>Leverage{pairLev && pairLev.eMode > 0 ? ` · eMode: ${pairLev.label}` : ''}</span><b>{lev.toFixed(1)}x</b></div>
                <input className="lev-range" type="range" min={1} max={maxLev} step={0.1} value={lev} onChange={(e) => setLev(parseFloat(e.target.value))} />
                <div className="lev-stat" style={{ marginTop: 4 }}><span className="k">1.0x</span><span className="k">{maxLev.toFixed(1)}x</span></div>
              </div>
            )}
            <div className="lev-amtrow">
              <input className="lev-amt" style={{ color: 'var(--lev-pri)' }} readOnly value={
                sellIsPos
                  ? (posMode === 'close' ? (previewReduce != null ? Number(formatUnits(previewReduce, buy.decimals)).toFixed(buy.decimals === 6 ? 2 : 5) : '') : '')
                  : (previewBuy ? Number(formatUnits(previewBuy, buy.decimals)).toFixed(5) : '0')
              } placeholder="0" />
              <button className="lev-tok" onClick={() => openSelect('buy')}><TokenIcon chainId={100} address={buy.address} symbol={buy.symbol} /> {buy.symbol} ▾</button>
            </div>
            {sellIsPos && posMode === 'close' && parseFloat(amount) > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="lev-stat"><span className="k">Send proceeds to</span></div>
                <input
                  className="lev-amt" style={{ fontSize: 13, width: '100%' }} spellCheck={false}
                  placeholder={address ? `${address} (you)` : 'connect wallet'}
                  value={receiver} onChange={(e) => setReceiver(e.target.value)}
                />
                <div className="lev-stat"><span className="k" style={{ fontSize: 11 }}>{parseFloat(amount) >= 100 ? 'All remaining funds (incl. dust) are sent here on close' : 'The freed equity is sent here'} · default: your wallet</span></div>
                {managePlan && managePlan.kind === 'close' && (
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,.06)' }}>
                    <div className="lev-stat"><span className="k">Order UID (deterministic)</span><span className="v"><ExtLink href={explorerUrl(managePlan.uid)}>{short(managePlan.uid)}</ExtLink></span></div>
                    <div className="lev-stat"><span className="k">Position Safe</span><span className="v"><ExtLink href={safeAppUrl((sell as LivePos).safe)}>{short((sell as LivePos).safe)}</ExtLink>&nbsp;·&nbsp;<ExtLink href={scanUrl((sell as LivePos).safe)}>scan</ExtLink></span></div>
                  </div>
                )}
              </div>
            )}
            {!sellIsPos && lev > 1 && openAmts && (
              <div style={{ marginTop: 10 }}>
                <div className="lev-stat"><span className="k">Debt (Aave V3)</span><span className="v" style={{ color: '#ffa53b' }}>{Number(formatUnits(openAmts.borrow, (sell as UIToken).decimals)).toFixed(4)} {(sell as UIToken).symbol}</span></div>
                {pairLev && pairLev.eMode > 0 && <div className="lev-stat"><span className="k">Aave eMode</span><span className="v" style={{ color: '#46d39a' }}>{pairLev.label} · LTV {(pairLev.ltvBps / 100).toFixed(0)}%</span></div>}
                <div className="lev-stat"><span className="k">Est. health factor</span><span className="v" style={{ color: estHF && estHF > 1.4 ? '#46d39a' : '#ffa53b' }}>{estHF ? estHF.toFixed(2) : '—'}</span></div>
                {estLiqPrice && <div className="lev-stat"><span className="k">Deleverage price</span><span className="v" style={{ color: '#ff8e8e' }}>{estLiqPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} {(sell as UIToken).symbol}</span></div>}
              </div>
            )}
            {/* pre-open plan: what will happen, the deterministic Safe + both order UIDs, with links */}
            {!sellIsPos && lev > 1 && openAmts && openPlan && (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,.06)' }}>
                <div className="lev-stat"><span className="k" style={{ fontSize: 11 }}>What happens (you sign step 1 only):</span></div>
                <div className="lev-stat"><span className="k">1 · Fund Safe (exact)</span><span className="v">{Number(formatUnits(BigInt(openPlan.carrierOrder.sellAmount), (sell as UIToken).decimals)).toFixed(4)} {(sell as UIToken).symbol} → Safe</span></div>
                <div className="lev-stat"><span className="k">2 · Flash-swap</span><span className="v">{Number(formatUnits(openPlan.intent.flash, (sell as UIToken).decimals)).toFixed(4)} {(sell as UIToken).symbol} → ≥ {Number(formatUnits(openPlan.intent.buyMin, buy.decimals)).toFixed(5)} {buy.symbol}</span></div>
                <div className="lev-stat"><span className="k">3 · Supply + borrow</span><span className="v">supply {buy.symbol}{openPlan.intent.eMode > 0 ? ' (eMode)' : ''} · borrow ≈{Number(formatUnits(openPlan.intent.borrow, (sell as UIToken).decimals)).toFixed(4)} {(sell as UIToken).symbol} (auto-adjusts for fees)</span></div>
                <div className="lev-stat"><span className="k">4 · Repay flash</span><span className="v">{Number(formatUnits(openPlan.intent.repay, (sell as UIToken).decimals)).toFixed(4)} {(sell as UIToken).symbol}</span></div>
                <div className="lev-stat" style={{ marginTop: 6 }}><span className="k">Your Safe (deterministic)</span><span className="v"><ExtLink href={safeAppUrl(openPlan.safe)}>{short(openPlan.safe)}</ExtLink>&nbsp;·&nbsp;<ExtLink href={scanUrl(openPlan.safe)}>scan</ExtLink></span></div>
                <div className="lev-stat"><span className="k">Funding order UID</span><span className="v"><ExtLink href={explorerUrl(openPlan.carrierUid)}>{short(openPlan.carrierUid)}</ExtLink></span></div>
                <div className="lev-stat"><span className="k">Open order UID (signed by the Safe)</span><span className="v"><ExtLink href={explorerUrl(openPlan.levUid)}>{short(openPlan.levUid)}</ExtLink></span></div>
              </div>
            )}
            {!sellIsPos && lev > 1 && openAmts && !openPlan && (
              <div className="lev-stat" style={{ marginTop: 10 }}><span className="k">Deriving your Safe + order UIDs…</span></div>
            )}
          </div>

          {sellIsPos && posMode === 'leverage' && (
            <div className="lev-detail" style={{ margin: 4 }}>
              <div className="lev-stat"><span className="k">Leverage</span><span className="v"><span style={{ textDecoration: 'line-through', opacity: .5, marginRight: 6 }}>{(sell as LivePos).m.leverage.toFixed(2)}x</span><span style={{ color: lev < (sell as LivePos).m.leverage ? '#46d39a' : '#ffa53b' }}>{lev.toFixed(1)}x</span></span></div>
              <div className="lev-stat"><span className="k">Health factor</span><span className="v">{(sell as LivePos).m.healthFactor > 100 ? '∞' : (sell as LivePos).m.healthFactor.toFixed(2)}</span></div>
              {(sell as LivePos).m.liqPrice && <div className="lev-stat"><span className="k">Liquidation price</span><span className="v">{(sell as LivePos).m.liqPrice!.toLocaleString(undefined, { maximumFractionDigits: 0 })} WXDAI</span></div>}
              {managePlan && (
                <>
                  <div className="lev-stat"><span className="k">Order UID (deterministic)</span><span className="v"><ExtLink href={explorerUrl(managePlan.uid)}>{short(managePlan.uid)}</ExtLink></span></div>
                  <div className="lev-stat"><span className="k">Position Safe</span><span className="v"><ExtLink href={safeAppUrl((sell as LivePos).safe)}>{short((sell as LivePos).safe)}</ExtLink>&nbsp;·&nbsp;<ExtLink href={scanUrl((sell as LivePos).safe)}>scan</ExtLink></span></div>
                </>
              )}
              {/* stop protection: a parked deleverage order that turns fillable only while HF < trigger */}
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,.06)' }}>
                <div className="lev-stat"><span className="k">🛡 Stop protection (one signature, trustless)</span></div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <span className="k" style={{ fontSize: 12 }}>if HF &lt;</span>
                  <input className="lev-amt" style={{ fontSize: 14, width: 64 }} value={stopHF} onChange={(e) => setStopHF(e.target.value)} />
                  <span className="k" style={{ fontSize: 12 }}>sell</span>
                  <input className="lev-amt" style={{ fontSize: 14, width: 48 }} value={stopPct} onChange={(e) => setStopPct(e.target.value)} />
                  <span className="k" style={{ fontSize: 12 }}>% of collateral</span>
                  <button className="lev-tok" disabled={busy} onClick={doArmStop} style={{ marginLeft: 'auto' }}>Arm</button>
                </div>
                <div className="lev-stat"><span className="k" style={{ fontSize: 11 }}>Parks in the auction; fillable only while HF is below the trigger — enforced on-chain</span></div>
              </div>
            </div>
          )}

          {!sellIsPos && lev > 1 && entryPrice && (
            <div className="lev-rate">1 {buy.symbol} = {entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} {!sellIsPos ? (sell as UIToken).symbol : ''} · slippage {slippagePct}%</div>
          )}

          <button className={`lev-cta ${ctaLabel.includes('Increase') ? 'warn' : ctaLabel.includes('Close') ? 'danger' : ''}`} disabled={ctaDisabled} onClick={onCta}>{busy ? 'Working…' : ctaLabel}</button>
          {!sellIsPos && lev > 1 && <div className="lev-foot">Leverage powered by Aave V3 · settled atomically by CoW Protocol</div>}
        </div>

        {status && <p className="lev-foot" style={{ color: status.startsWith('✅') ? '#46d39a' : 'var(--lev-muted)' }}>{status}</p>}
        {err && <p className="lev-foot" style={{ color: '#ff6b6b' }}>{err}</p>}
        {isConnected && !onGnosis && <p className="lev-foot">Switch to Gnosis to trade.</p>}
        <div className="lev-foot">CoW Protocol protects you from MEV · each position is its own Safe you own · staging (barn) · <a href="/leverage/architecture">how it works ↗</a></div>
      </div>

      {/* token / position selector */}
      {selOpen && (
        <div className="lev-ov" onClick={() => setSelOpen(false)}>
          <div className="lev-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Select {selSide === 'sell' ? 'token to sell' : 'token to receive'}</h3>
            <input className="lev-search" placeholder="Search name or paste address" value={search} onChange={(e) => setSearch(e.target.value)} />
            {selSide === 'sell' && positions.length > 0 && (
              <>
                <div className="lev-secttl">Your positions</div>
                {positions.map((p) => (
                  <button key={p.safe} className="lev-trow pos" onClick={() => pickPosition(p)}>
                    <span className="l"><span className="ph"><TokenIcon chainId={100} address={p.collTok.address} symbol={p.collTok.symbol} /></span>
                      <span><span className="sym">{p.collTok.symbol} <span className="lev-tag">{p.m.leverage.toFixed(1)}x</span></span>
                        <span style={{ fontSize: 12, color: 'var(--lev-muted)', display: 'block' }}>Collat {Number(formatUnits(p.collQty, p.collTok.decimals)).toFixed(4)} · Debt {Number(formatUnits(p.debtQty, p.debtTok.decimals)).toFixed(2)} {p.debtTok.symbol}</span></span></span>
                    <span className="r"><span style={{ fontSize: 12, color: 'var(--lev-muted)' }}>Liq {p.m.liqPrice ? p.m.liqPrice.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</span>
                      <span style={{ fontSize: 11, display: 'block', color: (p.m.dropToLiqPct ?? 99) < 8 ? '#ff6b6b' : (p.m.dropToLiqPct ?? 99) < 15 ? '#ffa53b' : 'var(--lev-muted)' }}>{p.m.dropToLiqPct != null ? `-${p.m.dropToLiqPct.toFixed(1)}% to liq` : ''}</span></span>
                  </button>
                ))}
                <div className="lev-divider" />
              </>
            )}
            <div className="lev-secttl">Tokens</div>
            {isAddress(search) && customTok && !filtered.some((t) => t.address.toLowerCase() === customTok.address.toLowerCase()) && (
              <button className="lev-trow" onClick={() => pickToken({ address: customTok.address, symbol: customTok.symbol, decimals: customTok.decimals, name: customTok.name, kind: tokenKind(customTok.address) })}>
                <span className="l"><TokenIcon chainId={100} address={customTok.address} symbol={customTok.symbol} /><span className="sym">{customTok.symbol} <span style={{ fontSize: 11, color: 'var(--lev-muted)', fontWeight: 400 }}>{customTok.name}</span></span></span>
              </button>
            )}
            {[...filtered].sort((a, z) => { const ba = selBalances.get(a.address.toLowerCase()) ?? 0n; const bz = selBalances.get(z.address.toLowerCase()) ?? 0n; return ba === bz ? 0 : ba > bz ? -1 : 1; }).map((t) => {
              const b = selBalances.get(t.address.toLowerCase());
              return (
                <button key={t.address} className="lev-trow" onClick={() => pickToken(t)}>
                  <span className="l"><TokenIcon chainId={100} address={t.address} symbol={t.symbol} /><span className="sym">{t.symbol} <span style={{ fontSize: 11, color: 'var(--lev-muted)', fontWeight: 400 }}>{t.name}</span></span></span>
                  {b !== undefined && b > 0n && <span className="r" style={{ fontSize: 13 }}>{Number(formatUnits(b, t.decimals)).toFixed(4)}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* settings (slippage) */}
      {settingsOpen && (
        <div className="lev-ov" onClick={() => setSettingsOpen(false)}>
          <div className="lev-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <h3>Settings</h3>
            <div className="lbl" style={{ marginBottom: 6 }}><span>Slippage tolerance</span><span>{slippagePct}%</span></div>
            <div className="lev-chips">{[0.5, 1, 2, 5].map((s) => <button key={s} className={slippagePct === s ? 'on' : ''} onClick={() => setSlippagePct(s)}>{s}%</button>)}</div>
            <p className="lev-foot" style={{ textAlign: 'left', marginTop: 12 }}>Minimum-received protection on every leg. Higher tolerance fills more reliably in volatile markets.</p>
          </div>
        </div>
      )}
    </div>
  );
}
