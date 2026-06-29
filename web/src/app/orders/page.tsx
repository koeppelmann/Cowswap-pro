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
import { enrichOrders, fetchOwnerCarriers, fetchSafeLegs, type HistoryOrder, type Leg } from '../../lib/carrierHistory';
import { dispAmount, fmtRate, humanizeSeconds, rateParts, shortAddress } from '../../lib/format';
import { useTokenList } from '../../lib/useTokenList';
import { useTokenMeta } from '../../lib/useTokenMeta';

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
  const chainId = useChainId();
  const [showDrafts, setShowDrafts] = useState(false);
  // Per-PAIR price orientation: a set of pair-keys flipped from their moneyness
  // default. Clicking a price flips every order of that pair; "flip prices"
  // flips them all.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const pairKey = (o: HistoryOrder) => [o.sellToken.toLowerCase(), o.buyToken.toLowerCase()].sort().join('/');
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

  const owner = address ?? cached.owner;
  const effChain = address ? chainId : (cached.chainId ?? chainId);
  const chain = getChainConfig(effChain);
  const publicClient = usePublicClient({ chainId: effChain as 1 | 100 });

  // Frontend-only: the owner's TWAPs are derived entirely from the public CoW
  // orderbook (their in-kind carrier orders) + one on-chain lens call. No server.
  const { data, isLoading } = useQuery<HistoryOrder[]>({
    queryKey: ['twaps', effChain, owner],
    enabled: !!owner && !!chain,
    refetchInterval: 8000,
    queryFn: async () => {
      if (!chain || !owner) return [];
      const carriers = await fetchOwnerCarriers(chain, owner as Address);
      if (!publicClient || carriers.length === 0) return carriers;
      return enrichOrders(publicClient as unknown as PublicClient, carriers);
    },
  });

  const now = Math.floor(Date.now() / 1000);
  const orders = useMemo(() => data ?? [], [data]);

  // Token resolution: curated/official list + one batched multicall for unknowns.
  const list = useTokenList(chain ?? getChainConfig(100)!);
  const listMap = useMemo(() => {
    const m = new Map<string, Resolved>();
    for (const t of list) m.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
    return m;
  }, [list]);
  const unknown = useMemo(() => {
    const s = new Set<string>();
    for (const o of orders) { for (const a of [o.sellToken, o.buyToken]) { const k = a.toLowerCase(); if (!listMap.has(k)) s.add(a); } }
    return Array.from(s);
  }, [orders, listMap]);
  const meta = useTokenMeta(effChain, unknown);
  const resolve: ResolveFn = useMemo(() => (addr: string) => {
    const k = addr.toLowerCase();
    return listMap.get(k) ?? meta.get(k) ?? { symbol: shortAddress(addr), decimals: 18 };
  }, [listMap, meta]);

  const byState = (states: OrderState[]) => orders.filter((o) => states.includes(deriveState(o, now).state));

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand"><h1>My Orders</h1><Link className="tag" href="/">← new TWAP</Link></div>
        <ConnectButton />
      </div>

      {!owner && <div className="panel center"><p>Connect your wallet to see your TWAPs.</p></div>}
      {owner && chain && (
        <>
          {isLoading && orders.length === 0 && <div className="panel"><p className="hint">Loading…</p></div>}
          {!isLoading && orders.length === 0 && <div className="panel"><p className="hint">No TWAPs on {chain.name} yet. <Link href="/">Create one →</Link></p></div>}
          {orders.length > 0 && (
            <div className="flipbar"><button className="linkbtn" onClick={() => setFlipped((s) => {
              const keys = Array.from(new Set(orders.map(pairKey)));
              const allFlipped = keys.length > 0 && keys.every((k) => s.has(k));
              return allFlipped ? new Set() : new Set(keys);
            })}>⇄ flip prices</button></div>
          )}

          {GROUPS.map((g) => {
            const olist = byState(g.states);
            if (olist.length === 0) return null;
            const isDraft = g.key === 'draft';
            return (
              <div className="panel olist" key={g.key}>
                <h2 style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{g.title} ({olist.length})</span>
                  {isDraft && <button className="linkbtn" onClick={() => setShowDrafts((s) => !s)}>{showDrafts ? 'hide' : 'show'}</button>}
                </h2>
                {(!isDraft || showDrafts) && olist.map((o) => <OrderRow key={o.safe} chain={chain} o={o} now={now} resolve={resolve} flipPair={flipped.has(pairKey(o))} onFlipPair={() => togglePair(pairKey(o))} />)}
              </div>
            );
          })}
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
