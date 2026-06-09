'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatUnits, parseUnits, type Address } from 'viem';
import { gnosis } from 'wagmi/chains';
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { ConnectButton } from '../../components/ConnectButton';
import { TokenIcon } from '../../components/TokenIcon';
import { erc20Abi } from '../../lib/abi';
import { shortAddress } from '../../lib/format';
import {
  GNOSIS, SAFE, LEV_COLLATERAL_TOKENS, LEV_DEBT_TOKENS,
  buildSafeInitializer, predictPositionSafe,
  buildLeverageOrder, buildReduceOrder, safeMessageTypedData,
  computeAmounts, computeIncrease, computeDecrease, computeReduce, positionMetrics,
  type PositionMetrics,
} from '../../lib/leverage';

// ---------- token universe ----------
type UIToken = { address: Address; symbol: string; decimals: number; kind: 'debt' | 'collateral' };
const TOKENS: UIToken[] = [
  ...LEV_DEBT_TOKENS.map((t) => ({ ...t, kind: 'debt' as const })),
  ...LEV_COLLATERAL_TOKENS.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals, kind: 'collateral' as const })),
];
const tokBy = (a: string) => TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase());
const collMeta = (a: string) => LEV_COLLATERAL_TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase());

type SavedPos = { safe: Address; debt: { a: Address; s: string; d: number }; coll: { a: Address; s: string; d: number }; ts: number; mod?: Address };
type LivePos = SavedPos & { m: PositionMetrics; collQty: bigint; debtQty: bigint };

