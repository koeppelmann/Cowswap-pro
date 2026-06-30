'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { formatUnits, type Address, type PublicClient } from 'viem';
import { useAccount, useChainId, usePublicClient } from 'wagmi';
import { ConnectButton } from '../../components/ConnectButton';
import { ClaimButton } from '../../components/ClaimButton';
import { getChainConfig, type ChainConfig } from '../../lib/chains';
import { avgPrice, deriveState, fundedParts, isSettled, type OrderState } from '../../lib/orderState';
import { enrichOrders, fetchOwnerHistory, fetchSafeLegs, type HistoryOrder, type Leg, type SwapRow } from '../../lib/carrierHistory';
import { discoverLeverageCarriers, loadSavedSafes, positionPnl, readPositions, realizedReturn, type LevCarrier, type LivePos, type Market } from '../../lib/positions';
import { ONBOARD } from '../../lib/onboard';
import { dispAmount, fmtRate, humanizeSeconds, rateParts, shortAddress } from '../../lib/format';
import { useTokenList } from '../../lib/useTokenList';
import { useTokenMeta } from '../../lib/useTokenMeta';
import { useViewParam } from '../../lib/useViewMode';

type Resolved = { symbol: string; decimals: number };
type ResolveFn = (addr: string) => Resolved;

// "Moneyness" rank: $ > € > BTC > ETH > other tokens. Prices are quoted as
// more-money per less-money (e.g. EURe/COW, USDC/GNO, ETH/GNO) so that opposite
// directions of the same pair read in the SAME ratio. Higher = more money.
function moneyness(symbol: string): number {
  const s = symbol.toUpperCase();
  const USD = ['USDC', 'USDT', 'DAI', 'SDAI', 'USDC.E', 'CRVUSD', 'USDS', 'GYD', 'SGYD', 'USDM', 'GUSD', 'USDE'];
  if (USD.includes(s) || s.includes('USD')) return 5;
  if (s.includes('EUR') || ['GBPE', 'BRLA', 'JEUR', 'AGEUR'].includes(s)) return 4;
  if (s.includes('BTC')) return 3;
  if (s.includes('ETH')) return 2;
  return 1;
}
// Default orientation for an order vs fmtRate's canonical buy-per-sell: flip when
// the SELL token is more money than the BUY token (so we show more/less money).
function baseFlip(sellSym: string, buySym: string): boolean {
  return moneyness(sellSym) > moneyness(buySym);
}

const GROUPS: { key: string; title: string; states: OrderState[]; collapsed?: boolean }[] = [
  { key: 'active', title: 'In progress', states: ['active', 'partial', 'funding'] },
  { key: 'approved', title: 'Approved · awaiting deploy', states: ['approved'] },
  { key: 'done', title: 'Completed', states: ['filled', 'settled'] },
  { key: 'ended', title: 'Ended', states: ['cancelled', 'expired'] },
  { key: 'draft', title: 'Not started', states: ['awaiting'], collapsed: true },
];

