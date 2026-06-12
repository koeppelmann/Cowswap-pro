'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatUnits, type Address } from 'viem';
import { useAccount, useBytecode, useChainId, useReadContract } from 'wagmi';
import { ConnectButton } from '../components/ConnectButton';
import { ConfirmModal } from '../components/ConfirmModal';
import { TokenPicker } from '../components/TokenPicker';
import { SwapTab } from '../components/SwapTab';
import { DurationPicker } from '../components/DurationPicker';
import { erc20Abi } from '../lib/abi';
import { getChainConfig } from '../lib/chains';
import { buildPlan, type Plan } from '../lib/plan';
import { type Duration, dispAmount, durationToSeconds, fmtAmount, fmtRate, humanizeSeconds, isAddress, shortAddress, tryParseUnits } from '../lib/format';
import { useToken } from '../lib/useToken';
import { useQuotes } from '../lib/useQuotes';
import { useSpot } from '../lib/useSpot';
import { useDebounced } from '../lib/useDebounced';
import { twapAdvantageBps } from '../lib/quote';
import { minPartFromPrice, minPartFromReceiveTotal, minPartFromSlippage, minPriceStr, minReceiveTotalStr, slippageBpsFromMinPart } from '../lib/limit';

const IVOPTS: { s: bigint; label: string }[] = [
  { s: 60n, label: '1m' }, { s: 300n, label: '5m' }, { s: 900n, label: '15m' },
  { s: 1800n, label: '30m' }, { s: 3600n, label: '1h' }, { s: 21600n, label: '6h' }, { s: 86400n, label: '1d' },
];

/** Sensible default interval for a total timeframe (user can override). ~8–30 parts. */
function defaultInterval(totalSeconds: bigint): bigint {
  const H = 3600n;
  if (totalSeconds <= 1n * H) return 300n;     // ≤ 1h  → 5m
  if (totalSeconds <= 2n * H) return 900n;     // ≤ 2h  → 15m
  if (totalSeconds <= 6n * H) return 1800n;    // ≤ 6h  → 30m
  if (totalSeconds <= 24n * H) return 3600n;   // ≤ 1d  → 1h
  if (totalSeconds <= 168n * H) return 21600n; // ≤ 1w  → 6h
  return 86400n;                               // > 1w  → 1d
}

/** Total seconds → a Duration for the "Over" picker (largest clean unit). */
function secondsToDuration(s: bigint): Duration {
  if (s > 0n && s % 86400n === 0n) return { value: Number(s / 86400n), unit: 'days' };
  if (s > 0n && s % 3600n === 0n) return { value: Number(s / 3600n), unit: 'hours' };
  return { value: Number(s / 60n), unit: 'minutes' };
}
const QUOTE_FALLBACK_FROM = '0x0000000000000000000000000000000000000001' as const;
const ZERO = '0x0000000000000000000000000000000000000000';

function rate(buy: bigint | undefined | null, sell: bigint | null, buyDec: number, sellDec: number): number | null {
  if (buy == null || sell === null || sell === 0n) return null;
  return Number(formatUnits(buy, buyDec)) / Number(formatUnits(sell, sellDec));
}

function invStr(s: string): string {
  const x = Number(s);
  return isFinite(x) && x > 0 ? Number((1 / x).toPrecision(8)).toString() : '';
}

/** Small ⓘ with a CSS hover/focus tooltip (more reliable than native title). */
function Info({ text, wide }: { text: string; wide?: boolean }) {
  return <span className={`info${wide ? ' wide' : ''}`} data-tip={text} tabIndex={0} role="img" aria-label={text}>ⓘ</span>;
}

type Tab = 'swap' | 'limit' | 'twap';

/** Shared tab row — rendered inside each tab's own widget so styling stays native. */
function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="tabs">
      <button className={`tab ${tab === 'swap' ? 'active' : ''}`} onClick={() => setTab('swap')}>Swap</button>
      <button className="tab" disabled title="Coming soon">Limit</button>
      <button className={`tab ${tab === 'twap' ? 'active' : ''}`} onClick={() => setTab('twap')}>TWAP</button>
    </div>
  );
}

