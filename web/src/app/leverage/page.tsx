'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { encodeFunctionData, formatUnits, getAddress, keccak256, parseUnits, toHex, type Address } from 'viem';
import { gnosis } from 'wagmi/chains';
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { ConnectButton } from '../../components/ConnectButton';
import { TokenIcon } from '../../components/TokenIcon';
import { erc20Abi } from '../../lib/abi';
import { positionMetrics, type PositionMetrics } from '../../lib/leverage';
import {
  ONBOARD, IB_ABI, ERC20_ABI, GPV2_ORDER_TYPES, RETARGET_TYPES, LEV_MODULE, POOL_ADDR, type Intent,
} from '../../lib/onboard';

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
const TOKENS: UIToken[] = [WXDAI, WETH];

type LivePos = {
  safe: Address; m: PositionMetrics; collQty: bigint; debtQty: bigint; availBase: bigint;
};

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

export default function LeveragePage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: gnosis.id });
  const onGnosis = chainId === gnosis.id;

  // sell side is a token or a position; buy side is always a token
  const [sell, setSell] = useState<UIToken | LivePos>(WXDAI);
  const [buy, setBuy] = useState<UIToken>(WETH);
  const [amount, setAmount] = useState('1');   // equity (open) OR percent (reduce)
  const [lev, setLev] = useState(1);
  const [showLev, setShowLev] = useState(false);
  const [slippagePct, setSlippagePct] = useState(1);
  const [posMode, setPosMode] = useState<'close' | 'leverage'>('close');
  const isPos = (x: UIToken | LivePos): x is LivePos => 'safe' in x;
  const sellIsPos = isPos(sell);

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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ── load positions (localStorage + live Aave reads) ──
  const loadPositions = useCallback(async () => {
    if (!publicClient) return;
    if (!address) { setPositions([]); return; } // no account → no positions to show
    const safes = loadSavedSafes();
    const live: LivePos[] = [];
    for (const safe of safes) {
      try {
        // only show Safes the *connected* account owns — a saved Safe from another
        // of the user's accounts must not appear under this one (it can't be managed here).
        const owned = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'isOwner', args: [address] }).catch(() => false) as boolean;
        if (!owned) continue;
        // a Safe without LevManagerModule enabled (stale/old-flow artifact) can't be managed
        // here — showing it would render Close/Adjust buttons that can only revert.
        const managed = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [LEV_MODULE as Address] }).catch(() => false) as boolean;
        if (!managed) continue;
        const acct = await publicClient.readContract({ address: POOL_ADDR as Address, abi: poolAbi, functionName: 'getUserAccountData', args: [safe] }) as readonly bigint[];
        if (acct[0] === 0n && acct[1] === 0n) continue; // closed / empty
        const collQty = await publicClient.readContract({ address: O.aweth as Address, abi: erc20Abi, functionName: 'balanceOf', args: [safe] }) as bigint;
        const debtQty = await publicClient.readContract({ address: O.vdebtWxdai as Address, abi: erc20Abi, functionName: 'balanceOf', args: [safe] }) as bigint;
        if (collQty === 0n) continue;
        const collQtyF = Number(formatUnits(collQty, WETH.decimals));
        const m = positionMetrics({ collateralBase: acct[0], debtBase: acct[1], liqThresholdBps: WETH_LIQ_THRESHOLD_BPS, healthFactor1e18: acct[5], collateralQty: collQtyF, collateralPriceUsd: collQtyF > 0 ? (Number(acct[0]) / 1e8) / collQtyF : 0 });
        live.push({ safe, m, collQty, debtQty, availBase: acct[2] });
      } catch { /* skip */ }
    }
    setPositions(live);
    // keep a live selection fresh after an action (?? cur tolerates a transient RPC blip
    // without deselecting; account-switch deselection is handled by the effect below).
    setSell((cur) => (isPos(cur) ? live.find((p) => p.safe.toLowerCase() === cur.safe.toLowerCase()) ?? cur : cur));
  }, [publicClient, address]);
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

  // close/reduce estimate: sell `pct` of collateral → WXDAI, minus the proportional debt repaid.
  // Net is the WXDAI freed (full close ≈ your equity back; partial ≈ small, it mostly deleverages).
  useEffect(() => {
    setPreviewReduce(null);
    if (!sellIsPos || posMode !== 'close') return;
    const p = sell as LivePos;
    const pct = Math.min(100, Math.max(0, parseFloat(amount) || 0));
    if (pct <= 0 || p.collQty === 0n) return;
    const full = pct >= 100;
    const sellAmount = full ? p.collQty : (p.collQty * BigInt(Math.round(pct))) / 100n;
    const debtPortion = full ? p.debtQty : (p.debtQty * BigInt(Math.round(pct))) / 100n;
    let live = true;
    quoteOut(O.weth as Address, O.wxdai as Address, sellAmount, p.safe).then((gross) => {
      if (!live) return;
      if (gross == null) { setPreviewReduce(null); return; }
      const premium = (debtPortion * 5n) / 10000n; // ~5bps Aave flash premium
      const net = gross - debtPortion - premium;
      setPreviewReduce(net > 0n ? net : 0n);
    });
    return () => { live = false; };
  }, [sellIsPos, posMode, sell, amount]);

  const estHF = useMemo(() => {
    if (!openAmts || openAmts.borrow === 0n) return null;
    const dec = (sell as UIToken).decimals;
    return (Number(formatUnits(openAmts.flash, dec)) * (WETH_LIQ_THRESHOLD_BPS / 10000)) / Number(formatUnits(openAmts.borrow, dec));
  }, [openAmts, sell]);
  // deleverage (liquidation) price for the OPEN preview, in WXDAI per WETH
  const estLiqPrice = useMemo(() => {
    if (!openAmts || !previewBuy || openAmts.borrow === 0n) return null;
    const collQty = Number(formatUnits(previewBuy, buy.decimals));
    return collQty > 0 ? Number(formatUnits(openAmts.borrow, (sell as UIToken).decimals)) / ((WETH_LIQ_THRESHOLD_BPS / 10000) * collQty) : null;
  }, [openAmts, previewBuy, buy.decimals, sell]);
  const entryPrice = useMemo(() => {
    if (!openAmts || !previewBuy) return null;
    const out = Number(formatUnits(previewBuy, buy.decimals));
    return out > 0 ? Number(formatUnits(openAmts.flash, (sell as UIToken).decimals)) / out : null;
  }, [openAmts, previewBuy, buy.decimals, sell]);

  // ── token selector ──
  function openSelect(side: 'sell' | 'buy') { setSelSide(side); setSearch(''); setSelOpen(true); }
  function pickToken(t: UIToken) {
    if (selSide === 'sell') { setSell(t); setLev(1); setShowLev(false); setAmount('1'); }
    else setBuy(t);
    setSelOpen(false);
  }
  function pickPosition(p: LivePos) { setSell(p); setPosMode('close'); setAmount('100'); setBuy(WXDAI); setSelOpen(false); }

  // ── sign a Retarget intent over the LevManagerModule domain & relay it ──
  async function relayRetarget(intent: Record<string, bigint | number | string>, label: string): Promise<{ uid: string }> {
    setStatus('Sign the management intent (one signature)…');
    const sig = await walletClient!.signTypedData({
      account: address!, domain: { name: 'LevManagerModule', version: '1', chainId: 100, verifyingContract: LEV_MODULE as Address },
      types: RETARGET_TYPES, primaryType: 'Retarget', message: intent as never,
    });
    setStatus('Relaying through the module…');
    const intentStr = Object.fromEntries(Object.entries(intent).map(([k, v]) => [k, v.toString()]));
    const rl = await postJson('/api/relay-execute', { intent: intentStr, sig });
    if (!rl.ok) throw new Error('relay: ' + (rl.error ?? JSON.stringify(rl)));
    setStatus('Order registered — submitting to the auction…');
    await barn('appdata', { hash: rl.appDataHash, fullAppData: rl.fullAppData });
    await sleep(1200);
    const reduce = Number(intent.mode) === 0;
    const order = {
      sellToken: reduce ? O.weth : O.wxdai,   // REDUCE sells collateral; INCREASE sells borrowed debt
      buyToken: reduce ? O.wxdai : O.weth,
      receiver: intent.safe, sellAmount: (intent.sellAmount as bigint).toString(), buyAmount: (intent.minBuy as bigint).toString(),
      validTo: Number(intent.orderValidTo), appData: rl.appDataHash, feeAmount: '0', kind: 'sell', partiallyFillable: false,
      sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', signingScheme: 'eip1271', signature: '0x', from: intent.safe,
    };
    const os = await barn('order', { order });
    if (os.status !== 201) throw new Error('order: ' + JSON.stringify(os.body));
    setStatus(label + ' — waiting for a solver…');
    if (await pollFill(os.body as string, (s) => setStatus(label + ' (' + s + ')…')) !== 'fulfilled') throw new Error('order expired — no solver settled it. Try again.');
    return { uid: os.body as string };
  }

  // ── OPEN: carrier order (one signature, gasless) → solver deploys Safe + opens ──
  async function doOpen() {
    if (!walletClient || !publicClient || !address || !openAmts) return;
    setBusy(true); setErr(null); setStatus('Quoting…');
    try {
      const validTo = Math.floor(Date.now() / 1000) + 3600;
      const q = previewBuy ?? await quoteOut((sell as UIToken).address, buy.address, openAmts.flash, address);
      if (!q) throw new Error('quote failed');
      const buyMin = minOut(q, slippagePct);
      const nonce = BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join(''));
      const intent: Intent = { owner: address, equity, flash: openAmts.flash, buyMin, borrow: openAmts.borrow, repay: openAmts.repay, validTo, nonce };

      setStatus('Deriving your Safe + order on-chain…');
      const safeAddr = await publicClient.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'safeOf', args: [intent] }) as Address;
      const [levJson, levHash] = await publicClient.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'appData', args: [intent, safeAddr] }) as [string, `0x${string}`];
      const levUid = await publicClient.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'uid', args: [intent, safeAddr] }) as `0x${string}`;

      // one-time vault-relayer allowance for the carrier order
      const sellAmt = (equity * 105n) / 100n; // sell a touch more so the Safe nets >= equity after fee
      const allowance = await publicClient.readContract({ address: O.wxdai as Address, abi: ERC20_ABI, functionName: 'allowance', args: [address, O.relayer as Address] }) as bigint;
      if (allowance < sellAmt) {
        setStatus('One-time CoW approval (same as cowswap.exchange — never asked again)…');
        const h = await walletClient.writeContract({ address: O.wxdai as Address, abi: ERC20_ABI, functionName: 'approve', args: [O.relayer as Address, MAXU], chain: undefined, account: address });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }

      setStatus('Sign your leverage swap (your only signature)…');
      const bootstrapCalldata = encodeFunctionData({ abi: IB_ABI, functionName: 'bootstrap', args: [intent] });
      const { json: carrierJson, hash: carrierHash } = carrierAppData(bootstrapCalldata);
      const carrierOrder = {
        sellToken: O.wxdai, buyToken: O.wxdai, receiver: safeAddr, sellAmount: sellAmt.toString(),
        buyAmount: ((sellAmt * 96n) / 100n).toString(), validTo, appData: carrierHash, feeAmount: '0', kind: 'sell',
        partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
      };
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
      const lo = { sellToken: O.wxdai, buyToken: O.weth, receiver: safeAddr, sellAmount: openAmts.flash.toString(), buyAmount: buyMin.toString(), validTo, appData: levHash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', signingScheme: 'eip1271', signature: '0x', from: safeAddr };
      const ls = await barn('order', { order: lo });
      if (ls.status !== 201) throw new Error('leverage rejected: ' + JSON.stringify(ls.body));
      if (await pollFill(levUid, (s) => setStatus('Opening position (' + s + ')…')) !== 'fulfilled') throw new Error('leverage order expired — your Safe holds the equity; retry from the position list.');

      setStatus('✅ Position opened'); setAmount('1'); setLev(1); setShowLev(false);
      await loadPositions();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ── REDUCE / CLOSE (pct of position) via LevManagerModule ──
  async function doReduce(pct: number) {
    if (!walletClient || !publicClient || !address || !sellIsPos) return;
    const p = sell as LivePos;
    setBusy(true); setErr(null); setStatus('Quoting…');
    try {
      const full = pct >= 100;
      const sellAmount = full ? p.collQty : (p.collQty * BigInt(pct)) / 100n;
      const repayAmount = full ? MAXU : (p.debtQty * BigInt(pct)) / 100n;
      const flash = ((full ? p.debtQty : repayAmount) * 103n) / 100n;
      const q = await quoteOut(O.weth as Address, O.wxdai as Address, sellAmount, p.safe);
      if (!q) throw new Error('quote failed');
      const minBuy = minOut(q, Math.max(slippagePct, 2));
      const validTo = Math.floor(Date.now() / 1000) + 1800;
      const intent = {
        safe: getAddress(p.safe), nonce: BigInt(Math.floor(Date.now() / 1000)), deadline: BigInt(validTo + 1800), mode: 0n,
        collateral: O.weth, debt: O.wxdai, sellAmount, repayAmount, minBuy, flash, orderValidTo: BigInt(validTo), minHealthFactor: 0n,
      };
      await relayRetarget(intent, full ? 'Closing position' : `Reducing ${pct}%`);
      setStatus(full ? '✅ Position closed' : `✅ Reduced ${pct}%`);
      if (full) { setSell(WXDAI); setAmount('1'); }
      await loadPositions();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ── ADJUST LEVERAGE (target) via LevManagerModule: INCREASE up / REDUCE down ──
  async function doAdjust(target: number) {
    if (!walletClient || !publicClient || !address || !sellIsPos) return;
    const p = sell as LivePos;
    const cur = p.m.leverage;
    if (Math.abs(target - cur) < 0.05) { setErr('Target leverage unchanged'); return; }
    setBusy(true); setErr(null); setStatus('Quoting…');
    try {
      const equityWxdai = Math.max(p.m.equityUsd, 0); // WXDAI ≈ $1
      const price = p.collQty > 0n ? p.m.collateralUsd / Number(formatUnits(p.collQty, WETH.decimals)) : 0;
      if (price <= 0) throw new Error('no price');
      const validTo = Math.floor(Date.now() / 1000) + 1800;
      const deltaValue = Math.abs(target - cur) * equityWxdai; // WXDAI value to move
      if (target > cur) {
        // INCREASE: borrow Δ WXDAI, buy WETH, supply it
        const sellAmount = floatToWei(deltaValue);
        const cap = (p.availBase * (10n ** 10n) * 90n) / 100n; // availableBorrowsBase (8dec) → WXDAI, 90%
        if (sellAmount > cap) throw new Error('exceeds Aave borrow capacity at that leverage');
        const q = await quoteOut(O.wxdai as Address, O.weth as Address, sellAmount, p.safe);
        if (!q) throw new Error('quote failed');
        const minBuy = minOut(q, Math.max(slippagePct, 2));
        const intent = {
          safe: getAddress(p.safe), nonce: BigInt(Math.floor(Date.now() / 1000)), deadline: BigInt(validTo + 1800), mode: 1n,
          collateral: O.weth, debt: O.wxdai, sellAmount, repayAmount: 0n, minBuy, flash: 0n, orderValidTo: BigInt(validTo), minHealthFactor: 1050000000000000000n,
        };
        await relayRetarget(intent, `Increasing to ${target.toFixed(1)}x`);
      } else {
        // DECREASE: sell Δ-worth WETH (overshoot so guaranteed minBuy still covers flash+premium),
        // repay Δ WXDAI debt. Any surplus WXDAI stays in the Safe (small equity bump).
        const repayAmount = floatToWei(deltaValue);
        const sellAmount = floatToWei((deltaValue / price) * 1.05); // 5% extra collateral
        const flash = (repayAmount * 103n) / 100n;
        const q = await quoteOut(O.weth as Address, O.wxdai as Address, sellAmount, p.safe);
        if (!q) throw new Error('quote failed');
        const minBuy = minOut(q, Math.max(slippagePct, 2));
        const intent = {
          safe: getAddress(p.safe), nonce: BigInt(Math.floor(Date.now() / 1000)), deadline: BigInt(validTo + 1800), mode: 0n,
          collateral: O.weth, debt: O.wxdai, sellAmount, repayAmount, minBuy, flash, orderValidTo: BigInt(validTo), minHealthFactor: 0n,
        };
        await relayRetarget(intent, `Decreasing to ${target.toFixed(1)}x`);
      }
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
  const supportedOpen = !sellIsPos && (sell as UIToken).kind === 'debt' && buy.kind === 'collateral';
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
  else if (lev > 1 && equity > 0n) ctaLabel = supportedOpen ? (insufficient ? 'Insufficient balance' : `Open ${lev}× Long`) : 'Unsupported pair (sell WXDAI, buy WETH)';
  else if (equity > 0n) ctaLabel = samePair ? 'Select two different tokens' : insufficient ? 'Insufficient balance' : 'Swap';
  const ctaDisabled = busy || !isConnected || !onGnosis
    || (sellIsPos ? (posMode === 'leverage' ? Math.abs(lev - (sell as LivePos).m.leverage) < 0.05 && lev > 1.01 : false)
                  : !(equity > 0n && !insufficient && !samePair && (lev <= 1 || supportedOpen)));

  // ── render ──
  const allowed: UIToken[] = sellIsPos
    ? TOKENS.filter((t) => [O.weth, O.wxdai].some((a) => a.toLowerCase() === t.address.toLowerCase()))
    : selSide === 'sell' ? TOKENS.filter((t) => t.kind === 'debt') : TOKENS.filter((t) => t.kind === 'collateral');
  const filtered = allowed.filter((t) => !search || t.symbol.toLowerCase().includes(search.toLowerCase()) || t.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="lev-root">
      <div className="lev-hd">
        <div className="brand">🐮 CoW Leverage</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <a href="https://koeppelmann.dev" className="nav"><span>← home</span></a>
          <button className="lev-gear" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
          <ConnectButton />
        </div>
      </div>

      <div className="lev-wrap">
        <div className="lev-cardtop">
          <div className="lev-pill"><button className="on">Swap</button><button title="Coming soon">Limit</button></div>
        </div>

        <div className="lev-card">
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
                <input className="lev-range" type="range" min={1} max={5} step={0.1} value={lev} onChange={(e) => setLev(parseFloat(e.target.value))} />
                <div className="lev-stat" style={{ marginTop: 4 }}><span className="k">1.0x</span><span className="k">5.0x</span></div>
              </>
            ) : (
              <>
                <div className="lbl"><span>{sellIsPos ? 'Reduce by' : 'Sell'}</span><span>{sellIsPos ? `Collat ${Number(formatUnits((sell as LivePos).collQty, WETH.decimals)).toFixed(4)} WETH` : bal != null ? `Balance ${Number(formatUnits(bal, (sell as UIToken).decimals)).toFixed(4)}` : ''}</span></div>
                <div className="lev-amtrow">
                  <input className="lev-amt" value={amount} inputMode="decimal" placeholder="0" onChange={(e) => { if (sellIsPos) { const v = parseFloat(e.target.value); setAmount(v > 100 ? '100' : e.target.value); } else setAmount(e.target.value); }} />
                  {sellIsPos && <span style={{ fontSize: 28, color: 'var(--lev-muted)' }}>%</span>}
                  <button className="lev-tok" onClick={() => openSelect('sell')}>
                    {sellIsPos ? <span className="ph"><TokenIcon chainId={100} address={O.weth as Address} symbol="WETH" /></span> : <TokenIcon chainId={100} address={(sell as UIToken).address} symbol={(sell as UIToken).symbol} />}
                    {sellIsPos ? `WETH ${(sell as LivePos).m.leverage.toFixed(1)}x` : (sell as UIToken).symbol} ▾
                  </button>
                </div>
                {sellIsPos && <div className="lev-chips">{['25', '50', '75', '100'].map((v) => <button key={v} onClick={() => setAmount(v)}>{v === '100' ? 'Max' : v + '%'}</button>)}</div>}
                {!sellIsPos && bal != null && (
                  <div className="lev-chips">{['25', '50', '75', '100'].map((pc) => <button key={pc} onClick={() => setAmount(formatUnits((bal * BigInt(pc)) / 100n, (sell as UIToken).decimals))}>{pc === '100' ? 'Max' : pc + '%'}</button>)}</div>
                )}
              </>
            )}
          </div>

          <div className="lev-flip"><button onClick={() => { if (!sellIsPos && buy.kind === 'debt') { const s = sell as UIToken; setSell(buy); setBuy(s); } }}>↓</button></div>

          {/* BUY */}
          <div className="lev-panel">
            <div className="lbl">
              <span>{sellIsPos ? (posMode === 'leverage' ? 'New position' : 'Receive') : 'Buy'}</span>
              {!sellIsPos && (
                <button className={`lev-levbadge ${lev > 1 ? 'on' : 'off'}`} onClick={() => { setShowLev((v) => !v); if (lev === 1) setLev(2); }}>↗ {lev > 1 ? `${lev}x Leverage` : 'Add Leverage'}</button>
              )}
            </div>
            {showLev && !sellIsPos && (
              <div className="lev-levbox">
                <div className="top"><span>Leverage</span><b>{lev.toFixed(1)}x</b></div>
                <input className="lev-range" type="range" min={1} max={5} step={0.1} value={lev} onChange={(e) => setLev(parseFloat(e.target.value))} />
                <div className="lev-stat" style={{ marginTop: 4 }}><span className="k">1.0x</span><span className="k">5.0x</span></div>
              </div>
            )}
            <div className="lev-amtrow">
              <input className="lev-amt" style={{ color: 'var(--lev-pri)' }} readOnly value={
                sellIsPos
                  ? (posMode === 'close' ? (previewReduce != null ? Number(formatUnits(previewReduce, WXDAI.decimals)).toFixed(2) : '') : '')
                  : (lev > 1 && previewBuy ? Number(formatUnits(previewBuy, buy.decimals)).toFixed(5) : '0')
              } placeholder="0" />
              <button className="lev-tok" onClick={() => openSelect('buy')}><TokenIcon chainId={100} address={buy.address} symbol={buy.symbol} /> {buy.symbol} ▾</button>
            </div>
            {!sellIsPos && lev > 1 && openAmts && (
              <div style={{ marginTop: 10 }}>
                <div className="lev-stat"><span className="k">Debt (Aave V3)</span><span className="v" style={{ color: '#ffa53b' }}>{Number(formatUnits(openAmts.borrow, (sell as UIToken).decimals)).toFixed(4)} {(sell as UIToken).symbol}</span></div>
                <div className="lev-stat"><span className="k">Est. health factor</span><span className="v" style={{ color: estHF && estHF > 1.4 ? '#46d39a' : '#ffa53b' }}>{estHF ? estHF.toFixed(2) : '—'}</span></div>
                {estLiqPrice && <div className="lev-stat"><span className="k">Deleverage price</span><span className="v" style={{ color: '#ff8e8e' }}>{estLiqPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })} WXDAI</span></div>}
              </div>
            )}
          </div>

          {sellIsPos && posMode === 'leverage' && (
            <div className="lev-detail" style={{ margin: 4 }}>
              <div className="lev-stat"><span className="k">Leverage</span><span className="v"><span style={{ textDecoration: 'line-through', opacity: .5, marginRight: 6 }}>{(sell as LivePos).m.leverage.toFixed(2)}x</span><span style={{ color: lev < (sell as LivePos).m.leverage ? '#46d39a' : '#ffa53b' }}>{lev.toFixed(1)}x</span></span></div>
              <div className="lev-stat"><span className="k">Health factor</span><span className="v">{(sell as LivePos).m.healthFactor > 100 ? '∞' : (sell as LivePos).m.healthFactor.toFixed(2)}</span></div>
              {(sell as LivePos).m.liqPrice && <div className="lev-stat"><span className="k">Liquidation price</span><span className="v">{(sell as LivePos).m.liqPrice!.toLocaleString(undefined, { maximumFractionDigits: 0 })} WXDAI</span></div>}
            </div>
          )}

          {!sellIsPos && lev > 1 && entryPrice && (
            <div className="lev-rate">1 WETH = {entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} WXDAI · slippage {slippagePct}%</div>
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
                    <span className="l"><span className="ph"><TokenIcon chainId={100} address={O.weth as Address} symbol="WETH" /></span>
                      <span><span className="sym">WETH <span className="lev-tag">{p.m.leverage.toFixed(1)}x</span></span>
                        <span style={{ fontSize: 12, color: 'var(--lev-muted)', display: 'block' }}>Collat {Number(formatUnits(p.collQty, WETH.decimals)).toFixed(4)} · Debt {Number(formatUnits(p.debtQty, WXDAI.decimals)).toFixed(2)} WXDAI</span></span></span>
                    <span className="r"><span style={{ fontSize: 12, color: 'var(--lev-muted)' }}>Liq {p.m.liqPrice ? p.m.liqPrice.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</span>
                      <span style={{ fontSize: 11, display: 'block', color: (p.m.dropToLiqPct ?? 99) < 8 ? '#ff6b6b' : (p.m.dropToLiqPct ?? 99) < 15 ? '#ffa53b' : 'var(--lev-muted)' }}>{p.m.dropToLiqPct != null ? `-${p.m.dropToLiqPct.toFixed(1)}% to liq` : ''}</span></span>
                  </button>
                ))}
                <div className="lev-divider" />
              </>
            )}
            <div className="lev-secttl">Tokens</div>
            {filtered.map((t) => (
              <button key={t.address} className="lev-trow" onClick={() => pickToken(t)}>
                <span className="l"><TokenIcon chainId={100} address={t.address} symbol={t.symbol} /><span className="sym">{t.symbol} <span style={{ fontSize: 11, color: 'var(--lev-muted)', fontWeight: 400 }}>{t.name}</span></span></span>
              </button>
            ))}
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