export default function OrdersPage() {
  const { address } = useAccount();
  const view = useViewParam();
  const chainId = useChainId();
  const [showDrafts, setShowDrafts] = useState(false);
  // Per-PAIR price orientation: a set of pair-keys flipped from their moneyness
  // default. Clicking a price flips every order of that pair; "flip prices"
  // flips them all.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const pairKeyOf = (sellToken: string, buyToken: string) => [sellToken.toLowerCase(), buyToken.toLowerCase()].sort().join('/');
  const pairKey = (o: HistoryOrder) => pairKeyOf(o.sellToken, o.buyToken);
  const togglePair = (key: string) => setFlipped((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  // Load instantly from the last-connected owner instead of waiting for the
  // injected wallet to finish reconnecting; reconcile once it connects.
  const [cached, setCached] = useState<{ owner?: string; chainId?: number }>({});
  useEffect(() => {
    try { setCached({ owner: localStorage.getItem('twap:lastOwner') ?? undefined, chainId: Number(localStorage.getItem('twap:lastChain')) || undefined }); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (!address) return;
    try { localStorage.setItem('twap:lastOwner', address); localStorage.setItem('twap:lastChain', String(chainId)); } catch { /* ignore */ }
  }, [address, chainId]);

  const owner = view ?? address ?? cached.owner;
  // /orders is Gnosis-only: every activity this app creates (TWAP, swaps, leverage)
  // settles on Gnosis, and mainnet TWAP can't be created (no helper there). So the
  // whole page reads, resolves tokens, and links against Gnosis — no per-chain fork.
  const chain = getChainConfig(100)!;
  const gnosisClient = usePublicClient({ chainId: 100 });

  // Frontend-only: one pass over the owner's Gnosis orderbook → TWAP carriers
  // (enriched with one on-chain lens call) + this app's plain swaps.
  const { data: history } = useQuery<{ carriers: HistoryOrder[]; swaps: SwapRow[] }>({
    queryKey: ['history', owner],
    enabled: !!owner,
    refetchInterval: 12_000,
    queryFn: async () => {
      const { carriers, swaps } = await fetchOwnerHistory(chain, owner as Address);
      if (!gnosisClient || carriers.length === 0) return { carriers, swaps };
      return { carriers: await enrichOrders(gnosisClient as unknown as PublicClient, carriers), swaps };
    },
  });

  // Aave market config rarely changes — cache it. On failure THROW (so it's an
  // error state react-query retries) rather than a null 'success' that would
  // silently disable the positions query for the whole staleTime. Bounded with a
  // timeout so a hung proxy errors (→ marketError) instead of stalling forever.
  const { data: market, isError: marketError } = useQuery<Market>({
    queryKey: ['aave-market'],
    enabled: !!owner,
    staleTime: 5 * 60_000,
    refetchInterval: (q) => (q.state.status === 'error' ? 15_000 : false),
    queryFn: async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const m = await fetch('/api/aave-market', { signal: ctrl.signal }).then((r) => r.json()) as Market;
        if (!m?.reserves?.length) throw new Error('aave market unavailable');
        return m;
      } finally { clearTimeout(t); }
    },
  });

  // Leverage carriers: localStorage (this device) ∪ barn discovery (any device).
  // Each carries the position's initial equity (for P&L). Slow-changing → 60s.
  const { data: carriers } = useQuery<LevCarrier[]>({
    queryKey: ['levCarriers', owner],
    enabled: !!owner,
    refetchInterval: 60_000,
    queryFn: async () => {
      const discovered = await discoverLeverageCarriers(owner as Address);
      const known = new Set(discovered.map((c) => c.safe.toLowerCase()));
      const extra = loadSavedSafes()
        .filter((s) => !known.has(s.toLowerCase()))
        // debtToken defaults to WXDAI (the dominant debt token); these 'unknown'
        // entries never reach realizedReturn, but a real token avoids a Safe-as-ERC20 landmine.
        .map((safe): LevCarrier => ({ safe, initialEquity: 0n, debtToken: ONBOARD.wxdai as Address, createdAt: 0, status: 'unknown' }));
      return [...discovered, ...extra];
    },
  });
  const safesKey = useMemo(() => (carriers ?? []).map((c) => c.safe.toLowerCase()).sort().join(','), [carriers]);
  const equityOf = useMemo(() => {
    const m = new Map<string, bigint>();
    for (const c of carriers ?? []) m.set(c.safe.toLowerCase(), c.initialEquity);
    return m;
  }, [carriers]);

  // Open leverage positions: live Aave reads over the candidate Safes (Gnosis).
  // placeholderData keeps the prior list while a discovery change refetches.
  const { data: positions } = useQuery<LivePos[]>({
    queryKey: ['positions', owner, safesKey],
    enabled: !!owner && !!market && !!gnosisClient && carriers !== undefined,
    refetchInterval: 12000,
    placeholderData: (prev) => prev,
    queryFn: () => readPositions(gnosisClient as unknown as PublicClient, owner as Address, (carriers ?? []).map((c) => c.safe), market!),
  });

  const now = Math.floor(Date.now() / 1000);
  const orders = useMemo(() => history?.carriers ?? [], [history]);
  const swaps = useMemo(() => history?.swaps ?? [], [history]);
  const levPositions = useMemo(() => positions ?? [], [positions]);
  // portfolio totals across open positions (equity + unrealized P&L)
  const openSummary = useMemo(() => {
    let equity = 0, pnl = 0, havePnl = false;
    for (const p of levPositions) {
      const eq = equityOf.get(p.safe.toLowerCase());
      const r = eq && eq > 0n ? positionPnl(p, eq) : null;
      if (r) { equity += r.equityUsd; pnl += r.pnlUsd; havePnl = true; } else { equity += Math.max(p.m.equityUsd, 0); }
    }
    return { equity, pnl, havePnl };
  }, [levPositions, equityOf]);
  // Closed leverage = fulfilled carriers whose Safe is NOT currently an open position.
  // Gate on a TRUSTWORTHY open set: until `positions` resolves (readPositions now
  // propagates RPC failures rather than returning []), classify nothing as closed —
  // otherwise a read blip would move every open position into the closed list.
  const closed = useMemo(() => {
    if (positions === undefined) return [];
    const open = new Set(positions.map((p) => p.safe.toLowerCase()));
    // drop dust/test closes (deposit < ~0.01 of an 18-dec token) to cut noise.
    return (carriers ?? []).filter((c) => c.status === 'fulfilled' && c.initialEquity >= 10n ** 16n && !open.has(c.safe.toLowerCase()));
  }, [carriers, positions]);
  // Realized return (debt-token paid back to owner) for closed positions; closed
  // state never changes, so cache hard. Map safe→returned (null = indeterminate).
  const { data: realized } = useQuery<Record<string, string | null>>({
    queryKey: ['realized', owner, closed.map((c) => c.safe).join(',')],
    enabled: !!owner && !!gnosisClient && closed.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      // each realizedReturn is an independent 5M-block getLogs — run them concurrently.
      const entries = await Promise.all(closed.map(async (c) => {
        const r = await realizedReturn(gnosisClient as unknown as PublicClient, c.safe, owner as Address, c.debtToken);
        return [c.safe.toLowerCase(), r === null ? null : r.toString()] as const;
      }));
      return Object.fromEntries(entries);
    },
  });
  // The positions pipeline is "settled" once the reads resolve, OR it can't run
  // (no Gnosis client / the market API is down) — so a market outage no longer
  // traps the whole page on "Loading". The page has loaded once history resolved
  // and that pipeline settled. (Only matters when everything is empty.)
  const positionsSettled = positions !== undefined || marketError || !gnosisClient;
  const loaded = history !== undefined && positionsSettled;

  // Token resolution: curated/official list + one batched multicall for unknowns.
  const list = useTokenList(chain);
  const listMap = useMemo(() => {
    const m = new Map<string, Resolved>();
    for (const t of list) m.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
    return m;
  }, [list]);
  const unknown = useMemo(() => {
    const s = new Set<string>();
    const add = (a: string) => { if (!listMap.has(a.toLowerCase())) s.add(a); };
    for (const o of orders) { add(o.sellToken); add(o.buyToken); }
    for (const sw of swaps) { add(sw.sellToken); add(sw.buyToken); }
    return Array.from(s);
  }, [orders, swaps, listMap]);
  const meta = useTokenMeta(chain.chainId, unknown);
  const resolve: ResolveFn = useMemo(() => (addr: string) => {
    const k = addr.toLowerCase();
    return listMap.get(k) ?? meta.get(k) ?? { symbol: shortAddress(addr), decimals: 18 };
  }, [listMap, meta]);

  const byState = (states: OrderState[]) => orders.filter((o) => states.includes(deriveState(o, now).state));
  const nothing = orders.length === 0 && swaps.length === 0 && levPositions.length === 0;

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand"><h1>My Orders</h1><Link className="tag" href={view ? `/?view=${view}` : '/'}>← trade</Link></div>
        <ConnectButton />
      </div>

      {view && <div className="panel" style={{ padding: '10px 16px', fontSize: 13 }}>👁 Read-only — viewing <span className="mono">{shortAddress(view, 6)}</span></div>}
      {!owner && <div className="panel center"><p>Connect your wallet to see your orders.</p></div>}
      {owner && (
        <>
          {!loaded && nothing && <div className="panel"><p className="hint">Loading…</p></div>}
          {loaded && nothing && <div className="panel"><p className="hint">No activity on {chain.name} yet. <Link href="/">Trade →</Link></p></div>}
          {orders.length > 0 && (
            <div className="flipbar"><button className="linkbtn" onClick={() => setFlipped((s) => {
              const keys = Array.from(new Set(orders.map(pairKey)));
              const allFlipped = keys.length > 0 && keys.every((k) => s.has(k));
              return allFlipped ? new Set() : new Set(keys);
            })}>⇄ flip prices</button></div>
          )}

          {levPositions.length > 0 && (
            <div className="panel olist">
              <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span>Leverage positions ({levPositions.length})</span>
                <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
                  ${openSummary.equity.toFixed(2)} equity{openSummary.havePnl && <> · <b style={{ color: openSummary.pnl >= 0 ? 'var(--good)' : 'var(--bad)' }}>{openSummary.pnl >= 0 ? '+' : ''}${openSummary.pnl.toFixed(2)}</b></>}
                </span>
              </h2>
              {levPositions.map((p) => <PositionRow key={p.safe} p={p} initialEquity={equityOf.get(p.safe.toLowerCase())} />)}
            </div>
          )}

          {closed.length > 0 && (
            <div className="panel olist">
              <h2><span>Leverage · Closed ({closed.length})</span></h2>
              {closed.map((c) => <ClosedRow key={c.safe} c={c} resolve={resolve} realized={realized?.[c.safe.toLowerCase()]} />)}
            </div>
          )}

          {GROUPS.map((g) => {
            const olist = byState(g.states);
            if (olist.length === 0) return null;
            const isDraft = g.key === 'draft';
            return (
              <div className="panel olist" key={g.key}>
                <h2 style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>TWAP · {g.title} ({olist.length})</span>
                  {isDraft && <button className="linkbtn" onClick={() => setShowDrafts((s) => !s)}>{showDrafts ? 'hide' : 'show'}</button>}
                </h2>
                {(!isDraft || showDrafts) && olist.map((o) => <OrderRow key={o.safe} chain={chain} o={o} now={now} resolve={resolve} flipPair={flipped.has(pairKey(o))} onFlipPair={() => togglePair(pairKey(o))} />)}
              </div>
            );
          })}

          {swaps.length > 0 && (
            <div className="panel olist">
              <h2><span>Swaps ({swaps.length})</span></h2>
              {swaps.map((s) => { const k = pairKeyOf(s.sellToken, s.buyToken); return <SwapRowItem key={s.uid} chain={chain} s={s} resolve={resolve} flip={flipped.has(k)} onFlip={() => togglePair(k)} />; })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const DATE_FMT: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' };

function OrderRow({ chain, o, now, resolve, flipPair, onFlipPair }: { chain: ChainConfig; o: HistoryOrder; now: number; resolve: ResolveFn; flipPair: boolean; onFlipPair: () => void }) {
  const [open, setOpen] = useState(false);
  const sell = resolve(o.sellToken);
  const buy = resolve(o.buyToken);
  const st = deriveState(o, now);
  const K = fundedParts(o);
  const avg = avgPrice(o, sell.decimals, buy.decimals);
  let remaining = 0n, received = 0n;
  try { remaining = BigInt(o.remainingSell || '0'); } catch { /* ignore */ }
  try { received = BigInt(o.executedBuy || '0'); } catch { /* ignore */ }
  // effective orientation = moneyness default XOR this pair's flip
  const eff = baseFlip(sell.symbol, buy.symbol) !== flipPair;
  const price = rateParts(avg, eff, sell.symbol, buy.symbol);

  // Right-hand amount: while still working (or not started) show the MIN target
  // (≥ minReceive) — showing partial-received next to the full sell is misleading.
  // Once done, show what was actually received.
  let minTotal = 0n;
  try { minTotal = BigInt(o.minPartLimit) * BigInt(K); } catch { /* ignore */ }
  const working = st.state === 'active' || st.state === 'partial' || !o.deployed;
  const recvText = working
    ? (minTotal > 0n ? `≥ ${dispAmount(minTotal, buy.decimals)}` : '—')
    : (received > 0n ? dispAmount(received, buy.decimals) : '—');

  return (
    <div className={`orow ${open ? 'open' : ''}`}>
      <div className="orow-head" onClick={() => setOpen((v) => !v)}>
        <div className="oleft">
          <div className="osyms">{sell.symbol} → {buy.symbol}</div>
          <div className="oamts">{dispAmount(BigInt(o.totalSell), sell.decimals)} → {recvText} · {K}×{humanizeSeconds(BigInt(o.t))}{o.n > K ? ` (≤${o.n})` : ''}</div>
        </div>
        <div className="ocenter">
          {price && (
            <button className="oprice" title="Flip this pair" onClick={(e) => { e.stopPropagation(); onFlipPair(); }}>
              {price.num} <span className="ounit">{price.unit}</span>
            </button>
          )}
        </div>
        <div className="oright">
          <span className={`badge ${st.tone}`}>{st.label}</span>
          <div className="odate">{new Date(o.createdAt * 1000).toLocaleString('en-US', DATE_FMT)}<span className="ochev">{open ? '▴' : '▾'}</span></div>
        </div>
      </div>
      {open && (
        <OrderDetail chain={chain} o={o} sell={sell} buy={buy} K={K} avg={avg} remaining={remaining} received={received} settled={isSettled(st.state)} inProgress={st.state === 'active' || st.state === 'partial'} flip={eff} onFlip={onFlipPair} />
      )}
    </div>
  );
}

function OrderDetail({ chain, o, sell, buy, K, avg, remaining, received, settled, inProgress, flip, onFlip }: {
  chain: ChainConfig; o: HistoryOrder; sell: Resolved; buy: Resolved; K: number; avg: number | null; remaining: bigint; received: bigint; settled: boolean; inProgress: boolean; flip: boolean; onFlip: () => void;
}) {
  const { data, isLoading } = useQuery<Leg[]>({
    queryKey: ['legs', chain.chainId, o.safe],
    enabled: o.deployed,
    staleTime: 15_000,
    queryFn: () => fetchSafeLegs(chain.chainId, o.safe),
  });
  const legs = data ?? [];

  // Per-part limit price (buy per sell) = minPartLimit / partSell. Each fill's
  // surplus over this floor is what we color: lots of margin = green, barely
  // above the limit = red/amber.
  let limitPrice: number | null = null;
  try {
    const ps = Number(formatUnits(BigInt(o.partSell), sell.decimals));
    const ml = Number(formatUnits(BigInt(o.minPartLimit), buy.decimals));
    limitPrice = ps > 0 ? ml / ps : null;
  } catch { /* ignore */ }

  return (
    <div className="orow-detail">
      {/* Summary from STORED data — correct immediately, no "0/12" flash while legs load. */}
      {o.deployed && (
        <div className="kv"><span className="k">Executed</span><span className="v">{o.filledParts}/{K} parts · {dispAmount(received, buy.decimals)} {buy.symbol} received</span></div>
      )}
      {avg != null && (
        <div className="kv">
          <span className="k">Avg fill price</span>
          <span className="v">{fmtRate(avg, flip, sell.symbol, buy.symbol)} <button className="flipbtn" onClick={onFlip} title="Flip prices">⇄</button></span>
        </div>
      )}

      {o.deployed && (
        <div className="legs">
          {isLoading && legs.length === 0 && <div className="hint">Loading fills…</div>}
          {!isLoading && legs.length === 0 && <div className="hint">No fills yet.</div>}
          {legs.map((l, i) => {
            const s = Number(formatUnits(BigInt(l.sellAmount || '0'), sell.decimals));
            const b = Number(formatUnits(BigInt(l.buyAmount || '0'), buy.decimals));
            const p = s > 0 ? b / s : 0; // buy per sell (canonical)
            // surplus of this fill over your per-part limit price (≥0 = above floor)
            const dev = limitPrice && limitPrice > 0 && p > 0 ? (p / limitPrice - 1) * 100 : null;
            const devColor = dev == null ? 'var(--muted)' : dev >= 1 ? 'var(--good)' : dev >= 0.3 ? 'var(--warn)' : 'var(--bad)';
            return (
              <div className="leg" key={l.orderUid || i}>
                <span className="legn">#{i + 1}</span>
                <span className="legamt">{dispAmount(BigInt(l.sellAmount || '0'), sell.decimals)} {sell.symbol} → {dispAmount(BigInt(l.buyAmount || '0'), buy.decimals)} {buy.symbol}</span>
                <span className="legprice">{rateParts(p, flip, sell.symbol, buy.symbol)?.num ?? ''}</span>
                <span className="legdev" title="surplus over your limit price" style={{ color: devColor }}>{dev == null ? '' : `${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%`}</span>
                <span className="legtx">{l.txHash ? <a href={`${chain.explorer}/tx/${l.txHash}`} target="_blank" rel="noreferrer">tx ↗</a> : ''}</span>
              </div>
            );
          })}
        </div>
      )}

      {(settled || inProgress) && remaining > 0n && (
        <ClaimButton mode={inProgress ? 'cancel' : 'claim'} safe={o.safe as `0x${string}`} sellToken={o.sellToken as `0x${string}`} owner={o.owner as `0x${string}`} remaining={remaining} symbol={sell.symbol} decimals={sell.decimals} />
      )}

      {o.carrierUid && (
        <div className="kv">
          <span className="k hint">Funding order</span>
          <span className="v hint">
            <a href={`${chain.cowExplorer}/orders/${o.carrierUid}`} target="_blank" rel="noreferrer">Carrier on CoW ↗</a>
            {!o.deployed && <span> · {o.carrierStatus}</span>}
          </span>
        </div>
      )}

      <div className="kv">
        <span className="k hint">{shortAddress(o.safe, 5)}</span>
        <span className="v hint">
          <a className="addr" href={`${chain.explorer}/address/${o.safe}`} target="_blank" rel="noreferrer">Explorer</a>
          {' · '}<a href={`${chain.cowExplorer}/address/${o.safe}`} target="_blank" rel="noreferrer">CoW</a>
          {' · '}<a href={`https://app.safe.global/home?safe=${chain.safeAppPrefix}:${o.safe}`} target="_blank" rel="noreferrer">Safe</a>
        </span>
      </div>
    </div>
  );
}

const SWAP_TONE: Record<string, string> = { fulfilled: 'good', expired: 'warn', cancelled: 'bad' };
const SWAP_LABEL: Record<string, string> = { fulfilled: 'Filled', open: 'Open', expired: 'Expired', cancelled: 'Cancelled', presignaturePending: 'Pending' };

/** A single plain wallet swap (read-only row). */
function SwapRowItem({ chain, s, resolve, flip, onFlip }: { chain: ChainConfig; s: SwapRow; resolve: ResolveFn; flip: boolean; onFlip: () => void }) {
  const sell = resolve(s.sellToken);
  const buy = resolve(s.buyToken);
  const filled = s.status === 'fulfilled';
  const big = (v: string) => { try { return BigInt(v); } catch { return 0n; } };
  const signedSell = big(s.sellAmount), signedBuy = big(s.buyAmount), execSell = big(s.executedSell), execBuy = big(s.executedBuy);
  const useExec = filled && execSell > 0n;
  const outSell = useExec ? execSell : signedSell;
  const outBuy = useExec ? execBuy : signedBuy;
  const price = outSell > 0n ? Number(formatUnits(outBuy, buy.decimals)) / Number(formatUnits(outSell, sell.decimals)) : null;
  const eff = baseFlip(sell.symbol, buy.symbol) !== flip;
  const pr = price != null ? rateParts(price, eff, sell.symbol, buy.symbol) : null;
  return (
    <div className="orow">
      <div className="orow-head" style={{ cursor: 'default' }}>
        <div className="oleft">
          <div className="osyms">{sell.symbol} → {buy.symbol}</div>
          <div className="oamts">{dispAmount(outSell, sell.decimals)} → {filled ? dispAmount(outBuy, buy.decimals) : `≥ ${dispAmount(signedBuy, buy.decimals)}`}</div>
        </div>
        <div className="ocenter">
          {pr && <button className="oprice" title="Flip this pair" onClick={onFlip}>{pr.num} <span className="ounit">{pr.unit}</span></button>}
        </div>
        <div className="oright">
          <span className={`badge ${SWAP_TONE[s.status] ?? ''}`}>{SWAP_LABEL[s.status] ?? s.status}</span>
          <div className="odate">{new Date(s.createdAt * 1000).toLocaleString('en-US', DATE_FMT)} · <a href={`${chain.cowExplorer}/orders/${s.uid}`} target="_blank" rel="noreferrer">CoW ↗</a></div>
        </div>
      </div>
    </div>
  );
}

/** A single open leverage position (read-only summary; manage from the trade tab). */
function PositionRow({ p, initialEquity }: { p: LivePos; initialEquity?: bigint }) {
  const coll = Number(formatUnits(p.collQty, p.collTok.decimals));
  const debt = Number(formatUnits(p.debtQty, p.debtTok.decimals));
  const hf = p.m.healthFactor;
  const hfTone = hf > 1.4 ? 'good' : hf > 1.15 ? 'warn' : 'bad';
  const pnl = initialEquity != null && initialEquity > 0n ? positionPnl(p, initialEquity) : null;
  return (
    <div className="orow">
      <div className="orow-head" style={{ cursor: 'default' }}>
        <div className="oleft">
          <div className="osyms">{p.collTok.symbol} {p.m.leverage.toFixed(1)}× <span className="ounit">long</span></div>
          <div className="oamts" style={{ whiteSpace: 'normal' }}>
            {pnl
              ? <>Equity ${pnl.equityUsd.toFixed(2)} · <b style={{ color: pnl.pnlUsd >= 0 ? 'var(--good)' : 'var(--bad)' }}>{pnl.pnlUsd >= 0 ? '+' : ''}${pnl.pnlUsd.toFixed(2)} ({pnl.pnlPct >= 0 ? '+' : ''}{pnl.pnlPct.toFixed(1)}%)</b></>
              : <>{coll.toFixed(4)} {p.collTok.symbol} collateral · {debt.toFixed(2)} {p.debtTok.symbol} debt</>}
          </div>
        </div>
        <div className="ocenter">
          <span className="oprice" title="Health factor">HF {hf > 100 ? '∞' : hf.toFixed(2)}</span>
        </div>
        <div className="oright">
          <span className={`badge ${hfTone}`}>{p.m.liqPrice ? `Liq ${p.m.liqPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'Open'}</span>
          {/* positions are always Gnosis, regardless of the page's viewed chain */}
          <div className="odate"><Link href="/">Manage →</Link> · <a href={`https://app.safe.global/home?safe=gno:${p.safe}`} target="_blank" rel="noreferrer">Safe ↗</a></div>
        </div>
      </div>
    </div>
  );
}

/** A closed leverage position: initial deposit + best-effort realized return. */
function ClosedRow({ c, resolve, realized }: { c: LevCarrier; resolve: ResolveFn; realized?: string | null }) {
  const debt = resolve(c.debtToken);
  const deposit = Number(formatUnits(c.initialEquity, debt.decimals));
  // realized: debt-token returned to owner on close (undefined = still loading,
  // null = indeterminate). P&L = returned − deposit, in debt-token terms (≈ USD for WXDAI).
  let pnlNode: React.ReactNode = realized === undefined ? '· P&L …' : '· P&L —';
  if (realized != null) {
    try {
      const ret = Number(formatUnits(BigInt(realized), debt.decimals));
      const d = ret - deposit; const pct = deposit > 0 ? (d / deposit) * 100 : 0;
      pnlNode = <>· returned {ret.toFixed(2)} · <b style={{ color: d >= 0 ? 'var(--good)' : 'var(--bad)' }}>{d >= 0 ? '+' : ''}{d.toFixed(2)} {debt.symbol} ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)</b></>;
    } catch { /* keep — */ }
  }
  return (
    <div className="orow">
      <div className="orow-head" style={{ cursor: 'default' }}>
        <div className="oleft">
          <div className="osyms">{debt.symbol} leverage <span className="ounit">closed</span></div>
          <div className="oamts" style={{ whiteSpace: 'normal' }}>Deposited {deposit.toFixed(2)} {debt.symbol} {pnlNode}</div>
        </div>
        <div className="oright">
          <span className="badge">Closed</span>
          <div className="odate">{c.createdAt ? new Date(c.createdAt * 1000).toLocaleString('en-US', DATE_FMT) : ''} · <a href={`https://app.safe.global/home?safe=gno:${c.safe}`} target="_blank" rel="noreferrer">Safe ↗</a></div>
        </div>
      </div>
    </div>
  );
}