export default function Page() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const chain = getChainConfig(chainId);
  // Swap (with optional leverage) is the default; TWAP keeps the existing builder.
  const [tab, setTab] = useState<Tab>('swap');

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand"><h1>🐮 TWAP Safe</h1></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {isConnected && <Link href="/orders" className="tag">My orders →</Link>}
          <ConnectButton />
        </div>
      </div>

      {tab === 'swap' ? (
        <SwapTab tabs={<Tabs tab={tab} setTab={setTab} />} />
      ) : isConnected && !chain ? (
        <div className="widget center"><p className="errors">Unsupported network — switch to Ethereum or Gnosis.</p></div>
      ) : (
        <Builder key={chainId} chain={chain ?? getChainConfig(1)!} owner={address} connected={isConnected} tabs={<Tabs tab={tab} setTab={setTab} />} />
      )}

      {tab === 'twap' && (
        <p className="hint center" style={{ marginTop: 22 }}>
          Single tx time-weighted average price orders on CoW Protocol.
          <Info wide text="Submitting a CoW Swap TWAP order requires a Safe. This interface creates a single-use Safe whose address is calculated deterministically in advance. You give that address an allowance; then a relayer deploys the Safe (or you can deploy it yourself), which claims the tokens needed for the order and places it — all in one transaction. The Safe is controlled solely by your wallet, so you stay in full custody of your tokens the whole time." />
        </p>
      )}
    </div>
  );
}