const factoryAbi = [{ type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bytes' }, { type: 'uint256' }], outputs: [{ type: 'address' }] }] as const;
const poolAbi = [
  { type: 'function', name: 'getUserAccountData', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
  { type: 'function', name: 'getReserveData', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint40' }, { type: 'uint16' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }] },
] as const;

async function quote(sellToken: Address, buyToken: Address, sellAmount: bigint): Promise<bigint | null> {
  try {
    const j = await (await fetch('/api/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 100, sellToken, buyToken, from: '0x0000000000000000000000000000000000000001', sellAmount: sellAmount.toString() }) })).json();
    return j?.buyAmount ? BigInt(j.buyAmount) : null;
  } catch { return null; }
}
async function cow(action: object) { return (await fetch('/api/cow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })).json(); }
async function postOrder(o: { appDataHash: string; appData: string }) {
  await cow({ chainId: 100, kind: 'appData', appDataHash: o.appDataHash, fullAppData: o.appData });
  const pr = await cow({ chainId: 100, kind: 'order', order: o });
  if (!pr?.ok || !pr?.uid) throw new Error('order rejected: ' + (pr?.raw || pr?.error || 'unknown'));
  return pr.uid as string;
}
async function pollFill(uid: string, onTick?: (s: string) => void): Promise<'fulfilled' | 'expired'> {
  for (let i = 0; i < 60; i++) {
    const o = await (await fetch(`https://api.cow.fi/xdai/api/v1/orders/${uid}`)).json().catch(() => ({}));
    onTick?.(o.status);
    if (o.status === 'fulfilled') return 'fulfilled';
    if (o.status === 'expired' || o.status === 'cancelled') return 'expired';
    await new Promise((r) => setTimeout(r, 4000));
  }
  return 'expired';
}

export default function LeveragePage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: gnosis.id });
  const onGnosis = chainId === gnosis.id;

  // sell side is a token or a position; buy side is always a token
  const [sell, setSell] = useState<UIToken | LivePos>(TOKENS[0]); // WXDAI
  const [buy, setBuy] = useState<UIToken>(TOKENS.find((t) => t.kind === 'collateral')!); // WETH
  const [amount, setAmount] = useState('1');           // pay amount OR percent (positions)
  const [lev, setLev] = useState(1);                   // 1..5
  const [showLev, setShowLev] = useState(false);
  const [posMode, setPosMode] = useState<'close' | 'leverage'>('close');
  const isPos = (x: UIToken | LivePos): x is LivePos => 'safe' in x;
  const sellIsPos = isPos(sell);

  // dialogs
  const [selOpen, setSelOpen] = useState(false);
  const [selSide, setSelSide] = useState<'sell' | 'buy'>('sell');
  const [search, setSearch] = useState('');

  // data
  const [positions, setPositions] = useState<LivePos[]>([]);
  const [bal, setBal] = useState<bigint | null>(null);
  const [previewBuy, setPreviewBuy] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ---------- load positions (localStorage + live Aave reads) ----------
  const loadPositions = useCallback(async () => {
    if (!publicClient) return;
    let saved: SavedPos[] = [];
    try { saved = JSON.parse(localStorage.getItem('lev_safe_positions') || '[]'); } catch {}
    const live: LivePos[] = [];
    for (const s of saved) {
      try {
        const acct = await publicClient.readContract({ address: GNOSIS.aavePool, abi: poolAbi, functionName: 'getUserAccountData', args: [s.safe] }) as readonly bigint[];
        if (acct[0] === 0n && acct[1] === 0n) continue; // closed
        const rc = await publicClient.readContract({ address: GNOSIS.aavePool, abi: poolAbi, functionName: 'getReserveData', args: [s.coll.a] }) as readonly unknown[];
        const rd = await publicClient.readContract({ address: GNOSIS.aavePool, abi: poolAbi, functionName: 'getReserveData', args: [s.debt.a] }) as readonly unknown[];
        const collQty = await publicClient.readContract({ address: rc[8] as Address, abi: erc20Abi, functionName: 'balanceOf', args: [s.safe] }) as bigint;
        const debtQty = await publicClient.readContract({ address: rd[10] as Address, abi: erc20Abi, functionName: 'balanceOf', args: [s.safe] }) as bigint;
        const collQtyF = Number(formatUnits(collQty, s.coll.d));
        const m = positionMetrics({ collateralBase: acct[0], debtBase: acct[1], liqThresholdBps: Number(acct[3]), healthFactor1e18: acct[5], collateralQty: collQtyF, collateralPriceUsd: collQtyF > 0 ? (Number(acct[0]) / 1e8) / collQtyF : 0 });
        live.push({ ...s, m, collQty, debtQty });
      } catch { /* skip */ }
    }
    setPositions(live);
  }, [publicClient]);
  useEffect(() => { loadPositions(); }, [loadPositions]);

  // wallet balance of the sell token (only for plain-token sell)
  useEffect(() => {
    if (!address || !publicClient || sellIsPos) { setBal(null); return; }
    publicClient.readContract({ address: (sell as UIToken).address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }).then((b) => setBal(b as bigint)).catch(() => setBal(null));
  }, [address, publicClient, sell, sellIsPos]);

  // ---------- derived ----------
  const equity = useMemo(() => { if (sellIsPos) return 0n; try { return parseUnits(amount || '0', (sell as UIToken).decimals); } catch { return 0n; } }, [amount, sell, sellIsPos]);
  const openAmts = useMemo(() => (sellIsPos ? null : computeAmounts(equity, lev)), [equity, lev, sellIsPos]);
  const insufficient = bal != null && !sellIsPos && equity > bal;

  // preview quote for OPEN (sell debt -> collateral, leveraged)
  useEffect(() => {
    setPreviewBuy(null);
    if (sellIsPos || lev <= 1 || !openAmts || openAmts.loan === 0n) return;
    let live = true;
    quote((sell as UIToken).address, buy.address, openAmts.loan).then((q) => { if (live) setPreviewBuy(q); });
    return () => { live = false; };
  }, [sellIsPos, lev, openAmts, sell, buy]);

  const estHF = useMemo(() => {
    if (sellIsPos || !openAmts || lev <= 1 || openAmts.borrow === 0n) return null;
    const dec = (sell as UIToken).decimals;
    return (Number(formatUnits(openAmts.loan, dec)) * ((collMeta(buy.address)?.liqThresholdBps ?? 8000) / 10000)) / Number(formatUnits(openAmts.borrow, dec));
  }, [sellIsPos, openAmts, lev, sell, buy]);

  // ---------- token selector ----------
  function openSelect(side: 'sell' | 'buy') { setSelSide(side); setSearch(''); setSelOpen(true); }
  function pickToken(t: UIToken) {
    if (selSide === 'sell') { setSell(t); setLev(1); setShowLev(false); setAmount('1'); }
    else setBuy(t);
    setSelOpen(false);
  }
  function pickPosition(p: LivePos) { setSell(p); setPosMode('close'); setAmount('100'); setBuy(tokBy(p.debt.a) || buy); setSelOpen(false); }

  // ---------- actions ----------
  function saveSafe(s: SavedPos) { try { const a = JSON.parse(localStorage.getItem('lev_safe_positions') || '[]'); a.unshift(s); localStorage.setItem('lev_safe_positions', JSON.stringify(a.slice(0, 30))); } catch {} }
  // Version-aware signing: v3 modules require the Safe-bound SafeMessage (replay-safe); legacy v2
  // positions (no `mod` recorded) used the raw order digest.
  async function signFor(order: { typedData: unknown; digest: `0x${string}`; orderBody: Record<string, unknown> }, safe: Address, mod?: Address) {
    const v3 = (mod ?? SAFE.levModuleV2).toLowerCase() === SAFE.levModule.toLowerCase();
    const td = v3 ? safeMessageTypedData(safe, order.digest) : order.typedData;
    const sig = await walletClient!.signTypedData(td as Parameters<NonNullable<typeof walletClient>['signTypedData']>[0]);
    (order.orderBody as { signature: string }).signature = sig;
  }

  async function doOpen() {
    if (!walletClient || !publicClient || !address || !openAmts) return;
    const sellTok = sell as UIToken, buyTok = buy;
    setBusy(true); setErr(null); setStatus('Creating your Safe…');
    try {
      const saltNonce = BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
      const initializer = buildSafeInitializer(address, sellTok.address);
      const safe = predictPositionSafe(initializer, saltNonce);
      const dh = await walletClient.writeContract({ address: SAFE.factory, abi: factoryAbi, functionName: 'createProxyWithNonce', args: [SAFE.singleton, initializer, saltNonce] });
      if ((await publicClient.waitForTransactionReceipt({ hash: dh })).status !== 'success') throw new Error('Safe deploy failed');
      setStatus('Funding equity…');
      const fh = await walletClient.writeContract({ address: sellTok.address, abi: erc20Abi, functionName: 'transfer', args: [safe, equity] });
      if ((await publicClient.waitForTransactionReceipt({ hash: fh })).status !== 'success') throw new Error('funding failed');
      setStatus('Sign the leverage order…');
      const q = (await quote(sellTok.address, buyTok.address, openAmts.loan)) ?? previewBuy;
      if (!q) throw new Error('quote failed');
      const validTo = Math.floor(Date.now() / 1000) + 180;
      const order = buildLeverageOrder({ safe, debtToken: sellTok.address, collateral: buyTok.address, loan: openAmts.loan, buyAmountMin: (q * 99n) / 100n, borrow: openAmts.borrow, repayApprove: openAmts.repayApprove, validTo });
      await signFor(order, safe, SAFE.levModule);
      setStatus('Opening position (waiting for a solver)…');
      const uid = await postOrder(order.orderBody as { appDataHash: string; appData: string });
      saveSafe({ safe, debt: { a: sellTok.address, s: sellTok.symbol, d: sellTok.decimals }, coll: { a: buyTok.address, s: buyTok.symbol, d: buyTok.decimals }, ts: Date.now(), mod: SAFE.levModule });
      const res = await pollFill(uid, (s) => setStatus('Position order ' + (s || 'open') + '…'));
      if (res !== 'fulfilled') throw new Error('order expired — no solver settled it. Equity is safe in your Safe; try again.');
      setStatus('✅ Position opened'); setAmount('1'); setLev(1); setShowLev(false);
      await loadPositions();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  async function doReduce(fractionBps: bigint, payout: 'debt' | 'collateral') {
    if (!walletClient || !publicClient || !address || !sellIsPos) return;
    const p = sell as LivePos;
    setBusy(true); setErr(null); setStatus('Building close order…');
    try {
      const r = computeReduce({ collateralQty: p.collQty, debtQty: p.debtQty, fractionBps });
      const quoteOut = payout === 'debt' ? (await quote(p.coll.a, p.debt.a, r.sellCollateral)) ?? 0n : 0n;
      if (payout === 'debt' && quoteOut === 0n) throw new Error('quote failed');
      const validTo = Math.floor(Date.now() / 1000) + 180;
      const order = buildReduceOrder({ safe: p.safe, collateral: p.coll.a, debtToken: p.debt.a, repayAmount: r.repayAmount, withdrawAmount: r.withdrawAmount, sellCollateral: r.sellCollateral, loan: r.loan, premium: r.premium, repayApprove: r.repayApprove, validTo, payout, quoteOut });
      await signFor(order, p.safe, p.mod); setStatus('Submitting (waiting for a solver)…');
      const uid = await postOrder(order.orderBody as { appDataHash: string; appData: string });
      const res = await pollFill(uid, (s) => setStatus('Close order ' + (s || 'open') + '…'));
      if (res !== 'fulfilled') throw new Error('order expired — try again.');
      setStatus('✅ Position ' + (fractionBps >= 10000n ? 'closed' : 'reduced')); setSell(TOKENS[0]); setAmount('1');
      await loadPositions();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  async function doAdjust(target: number) {
    if (!walletClient || !publicClient || !address || !sellIsPos) return;
    const p = sell as LivePos;
    const cur = p.m.leverage;
    setBusy(true); setErr(null);
    try {
      const debtDec = p.debt.d, collDec = p.coll.d;
      const equityValueDebt = BigInt(Math.floor(p.m.equityUsd * 10 ** debtDec));
      const price = p.collQty > 0n ? p.m.collateralUsd / Number(formatUnits(p.collQty, collDec)) : 0;
      const validTo = Math.floor(Date.now() / 1000) + 180;
      if (target > cur + 0.01) {
        setStatus('Increasing leverage…');
        const inc = computeIncrease({ equityValueDebt, currentLevX1000: BigInt(Math.round(cur * 1000)), targetLevX1000: BigInt(Math.round(target * 1000)), price, collDecimals: collDec, debtDecimals: debtDec });
        const order = buildLeverageOrder({ safe: p.safe, debtToken: p.debt.a, collateral: p.coll.a, loan: inc.loan, buyAmountMin: inc.buyAmountMin, borrow: inc.borrow, repayApprove: inc.repayApprove, validTo });
        await signFor(order, p.safe, p.mod); setStatus('Submitting (waiting for a solver)…');
        const uid = await postOrder(order.orderBody as { appDataHash: string; appData: string });
        if (await pollFill(uid, (s) => setStatus('Increase ' + (s || 'open') + '…')) !== 'fulfilled') throw new Error('order expired — try again.');
      } else if (target < cur - 0.01) {
        setStatus('Decreasing leverage…');
        const dec = computeDecrease({ equityValueDebt, currentLevX1000: BigInt(Math.round(cur * 1000)), targetLevX1000: BigInt(Math.round(target * 1000)), price, collDecimals: collDec, debtDecimals: debtDec });
        const quoteOut = (await quote(p.coll.a, p.debt.a, dec.sellCollateral)) ?? 0n;
        const order = buildReduceOrder({ safe: p.safe, collateral: p.coll.a, debtToken: p.debt.a, repayAmount: dec.repayAmount, withdrawAmount: dec.withdrawAmount, sellCollateral: dec.sellCollateral, loan: dec.loan, premium: dec.premium, repayApprove: dec.repayApprove, validTo, payout: 'debt', quoteOut });
        await signFor(order, p.safe, p.mod); setStatus('Submitting (waiting for a solver)…');
        const uid = await postOrder(order.orderBody as { appDataHash: string; appData: string });
        if (await pollFill(uid, (s) => setStatus('Decrease ' + (s || 'open') + '…')) !== 'fulfilled') throw new Error('order expired — try again.');
      }
      setStatus('✅ Leverage adjusted'); setSell(TOKENS[0]); setAmount('1');
      await loadPositions();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ---------- CTA dispatch ----------
  const supportedOpen = !sellIsPos && (sell as UIToken).kind === 'debt' && buy.kind === 'collateral';
  function onCta() {
    if (!isConnected) return;
    if (!onGnosis) { switchChain({ chainId: gnosis.id }); return; }
    if (sellIsPos) {
      if (posMode === 'leverage') doAdjust(lev);
      else { const f = BigInt(Math.round(Math.min(100, Math.max(0, parseFloat(amount) || 0)) * 100)); doReduce(f, buy.kind === 'collateral' ? 'collateral' : 'debt'); }
    } else if (lev > 1) doOpen();
  }
  let ctaLabel = 'Enter an amount';
  if (sellIsPos && posMode === 'leverage') { const c = (sell as LivePos).m.leverage; ctaLabel = lev <= 1.01 ? 'Close Position' : lev > c + 0.01 ? 'Increase Leverage' : lev < c - 0.01 ? 'Decrease Leverage' : 'Adjust Leverage'; }
  else if (sellIsPos) ctaLabel = parseFloat(amount) >= 100 ? `Close Position` : `Reduce ${parseFloat(amount) || 0}%`;
  else if (lev > 1 && equity > 0n) ctaLabel = supportedOpen ? `Open ${lev}× Long` : 'Unsupported pair (sell a stable, buy ETH/wstETH)';
  else if (equity > 0n) ctaLabel = 'Set leverage above 1× to open';
  const ctaDisabled = busy || !isConnected || !onGnosis || (sellIsPos ? false : !(lev > 1 && supportedOpen && equity > 0n && !insufficient));

  // ---------- render ----------
  // Restrict the selector to valid tokens: when managing a position, only its two tokens; when
  // opening, the sell must be a stable (debt) and the buy must be a long asset (collateral).
  const allowed: UIToken[] = sellIsPos
    ? TOKENS.filter((t) => [(sell as LivePos).coll.a, (sell as LivePos).debt.a].some((a) => a.toLowerCase() === t.address.toLowerCase()))
    : selSide === 'sell' ? TOKENS.filter((t) => t.kind === 'debt') : TOKENS.filter((t) => t.kind === 'collateral');
  const filtered = allowed.filter((t) => !search || t.symbol.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="lev-root">
      <div className="lev-hd">
        <div className="brand">🐮 CoW Leverage</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <a href="https://koeppelmann.dev" className="nav"><span>← home</span></a>
          <ConnectButton />
        </div>
      </div>

      <div className="lev-wrap">
        <div className="lev-cardtop">
          <div className="lev-pill"><button className="on">Swap</button><button>Limit</button></div>
        </div>

        <div className="lev-card">
          {/* SELL */}
          <div className="lev-panel">
            {sellIsPos && (
              <div className="lev-pill" style={{ marginBottom: 12 }}>
                <button className={posMode === 'close' ? 'on' : ''} onClick={() => { setPosMode('close'); setAmount('100'); }}>Swap</button>
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
                <div className="lbl"><span>{sellIsPos ? 'Reduce by' : 'Sell'}</span><span>{sellIsPos ? `Collat ${Number(formatUnits((sell as LivePos).collQty, (sell as LivePos).coll.d)).toFixed(4)}` : bal != null ? `Balance ${Number(formatUnits(bal, (sell as UIToken).decimals)).toFixed(4)}` : ''}</span></div>
                <div className="lev-amtrow">
                  <input className="lev-amt" value={amount} inputMode="decimal" placeholder="0" onChange={(e) => { if (sellIsPos) { const v = parseFloat(e.target.value); setAmount(v > 100 ? '100' : e.target.value); } else setAmount(e.target.value); }} />
                  {sellIsPos && <span style={{ fontSize: 28, color: 'var(--lev-muted)' }}>%</span>}
                  <button className="lev-tok" onClick={() => openSelect('sell')}>
                    {sellIsPos ? <span className="ph"><TokenIcon chainId={100} address={(sell as LivePos).coll.a} symbol={(sell as LivePos).coll.s} /></span> : <TokenIcon chainId={100} address={(sell as UIToken).address} symbol={(sell as UIToken).symbol} />}
                    {sellIsPos ? `${(sell as LivePos).coll.s} ${(sell as LivePos).m.leverage.toFixed(1)}x` : (sell as UIToken).symbol} ▾
                  </button>
                </div>
                {sellIsPos && <div className="lev-chips">{['25', '50', '75', '100'].map((v) => <button key={v} onClick={() => setAmount(v)}>{v === '100' ? 'Max' : v + '%'}</button>)}</div>}
              </>
            )}
          </div>

          <div className="lev-flip"><button onClick={() => { if (!sellIsPos && buy.kind === 'debt') { const s = sell as UIToken; setSell(buy); setBuy(s); } }}>↓</button></div>

          {/* BUY */}
          <div className="lev-panel">
            <div className="lbl">
              <span>{sellIsPos ? 'Receive' : 'Buy'}</span>
              {!sellIsPos && (
                <button className={`lev-levbadge ${lev > 1 ? 'on' : 'off'}`} onClick={() => { setShowLev((v) => !v); if (lev === 1) setLev(2); }}>↗ {lev > 1 ? `${lev}x Leverage` : 'Add Leverage'}</button>
              )}
            </div>
            {showLev && !sellIsPos && (
              <div className="lev-levbox">
                <div className="top"><span>Leverage</span><b>{lev.toFixed(1)}x</b></div>
                <input className="lev-range" type="range" min={1} max={5} step={0.1} value={lev} onChange={(e) => setLev(parseFloat(e.target.value))} />
              </div>
            )}
            <div className="lev-amtrow">
              <input className="lev-amt" style={{ color: 'var(--lev-pri)' }} readOnly value={
                sellIsPos ? '' : (lev > 1 && previewBuy ? Number(formatUnits(previewBuy, buy.decimals)).toFixed(5) : '0')
              } placeholder="0" />
              <button className="lev-tok" onClick={() => openSelect('buy')}><TokenIcon chainId={100} address={buy.address} symbol={buy.symbol} /> {buy.symbol} ▾</button>
            </div>
            {!sellIsPos && lev > 1 && openAmts && (
              <div style={{ marginTop: 10 }}>
                <div className="lev-stat"><span className="k">Debt (Aave V3)</span><span className="v">{Number(formatUnits(openAmts.borrow, (sell as UIToken).decimals)).toFixed(4)} {(sell as UIToken).symbol}</span></div>
                <div className="lev-stat"><span className="k">Est. health factor</span><span className="v" style={{ color: estHF && estHF > 1.3 ? '#46d39a' : '#ffa53b' }}>{estHF ? estHF.toFixed(2) : '—'}</span></div>
              </div>
            )}
          </div>

          {sellIsPos && posMode === 'leverage' && (
            <div className="lev-detail" style={{ margin: 4 }}>
              <div className="lev-stat"><span className="k">Leverage</span><span className="v"><span className="old" style={{ textDecoration: 'line-through', opacity: .5, marginRight: 6 }}>{(sell as LivePos).m.leverage.toFixed(2)}x</span><span style={{ color: lev < (sell as LivePos).m.leverage ? '#46d39a' : '#ffa53b' }}>{lev.toFixed(1)}x</span></span></div>
              <div className="lev-stat"><span className="k">Health factor</span><span className="v">{(sell as LivePos).m.healthFactor > 100 ? '∞' : (sell as LivePos).m.healthFactor.toFixed(2)}</span></div>
            </div>
          )}

          <button className={`lev-cta ${ctaLabel.includes('Increase') ? 'warn' : ctaLabel.includes('Close') ? 'danger' : ''}`} disabled={ctaDisabled} onClick={onCta}>{busy ? 'Working…' : ctaLabel}</button>
          {!sellIsPos && lev > 1 && <div className="lev-foot">Leverage powered by Aave V3 · settled atomically by CoW Protocol</div>}
        </div>

        {status && <p className="lev-foot" style={{ color: status.startsWith('✅') ? '#46d39a' : 'var(--lev-muted)' }}>{status}</p>}
        {err && <p className="lev-foot" style={{ color: '#ff6b6b' }}>{err}</p>}
        {isConnected && !onGnosis && <p className="lev-foot">Switch to Gnosis to trade.</p>}
        <div className="lev-foot">CoW Protocol protects you from MEV · each position is its own Safe you own · <a href="/leverage/architecture">how it works ↗</a></div>
      </div>

      {/* token / position selector */}
      {selOpen && (
        <div className="lev-ov" onClick={() => setSelOpen(false)}>
          <div className="lev-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Select {selSide === 'sell' ? 'token to sell' : 'token to receive'}</h3>
            <input className="lev-search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
            {selSide === 'sell' && positions.length > 0 && (
              <>
                <div className="lev-secttl">Your positions</div>
                {positions.map((p) => (
                  <button key={p.safe} className="lev-trow pos" onClick={() => pickPosition(p)}>
                    <span className="l"><span className="ph"><TokenIcon chainId={100} address={p.coll.a} symbol={p.coll.s} /></span>
                      <span><span className="sym">{p.coll.s} <span className="lev-tag">{p.m.leverage.toFixed(1)}x</span></span>
                        <span style={{ fontSize: 12, color: 'var(--lev-muted)', display: 'block' }}>Collat {Number(formatUnits(p.collQty, p.coll.d)).toFixed(4)} · Debt {Number(formatUnits(p.debtQty, p.debt.d)).toFixed(2)} {p.debt.s}</span></span></span>
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
                <span className="l"><TokenIcon chainId={100} address={t.address} symbol={t.symbol} /><span className="sym">{t.symbol} <span style={{ fontSize: 11, color: 'var(--lev-muted)', fontWeight: 400 }}>{t.kind === 'collateral' ? 'long' : 'stable'}</span></span></span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