function Builder({ chain, owner, connected, tabs }: { chain: NonNullable<ReturnType<typeof getChainConfig>>; owner?: Address; connected: boolean; tabs: React.ReactNode }) {
  // sensible defaults so the widget shows a live quote immediately (Builder is
  // keyed by chainId, so these re-init per chain). Gnosis → WXDAI→GNO, mainnet → WETH→USDT.
  const [sellAddr, setSellAddr] = useState<string>(chain.tokens[0]?.address ?? '');
  const [buyAddr, setBuyAddr] = useState<string>(chain.tokens[2]?.address ?? chain.tokens[1]?.address ?? '');
  const [totalSellStr, setTotalSellStr] = useState('100');
  // Source of truth for timing is parts (n) + interval (t). Total = n × t is
  // DERIVED, so the three always add up. Defaults: 12 × 5m = 1h.
  const [nParts, setNParts] = useState(12);
  const [partSeconds, setPartSeconds] = useState<bigint>(300n);
  const [flip, setFlip] = useState(false);
  const [receiverStr, setReceiverStr] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [editRecipient, setEditRecipient] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // canonical scheduling
  const [alignStart, setAlignStart] = useState(true);
  const [skipBufferPct, setSkipBufferPct] = useState(0);
  const [spanSeconds, setSpanSeconds] = useState<bigint>(0n);
  const [confirmNow, setConfirmNow] = useState<bigint | null>(null);
  // Snapshot the plan when the modal opens so the reviewed Safe address / amounts
  // can't drift when the background quote refreshes mid-review.
  const [frozenPlan, setFrozenPlan] = useState<Plan | null>(null);

  // Limit: the per-part BUY AMOUNT (minPartLimit) is the anchor — it's what the
  // on-chain order actually commits to. slippage %, limit price and min-receive
  // are just views of it. `source` = the field the user last edited; its raw text
  // stays authoritative (never re-derived → can't snap), the others recompute.
  // Default: track the live quote at 0.5% until the user touches a field.
  const [slipStr, setSlipStr] = useState('0.5');
  const [priceStr, setPriceStr] = useState('');
  const [recvStr, setRecvStr] = useState('');
  const [source, setSource] = useState<'slip' | 'price' | 'recv'>('slip');

  const { token: sellToken } = useToken(chain, sellAddr);
  const { token: buyToken } = useToken(chain, buyAddr);
  const sd = sellToken?.decimals ?? 18;
  const bd = buyToken?.decimals ?? 18;

  const { data: sellBalRaw } = useReadContract({
    address: sellToken?.address, abi: erc20Abi, functionName: 'balanceOf', args: owner ? [owner] : undefined,
    query: { enabled: !!sellToken && !!owner, refetchInterval: 12000 },
  });
  const sellBal = (sellBalRaw as bigint | undefined) ?? 0n;

  const totalSell = sellToken ? tryParseUnits(totalSellStr, sellToken.decimals) : null;
  // total = n × t (exact, always consistent); the "Over" field shows this.
  const n = BigInt(nParts);
  const totalSeconds = n * partSeconds;
  const totalDur = secondsToDuration(totalSeconds);
  const partSellAmount = totalSell !== null && n > 1n ? totalSell / n : null;

  // Timing edits — keep the three values consistent (total = parts × interval):
  //  • change Over  → re-pick a sensible interval for that period, derive parts
  //  • change interval → keep the period, derive parts (snaps to parts × interval)
  //  • change parts → keep the period, derive interval (= period / parts)
  const roundDiv = (a: bigint, b: bigint) => (b <= 0n ? 0n : (a + b / 2n) / b);
  const onOverChange = (d: Duration) => {
    const T = durationToSeconds(d);
    if (T <= 0n) return;
    const t = defaultInterval(T);
    setPartSeconds(t);
    setNParts(Number(bigMax(2n, roundDiv(T, t))));
  };
  const onIntervalChange = (t: bigint) => {
    if (t <= 0n) return;
    setPartSeconds(t);
    setNParts(Number(bigMax(2n, roundDiv(totalSeconds, t))));
  };
  const onPartsChange = (p: number) => {
    const np = Math.max(2, Math.floor(p) || 2);
    setPartSeconds(bigMax(1n, roundDiv(totalSeconds, BigInt(np))));
    setNParts(np);
  };

  // scheduling derived values
  const bufferBps = Math.round(skipBufferPct * 100);
  const windows = n > 0n ? bigMax(n, (n * BigInt(10000 + bufferBps) + 9999n) / 10000n) : n;
  const SPAN_CANDIDATES = [300n, 900n, 1800n, 3600n, 21600n];
  const spanOpts = SPAN_CANDIDATES.filter((s) => s < partSeconds && s >= 300n);
  const effSpan = spanSeconds > 0n && spanSeconds < partSeconds ? spanSeconds : 0n;
  const planNow = confirmNow ?? BigInt(Math.floor(Date.now() / 1000));

  // debounce the amounts so typing doesn't fire a quote per keystroke
  const dPart = useDebounced(partSellAmount, 450);
  const dTotal = useDebounced(totalSell, 450);
  const quotes = useQuotes({
    chainId: chain.chainId, sellToken: sellToken?.address, buyToken: buyToken?.address,
    from: owner ?? QUOTE_FALLBACK_FROM,
    partSellAmount: dPart ?? undefined, totalSell: dTotal ?? undefined,
  });
  const legBuy = quotes.data?.leg.buyAmount;
  const fullBuy = quotes.data?.full.buyAmount;
  // Canonical per-part buy amount, computed from whichever field is the source.
  // (The order ultimately IS sell+buy amounts, so we anchor on the buy amount.)
  const minPartLimit = useMemo<bigint | null>(() => {
    if (legBuy === undefined || partSellAmount === null || partSellAmount <= 0n) return null;
    if (source === 'price') {
      const x = Number(priceStr);
      if (!isFinite(x) || x <= 0) return null;
      const buyPerSell = flip ? 1 / x : x; // input is in displayed orientation
      return minPartFromPrice(String(buyPerSell), partSellAmount, bd, sd);
    }
    if (source === 'recv') return minPartFromReceiveTotal(recvStr, n, bd);
    return minPartFromSlippage(legBuy, Math.round((Number(slipStr) || 0) * 100));
  }, [source, priceStr, recvStr, slipStr, legBuy, partSellAmount, flip, bd, sd, n]);

  // Re-derive only the NON-source views from the anchor: the field you typed never
  // snaps, and when the quote moves the slippage (relative) shifts while the buy
  // amount holds constant.
  useEffect(() => {
    if (minPartLimit === null || partSellAmount === null) return;
    if (source !== 'slip' && legBuy && legBuy > 0n) setSlipStr((slippageBpsFromMinPart(minPartLimit, legBuy) / 100).toString());
    if (source !== 'price') {
      const canonical = minPriceStr(minPartLimit, partSellAmount, bd, sd); // buy per sell
      setPriceStr(flip ? invStr(canonical) : canonical);
    }
    if (source !== 'recv') setRecvStr(minReceiveTotalStr(minPartLimit, n, bd));
  }, [minPartLimit, source, legBuy, partSellAmount, flip, bd, sd, n]);

  const onSlippage = (v: string) => { setSource('slip'); setSlipStr(v); };
  const onMinPrice = (v: string) => { setSource('price'); setPriceStr(v); };
  const onMinRecv = (v: string) => { setSource('recv'); setRecvStr(v); };
  // When the limit-price field is the source, flipping must convert it in place
  // (the derive-effect skips the source field); non-source fields the effect handles.
  const toggleFlip = () => { if (source === 'price' && priceStr) setPriceStr(invStr(priceStr)); setFlip((f) => !f); };

  const spot = useSpot({ chainId: chain.chainId, sellToken: sellToken?.address, buyToken: buyToken?.address, sellDecimals: sellToken?.decimals, buyDecimals: buyToken?.decimals });
  const execRate = rate(legBuy, partSellAmount, bd, sd);
  const minRate = rate(minPartLimit, partSellAmount, bd, sd);
  const fullRate = rate(fullBuy, totalSell, bd, sd);
  const advantageBps = legBuy !== undefined && fullBuy !== undefined ? twapAdvantageBps(legBuy, n, fullBuy) : null;
  // estimated per-part execution vs the (size-independent) spot mid
  const spotDiffBps = execRate !== null && spot.data != null && spot.data > 0 ? Math.round((execRate / spot.data - 1) * 10000) : null;
  const estTotalBuy = legBuy !== undefined ? legBuy * n : null;

  const helper = useBytecode({ address: chain.twapSafeInitializer, query: { enabled: true } });
  const helperMissing = helper.data !== undefined && (helper.data === '0x' || !helper.data);

  const tooShort = partSeconds < 180n;
  const customReceiver = receiverStr.trim();
  const receiverValid = customReceiver === '' || (isAddress(customReceiver) && customReceiver.toLowerCase() !== ZERO);
  const receiver: Address | undefined = customReceiver === '' ? owner : (isAddress(customReceiver) ? customReceiver : undefined);
  const configOk = !!sellToken && !!buyToken && totalSell !== null && totalSell > 0n && n > 1n && minPartLimit !== null && minPartLimit > 0n && !tooShort && !helperMissing && receiverValid;

  const plan = configOk && owner && receiver ? buildPlan({
    owner, chain, sellToken: sellToken!.address, sellDecimals: sellToken!.decimals, buyToken: buyToken!.address,
    receiver, totalSell: totalSell!, minPartLimit: minPartLimit!, n, partSeconds,
    span: effSpan, skipBufferBps: bufferBps, alignStart, nowSec: planNow,
  }) : null;

  const switchTokens = () => { const s = sellAddr; setSellAddr(buyAddr); setBuyAddr(s); };

  let cta = 'Review TWAP'; let ctaDisabled = false;
  if (!sellToken || !buyToken) { cta = 'Select tokens'; ctaDisabled = true; }
  else if (totalSell === null || totalSell <= 0n) { cta = 'Enter an amount'; ctaDisabled = true; }
  else if (tooShort) { cta = 'Interval too short'; ctaDisabled = true; }
  else if (!receiverValid) { cta = 'Invalid recipient'; ctaDisabled = true; }
  else if (quotes.isLoading) { cta = 'Fetching price…'; ctaDisabled = true; }
  else if (quotes.isError) { cta = 'No route for this pair'; ctaDisabled = true; }
  else if (!connected) { cta = 'Connect wallet to continue'; ctaDisabled = true; }
  else if (totalSell !== null && sellToken && sellBal < totalSell) { cta = `Insufficient ${sellToken.symbol}`; ctaDisabled = true; }

  const sym = (s?: string) => s ?? '';

  return (
    <>
      <div className="widget">
        {tabs}

        <div className="token-row">
          <div className="label"><span>Sell total</span>{sellToken && owner && <span>Balance {dispAmount(sellBal, sellToken.decimals)}</span>}</div>
          <div className="body">
            <input className="amount-input" inputMode="decimal" placeholder="0" value={totalSellStr} onChange={(e) => setTotalSellStr(e.target.value)} />
            <TokenPicker chain={chain} value={sellAddr} onChange={setSellAddr} owner={owner} />
          </div>
          {sellToken && owner && sellBal > 0n && (
            <div className="sub"><span></span><button className="maxbtn" onClick={() => setTotalSellStr(formatUnits(sellBal, sellToken.decimals))}>MAX</button></div>
          )}
        </div>

        <div className="swap-divider"><button onClick={switchTokens} title="Switch">↓</button></div>

        <div className="token-row">
          <div className="label"><span>Receive (estimated)</span></div>
          <div className="body">
            <input className="amount-input" placeholder="0" disabled value={estTotalBuy !== null && buyToken ? dispAmount(estTotalBuy, buyToken.decimals) : ''} />
            <TokenPicker chain={chain} value={buyAddr} onChange={setBuyAddr} owner={owner} />
          </div>
          {buyToken && (minPartLimit !== null || advantageBps !== null || spotDiffBps !== null) && (
            <div className="sub">
              <span>{minPartLimit !== null ? `min ${dispAmount(minPartLimit * n, buyToken.decimals)} ${buyToken.symbol}` : ''}</span>
              <span style={{ display: 'flex', gap: 14 }}>
                {spotDiffBps !== null && <span>vs spot <b style={{ color: spotDiffBps >= 0 ? 'var(--good)' : 'var(--warn)' }}>{spotDiffBps >= 0 ? '+' : ''}{(spotDiffBps / 100).toFixed(2)}%</b></span>}
                {advantageBps !== null && <span>vs 1 swap <b style={{ color: advantageBps >= 0 ? 'var(--good)' : 'var(--warn)' }}>{advantageBps >= 0 ? '+' : ''}{(advantageBps / 100).toFixed(2)}%</b></span>}
              </span>
            </div>
          )}
        </div>

        {/* TIME: total = parts × interval, always kept consistent */}
        <div className="timerow">
          <span className="tl">Over</span>
          <DurationPicker value={totalDur} onChange={onOverChange} />
          <span className="tl">in</span>
          <input className="mini" inputMode="numeric" value={nParts} onChange={(e) => onPartsChange(parseInt(e.target.value, 10))} />
          <span className="tl">parts, every</span>
          <select className="mini" value={partSeconds.toString()} onChange={(e) => onIntervalChange(BigInt(e.target.value))}>
            {!IVOPTS.some((o) => o.s === partSeconds) && <option value={partSeconds.toString()}>{humanizeSeconds(partSeconds)}</option>}
            {IVOPTS.map((o) => <option key={o.label} value={o.s.toString()}>{o.label}</option>)}
          </select>
        </div>

        {/* PRICE PROTECTION (simple) + advanced exact-limit disclosure */}
        {/* labels in row 1, inputs in row 2 → inputs always align even if a label is taller */}
        <div className="pricerow">
          <label className="pl">Price protection (max slippage %) <Info text="The most each part may slip below the live quote before it won't trade. This sets the limit price / minimum received per part. Negative values are allowed, to require a better-than-market price." /></label>
          <label className="pl">
            Limit price ({flip ? `${sym(sellToken?.symbol)}/${sym(buyToken?.symbol)}` : `${sym(buyToken?.symbol)}/${sym(sellToken?.symbol)}`})
            {sellToken && buyToken && <button className="flipbtn" onClick={toggleFlip} title="Flip prices">⇄</button>}
          </label>
          <input inputMode="decimal" value={slipStr} onChange={(e) => onSlippage(e.target.value)} />
          <input inputMode="decimal" placeholder={legBuy === undefined ? '—' : 'limit price'} value={priceStr} disabled={legBuy === undefined || !sellToken || !buyToken} onChange={(e) => onMinPrice(e.target.value)} />
        </div>
        {/* compact options row — keeps the primary CTA above the fold */}
        <div className="optrow">
          <button className="linkbtn" onClick={() => setShowAdvanced((a) => !a)}>Exact receive {showAdvanced ? '▴' : '▾'}</button>
          <button className="linkbtn" onClick={() => setShowSchedule((s) => !s)}>Scheduling {showSchedule ? '▴' : '▾'}</button>
          {(execRate !== null || spot.data != null) && (
            <button className="linkbtn" onClick={() => setShowDetails((d) => !d)}>Details {showDetails ? '▴' : '▾'}</button>
          )}
        </div>

        {showAdvanced && (
          <div className="params">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Min total receive ({sym(buyToken?.symbol)})</label>
              <input inputMode="decimal" value={recvStr} disabled={legBuy === undefined} onChange={(e) => onMinRecv(e.target.value)} />
            </div>
          </div>
        )}

        {showSchedule && (
          <div className="params">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={alignStart} onChange={(e) => setAlignStart(e.target.checked)} style={{ width: 'auto' }} />
                Align parts to the clock ({humanizeSeconds(partSeconds)} grid, UTC)
                <Info text="Snaps every part's start to round clock boundaries (e.g. :00, :05) in UTC, so many traders' orders line up in the same auctions — improving the chance of a peer-to-peer coincidence of wants." />
              </label>
            </div>
            <div className="field">
              <label>Skip buffer (extra windows) <Info text="Adds spare windows beyond your funded parts. If some intervals are skipped (price out of range), later windows still fill the rest — up to the buffer. You still sell the same amount; the schedule just runs longer." /></label>
              <select value={skipBufferPct} onChange={(e) => setSkipBufferPct(Number(e.target.value))}>
                <option value={0}>None</option>
                <option value={10}>+10%</option>
                <option value={20}>+20%</option>
                <option value={50}>+50%</option>
              </select>
            </div>
            <div className="field">
              <label>Trade window / part <Info text="How long each part is tradeable within its interval. 'Whole interval' = always tradeable (highest fill rate). A shorter window concentrates all aligned orders into the same minutes for better coincidence of wants — but a part may skip if it doesn't fill in time." /></label>
              <select value={effSpan.toString()} onChange={(e) => setSpanSeconds(BigInt(e.target.value))} disabled={spanOpts.length === 0}>
                <option value="0">Whole interval</option>
                {spanOpts.map((s) => <option key={s.toString()} value={s.toString()}>First {humanizeSeconds(s)}</option>)}
              </select>
            </div>
            <p className="hint" style={{ gridColumn: '1 / -1', margin: 0 }}>
              {alignStart ? `Parts begin on ${humanizeSeconds(partSeconds)} boundaries.` : 'Parts begin at deploy time.'}
              {bufferBps > 0 ? ` ${windows.toString()} windows for ${n.toString()} funded parts — extras absorb skipped intervals.` : ''}
              {effSpan > 0n ? ` Each part is tradeable only in its first ${humanizeSeconds(effSpan)} (concentrates CoWs; may skip if no fill).` : ''}
            </p>
          </div>
        )}

        {showDetails && sellToken && buyToken && (execRate !== null || spot.data != null) && (
          <div className="summary">
            <div className="kv"><span className="k">Current spot</span><span className="v clickable" onClick={toggleFlip} title="Click to flip">{fmtRate(spot.data ?? execRate, flip, sellToken.symbol, buyToken.symbol)}</span></div>
            <div className="kv"><span className="k">Est. execution (per part)</span><span className="v clickable" onClick={toggleFlip} title="Click to flip">{fmtRate(execRate, flip, sellToken.symbol, buyToken.symbol)}</span></div>
            <div className="kv"><span className="k">Min after slippage</span><span className="v clickable" onClick={toggleFlip} title="Click to flip">{fmtRate(minRate, flip, sellToken.symbol, buyToken.symbol)}</span></div>
            <div className="kv"><span className="k">All at once (full size)</span><span className="v clickable" onClick={toggleFlip} title="Click to flip">{fmtRate(fullRate, flip, sellToken.symbol, buyToken.symbol)}</span></div>
          </div>
        )}

        {/* RECIPIENT chip */}
        {!editRecipient ? (
          <div className="reciprow">
            <span className="hint">Recipient: <strong>{customReceiver === '' ? 'your wallet' : shortAddress(receiver ?? (customReceiver as Address), 5)}</strong></span>
            <button className="linkbtn" onClick={() => setEditRecipient(true)}>change</button>
          </div>
        ) : (
          <div className="field" style={{ marginTop: 8 }}>
            <label>Recipient (where bought tokens go)</label>
            <input className="mono" placeholder={owner ?? '0x…'} value={receiverStr} onChange={(e) => setReceiverStr(e.target.value)} spellCheck={false} />
            {!receiverValid && <span className="errors">Enter a valid non-zero address.</span>}
          </div>
        )}

        {tooShort && <p className="errors">⚠ {humanizeSeconds(partSeconds)} parts are too short for CoW solvers — use 5m or longer.</p>}
        {helperMissing && <p className="errors">Helper not deployed on {chain.name}.</p>}

        <button className="cta" disabled={ctaDisabled} onClick={() => { if (!ctaDisabled && plan) { setConfirmNow(BigInt(Math.floor(Date.now() / 1000))); setFrozenPlan(plan); setShowConfirm(true); } }}>{cta}</button>
      </div>

      {showConfirm && frozenPlan && sellToken && buyToken && owner && (
        <ConfirmModal chain={chain} plan={frozenPlan} sellToken={sellToken} buyToken={buyToken} owner={owner} onClose={() => { setShowConfirm(false); setConfirmNow(null); setFrozenPlan(null); }} />
      )}
    </>
  );
}

function bigMax(a: bigint, b: bigint): bigint { return a > b ? a : b; }
