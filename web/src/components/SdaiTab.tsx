'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits, maxUint256, parseUnits, type Address, type Hex } from 'viem';
import { useAccount, useBytecode, useChainId, usePublicClient, useReadContract, useSwitchChain, useWalletClient } from 'wagmi';
import { mainnet, gnosis } from 'wagmi/chains';
import { TokenPicker } from './TokenPicker';
import { getChainConfig } from '../lib/chains';
import { erc20Abi } from '../lib/abi';
import { fetchQuote } from '../lib/quote';
import { GPV2_ORDER_TYPES } from '../lib/carrier';
import { dispAmount } from '../lib/format';
import { useToken } from '../lib/useToken';
import { SdaiClaim, saveWithdrawal } from './SdaiClaim';
import { buildPermitHook, detectPermit, splitSig, type PermitHook } from '../lib/sdaiPermit';
import {
  buildForwardPlan, returnToMainnetCalldata,
  USDS, SDAI, RETURN_ROUTER, REVERSE_MIN_XDAI, SDAI_PERMIT_DOMAIN, SDAI_PERMIT_TYPES,
} from '../lib/sdai';

const MAINNET_CFG = getChainConfig(mainnet.id)!;
const NONCES_ABI = [{ type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
const YEAR = 31_557_600;
// Fallbacks until /api/sdai-rate responds (price/share and APY barely move).
const DEFAULT_PRICE = 1_246_317_128_565_145_906n;
const DEFAULT_APY = 0.045;

function randomSaltNonce(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return BigInt('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));
}
async function postCow(body: unknown) {
  const r = await fetch('/api/cow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
function parseAmount(str: string, decimals: number): bigint | null {
  if (!str) return null;
  try { return parseUnits(str, decimals); } catch { return null; }
}

/** sDAI shares → live USDS value, ticking up in real time at the savings rate.
 *  Rebased whenever the on-chain shares/price refresh, so it stays accurate. */
function LiveUsds({ shares, pricePerShare, apy, decimals = 12, big }: { shares: bigint; pricePerShare: bigint; apy: number; decimals?: number; big?: boolean }) {
  const base = (Number(shares) / 1e18) * (Number(pricePerShare) / 1e18); // USDS at t0
  const baseAt = useRef<number>(0);
  const [, force] = useState(0);
  // rebase the animation clock when inputs change (new balance / fresh price)
  useEffect(() => { baseAt.current = performance.now(); force((n) => n + 1); }, [shares, pricePerShare, apy]);
  useEffect(() => {
    let raf = 0;
    const tick = () => { force((n) => (n + 1) % 1_000_000); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const elapsed = baseAt.current ? (performance.now() - baseAt.current) / 1000 : 0;
  const v = base * Math.pow(1 + apy, elapsed / YEAR);
  const [int, dec = ''] = v.toFixed(decimals).split('.');
  const lead = dec.slice(0, 2), rest = dec.slice(2);
  // tabular-nums → every digit is the same width, so the value can tick without
  // changing its total width and shoving neighboring text around (no flicker).
  return (
    <span className="live-usds" style={{ fontVariantNumeric: 'tabular-nums', ...(big ? { fontSize: 22, fontWeight: 600 } : {}) }}>
      ${int}.{lead}<span style={{ opacity: 0.55, fontSize: '0.72em' }}>{rest}</span>
    </span>
  );
}

type Transfer = {
  uid: string; owner: string; mainnetSafe: string; gnosisSafe: string;
  saltNonce: string; sellToken: string; sellAmount: string; createdAt?: number; finalizedAt?: number | null;
};

export function SdaiTab({ tabs }: { tabs?: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const ethClient = usePublicClient({ chainId: mainnet.id });
  const gnoClient = usePublicClient({ chainId: gnosis.id });

  // EOA gate: a smart-contract wallet may not control the same address on Gnosis.
  const bytecode = useBytecode({ address, chainId: mainnet.id, query: { enabled: !!address } });
  const isSmartWallet = !!bytecode.data && bytecode.data !== '0x';

  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  // Deposit receive unit: USDS (the CoW trade output) or sDAI (what it converts to).
  const [recvUnit, setRecvUnit] = useState<'USDS' | 'sDAI'>('USDS');
  // Withdraw send unit on the Gnosis side: sDAI (shares held) or xDAI (redeemed value).
  const [wdUnit, setWdUnit] = useState<'sDAI' | 'xDAI'>('sDAI');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // sDAI savings rate + price/share (for the live USDS value)
  const [rate, setRate] = useState<{ pricePerShare: bigint; apy: number }>({ pricePerShare: DEFAULT_PRICE, apy: DEFAULT_APY });
  useEffect(() => {
    fetch('/api/sdai-rate').then((r) => r.json()).then((d) => { if (d?.pricePerShare) setRate({ pricePerShare: BigInt(d.pricePerShare), apy: Number(d.apy) || DEFAULT_APY }); }).catch(() => {});
  }, []);

  // ── selected mainnet token (deposit send / withdraw receive is fixed USDS) ──
  const [sellAddr, setSellAddr] = useState<string>(MAINNET_CFG.tokens[0]?.address ?? '');
  const { token: sellToken } = useToken(MAINNET_CFG, sellAddr);
  const [amountStr, setAmountStr] = useState('');
  const [slipPct, setSlipPct] = useState('0.5');
  const [recipient, setRecipient] = useState('');

  // balances (always shown, both chains)
  const { data: ethBalRaw } = useReadContract({
    address: sellToken?.address, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined,
    chainId: mainnet.id, query: { enabled: !!sellToken && !!address, refetchInterval: 15000 },
  });
  const ethBal = (ethBalRaw as bigint | undefined) ?? 0n;
  const { data: sdaiBalRaw } = useReadContract({
    address: SDAI as Address, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined,
    chainId: gnosis.id, query: { enabled: !!address, refetchInterval: 15000 },
  });
  const sdaiBal = (sdaiBalRaw as bigint | undefined) ?? 0n;
  const sdaiUsds = (Number(sdaiBal) / 1e18) * (Number(rate.pricePerShare) / 1e18);

  // deposit amounts / quote
  const depAmount = sellToken ? parseAmount(amountStr, sellToken.decimals) : null;
  const [quoteUsds, setQuoteUsds] = useState<bigint | null>(null);
  const [quoteFee, setQuoteFee] = useState<bigint | null>(null); // fee in sell token, baked into the quote
  const depKey = depAmount?.toString();
  useEffect(() => {
    let live = true;
    if (mode !== 'deposit' || !sellToken || !depAmount || depAmount <= 0n) { setQuoteUsds(null); setQuoteFee(null); return; }
    const owner = (address ?? '0x0000000000000000000000000000000000000001') as Address;
    // Quote WITH the Safe-deploy post-hook (the dominant ~500k gas), so the shown
    // receive + fee match what the order actually commits to — a no-hook quote is
    // ~$0.15+ too optimistic on small transfers.
    const draft = buildForwardPlan({ owner, sellToken: sellToken.address, sellAmount: depAmount, minBuyUsds: 0n, validTo: Math.floor(Date.now() / 1000) + 1800, saltNonce: 0n });
    fetchQuote({ chainId: mainnet.id, sellToken: sellToken.address, buyToken: USDS as Address, from: owner, sellAmount: depAmount, appData: draft.appDataJson })
      .then((q) => { if (live) { setQuoteUsds(q.buyAmount); setQuoteFee(q.feeAmount); } }).catch(() => { if (live) { setQuoteUsds(null); setQuoteFee(null); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sellToken?.address, depKey, address]);
  const slipFrac = 10_000 - Math.round((Number(slipPct) || 0) * 100);
  const depMinReceive = quoteUsds !== null ? (quoteUsds * BigInt(slipFrac)) / 10_000n : null;

  // withdraw amount — entered in wdUnit (sDAI shares or xDAI value), reduced to sDAI shares
  const wdInput = parseAmount(amountStr, 18);
  const sdaiToXdai = (s: bigint) => (s * rate.pricePerShare) / 10n ** 18n;
  const xdaiToSdai = (x: bigint) => (x * 10n ** 18n) / rate.pricePerShare;
  const wdShares = wdInput == null ? null : (wdUnit === 'sDAI' ? wdInput : xdaiToSdai(wdInput));
  const wdBal = wdUnit === 'sDAI' ? sdaiBal : sdaiToXdai(sdaiBal); // send balance in the chosen unit
  // shares floor for the 10 xDAI bridge minimum, +0.5% buffer so the on-chain
  // ERC-4626 round-down + any price drift can't leave the redeem just under 10 xDAI.
  const minSdai = (xdaiToSdai(REVERSE_MIN_XDAI) * 1005n) / 1000n;
  const minInUnit = wdUnit === 'sDAI' ? minSdai : REVERSE_MIN_XDAI;

  const usdsToSdai = (u: bigint) => (u * 10n ** 18n) / rate.pricePerShare;

  // probe whether the selected sell token supports a gasless permit (for the label)
  const [permitOk, setPermitOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true; setPermitOk(null);
    if (!ethClient || !sellToken) return;
    detectPermit(ethClient, sellToken.address, mainnet.id).then((d) => { if (live) setPermitOk(!!d); }).catch(() => { if (live) setPermitOk(false); });
    return () => { live = false; };
  }, [ethClient, sellToken?.address]);

  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const refreshTransfers = useCallback(async () => {
    if (!address) { setTransfers([]); return; }
    try { const r = await fetch(`/api/sdai?owner=${address}`); setTransfers((await r.json()).transfers ?? []); } catch { /* ignore */ }
  }, [address]);
  useEffect(() => { refreshTransfers(); }, [refreshTransfers]);

  const flip = () => {
    const next = mode === 'deposit' ? 'withdraw' : 'deposit';
    setMode(next); setStatus(null); setErr(null);
    // On the return, default the amount to the full balance (in the current unit).
    setAmountStr(next === 'withdraw' && sdaiBal > 0n
      ? formatUnits(wdUnit === 'sDAI' ? sdaiBal : sdaiToXdai(sdaiBal), 18)
      : '');
  };

  // Toggle the withdraw send unit (sDAI ⇄ xDAI), converting the entered amount.
  const toggleWdUnit = () => {
    const cur = parseAmount(amountStr, 18);
    const nu = wdUnit === 'sDAI' ? 'xDAI' : 'sDAI';
    if (cur != null) {
      const shares = wdUnit === 'sDAI' ? cur : xdaiToSdai(cur);
      setAmountStr(formatUnits(nu === 'sDAI' ? shares : sdaiToXdai(shares), 18));
    }
    setWdUnit(nu);
  };

  // Keep the wallet network in sync with the direction: deposit sends from
  // Ethereum, withdraw from Gnosis. Fires on tab entry (mount) and on flip — but
  // NOT on manual chain changes (chainId isn't a dep), so it won't fight the user.
  useEffect(() => {
    if (!isConnected) return;
    const target = mode === 'deposit' ? mainnet.id : gnosis.id;
    if (chainId !== target) switchChain({ chainId: target });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isConnected]);

  async function doForward() {
    if (!walletClient || !ethClient || !address || !sellToken || !depAmount) return;
    if (chainId !== mainnet.id) { switchChain({ chainId: mainnet.id }); return; }
    setBusy(true); setErr(null); setStatus('Quoting…');
    try {
      const validTo = Math.floor(Date.now() / 1000) + 1800;
      const saltNonce = randomSaltNonce();

      // Approval: if the relayer isn't already approved, prefer a GASLESS EIP-2612
      // permit (signed, carried as an appData pre-hook) exactly like the CoW UI; only
      // fall back to an on-chain approve for tokens without permit.
      const relayer = MAINNET_CFG.vaultRelayer;
      let permitHook: PermitHook | undefined;
      const allowance = await ethClient.readContract({ address: sellToken.address, abi: erc20Abi, functionName: 'allowance', args: [address, relayer] }) as bigint;
      if (allowance < depAmount) {
        setStatus('Sign a gasless approval (permit)…');
        permitHook = (await buildPermitHook({ client: ethClient, walletClient, token: sellToken.address, owner: address, chainId: mainnet.id })) ?? undefined;
        if (!permitHook) {
          setStatus('One-time CoW approval on Ethereum…');
          const h = await walletClient.writeContract({ address: sellToken.address, abi: erc20Abi, functionName: 'approve', args: [relayer, maxUint256], account: address, chain: mainnet });
          await ethClient.waitForTransactionReceipt({ hash: h });
        }
      }

      // Quote WITH the hooks so buyMin covers the 500k-gas Safe deploy (+ any permit)
      // — a no-hook quote overstates proceeds → unfillable order. appData is buyMin-independent.
      setStatus('Quoting…');
      const draft = buildForwardPlan({ owner: address, sellToken: sellToken.address, sellAmount: depAmount, minBuyUsds: 0n, validTo, saltNonce, permitHook });
      const q = await fetchQuote({ chainId: mainnet.id, sellToken: sellToken.address, buyToken: USDS as Address, from: address, sellAmount: depAmount, appData: draft.appDataJson });
      const buyMin = (q.buyAmount * BigInt(10_000 - Math.round((Number(slipPct) || 0) * 100))) / 10_000n;
      if (buyMin <= 0n) throw new Error('amount too small to cover the bridge/deploy cost');

      const plan = buildForwardPlan({ owner: address, sellToken: sellToken.address, sellAmount: depAmount, minBuyUsds: buyMin, validTo, saltNonce, permitHook });
      setStatus('Sign your order (one signature)…');
      const sig = await walletClient.signTypedData({
        account: address, domain: { name: 'Gnosis Protocol', version: 'v2', chainId: mainnet.id, verifyingContract: MAINNET_CFG.cowSettlement },
        types: GPV2_ORDER_TYPES, primaryType: 'Order',
        message: { ...plan.order, sellAmount: depAmount, buyAmount: buyMin, validTo: BigInt(validTo), feeAmount: 0n } as never,
      });
      await postCow({ chainId: mainnet.id, kind: 'appData', appDataHash: plan.appDataHash, fullAppData: plan.appDataJson });
      const os = await postCow({ chainId: mainnet.id, kind: 'order', order: { ...plan.order, signingScheme: 'eip712', signature: sig, from: address } });
      if (!os.ok || !os.uid) throw new Error('order rejected: ' + (os.raw || os.status));
      await fetch('/api/sdai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'record', transfer: {
        uid: plan.uid, owner: address, mainnetSafe: plan.mainnetSafe, gnosisSafe: plan.gnosisSafe,
        mainnetSetup: plan.mainnetSetup, gnosisSetup: plan.gnosisSetup, saltNonce: plan.saltNonce,
        sellToken: sellToken.address, sellAmount: depAmount.toString(),
      } }) });
      setStatus('✅ Order placed. On fill, USDS bridges to Gnosis (~26 min), then finalizes into sDAI automatically.');
      setAmountStr(''); refreshTransfers();
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  async function doReverse() {
    if (!walletClient || !gnoClient || !address || !wdShares) return;
    if (chainId !== gnosis.id) { switchChain({ chainId: gnosis.id }); return; }
    setBusy(true); setErr(null); setStatus('Preparing…');
    try {
      const recv = (recipient.trim() || address) as Address;
      const nonce = await gnoClient.readContract({ address: SDAI as Address, abi: NONCES_ABI, functionName: 'nonces', args: [address] }) as bigint;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      setStatus('Sign the sDAI permit…');
      const sig = await walletClient.signTypedData({
        account: address, domain: SDAI_PERMIT_DOMAIN, types: SDAI_PERMIT_TYPES, primaryType: 'Permit',
        message: { owner: address, spender: RETURN_ROUTER, value: wdShares, nonce, deadline } as never,
      });
      const { v, r, s } = splitSig(sig);
      const data = returnToMainnetCalldata({ amount: wdShares, mainnetRecipient: recv, deadline, v, r, s });
      setStatus('Submitting return…');
      const h = await walletClient.sendTransaction({ account: address, chain: gnosis, to: RETURN_ROUTER as Address, data });
      await gnoClient.waitForTransactionReceipt({ hash: h });
      saveWithdrawal(address, h);
      setStatus('✅ Sent to the bridge. Once 4 validators sign (~a few min), claim your USDS on Ethereum in the "Claim on Ethereum" panel below.');
      setAmountStr('');
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  // ── CTA ──
  const deposit = mode === 'deposit';
  let cta: string; let disabled = false;
  if (!isConnected) { cta = 'Connect wallet'; disabled = true; }
  else if (isSmartWallet) { cta = 'EOA required'; disabled = true; }
  else if (busy) { cta = status ?? 'Working…'; disabled = true; }
  else if (deposit) {
    if (!sellToken) { cta = 'Select a token'; disabled = true; }
    else if (!depAmount || depAmount <= 0n) { cta = 'Enter an amount'; disabled = true; }
    else if (ethBal < depAmount) { cta = `Insufficient ${sellToken.symbol}`; disabled = true; }
    else if (chainId !== mainnet.id) { cta = 'Switch to Ethereum'; }
    else cta = 'Deposit → sDAI on Gnosis';
  } else {
    if (!wdShares || wdShares <= 0n) { cta = 'Enter an amount'; disabled = true; }
    else if (sdaiBal < wdShares) { cta = 'Insufficient sDAI'; disabled = true; }
    else if (wdShares < minSdai) { cta = `Min ~${dispAmount(minInUnit, 18)} ${wdUnit}`; disabled = true; }
    else if (chainId !== gnosis.id) { cta = 'Switch to Gnosis'; }
    else cta = 'Return → USDS on Ethereum';
  }

  return (
    <>
      <div className="widget">
        {tabs}

        {isSmartWallet && (
          <p className="errors" style={{ marginTop: 8 }}>
            This flow requires an <strong>EOA</strong> (regular wallet). Your account is a smart-contract wallet, which may
            not control the same address on Gnosis Chain — bridged funds could be stranded. Connect an EOA to continue.
          </p>
        )}

        {/* SEND row */}
        <div className="token-row">
          <div className="label">
            <span>{deposit ? 'Send (Ethereum)' : 'Send (Gnosis)'}</span>
            {address && <span>Balance {deposit ? dispAmount(ethBal, sellToken?.decimals ?? 18) : `${dispAmount(wdBal, 18)} ${wdUnit}`}</span>}
          </div>
          <div className="body">
            <input className="amount-input" inputMode="decimal" placeholder="0" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
            {deposit
              ? <TokenPicker chain={MAINNET_CFG} value={sellAddr} onChange={setSellAddr} owner={address} />
              : <button className="tag" style={{ padding: '10px 14px', cursor: 'pointer' }} title="Switch unit (sDAI ⇄ xDAI)" onClick={toggleWdUnit}>{wdUnit} ⇄</button>}
          </div>
          {address && (deposit ? ethBal > 0n : sdaiBal > 0n) && (
            <div className="sub">
              <span>{!deposit ? <>≈ <LiveUsds shares={wdShares && wdShares > 0n ? wdShares : sdaiBal} pricePerShare={rate.pricePerShare} apy={rate.apy} decimals={6} /> USDS</> : ''}</span>
              <button className="maxbtn" onClick={() => setAmountStr(formatUnits(deposit ? ethBal : wdBal, deposit ? (sellToken?.decimals ?? 18) : 18))}>MAX</button>
            </div>
          )}
        </div>

        {/* FLIP */}
        <div className="swap-divider"><button onClick={flip} title="Flip direction">↓</button></div>

        {/* RECEIVE row */}
        <div className="token-row">
          <div className="label">
            <span>{deposit ? 'Receive on Gnosis (estimated)' : 'Receive on Ethereum (estimated)'}</span>
            {deposit && address && (
              recvUnit === 'USDS'
                ? <span title={`${dispAmount(sdaiBal, 18)} sDAI`}>Balance <LiveUsds shares={sdaiBal} pricePerShare={rate.pricePerShare} apy={rate.apy} /></span>
                : <span title={`≈ $${sdaiUsds.toFixed(2)} USDS`}>Balance {dispAmount(sdaiBal, 18)} sDAI</span>
            )}
          </div>
          <div className="body">
            <input className="amount-input" placeholder="0" disabled
              value={deposit
                ? (quoteUsds !== null ? dispAmount(recvUnit === 'USDS' ? quoteUsds : usdsToSdai(quoteUsds), 18) : '')
                : (wdShares ? dispAmount((wdShares * rate.pricePerShare) / 10n ** 18n, 18) : '')} />
            {deposit
              ? <button className="tag" style={{ padding: '10px 14px', cursor: 'pointer' }} title="Switch unit (USDS ⇄ sDAI)" onClick={() => setRecvUnit((u) => (u === 'USDS' ? 'sDAI' : 'USDS'))}>{recvUnit} ⇄</button>
              : <div className="tag" style={{ padding: '10px 14px' }}>USDS</div>}
          </div>
          <div className="sub"><span>{deposit ? 'via USDS → xDAI (1:1) → sDAI · minus a 0.01 xDAI finalize tip' : 'via xDAI bridge → USDS on mainnet'}</span><span></span></div>
        </div>

        {/* mode-specific controls */}
        {deposit ? (
          <div className="field" style={{ marginTop: 8 }}>
            <label>Max slippage %</label>
            <input inputMode="decimal" value={slipPct} onChange={(e) => setSlipPct(e.target.value)} />
          </div>
        ) : (
          <div className="field" style={{ marginTop: 8 }}>
            <label>Mainnet recipient (USDS) · min ~{dispAmount(minInUnit, 18)} {wdUnit}</label>
            <input className="mono" placeholder={address ?? '0x…'} value={recipient} onChange={(e) => setRecipient(e.target.value)} spellCheck={false} />
          </div>
        )}

        {deposit && quoteFee !== null && quoteUsds !== null && sellToken && (
          <div className="summary" style={{ marginTop: 8 }}>
            <div className="kv"><span className="k">Fee (incl. network cost)</span><span className="v">{dispAmount(quoteFee, sellToken.decimals)} {sellToken.symbol}</span></div>
            <div className="kv"><span className="k">Est. receive on Gnosis</span><span className="v">{dispAmount(recvUnit === 'USDS' ? quoteUsds : usdsToSdai(quoteUsds), 18)} {recvUnit}</span></div>
            {depMinReceive !== null && <div className="kv"><span className="k">Min received ({slipPct}% slippage)</span><span className="v">{dispAmount(recvUnit === 'USDS' ? depMinReceive : usdsToSdai(depMinReceive), 18)} {recvUnit}</span></div>}
            <div className="kv"><span className="k">Approval</span><span className="v">{permitOk === false ? 'one-time on-chain approve' : 'gasless permit (no approve tx)'}</span></div>
          </div>
        )}

        <p className="hint" style={{ marginTop: 4 }}>
          {deposit
            ? 'One signature sells your token for USDS to a deterministic Safe you own; on fill it bridges to Gnosis and anyone finalizes it into sDAI for you (0.01 xDAI tip). Nothing is stranded if a hook is skipped.'
            : 'One sDAI permit redeems to native xDAI and bridges it to USDS on Ethereum (floor 10 xDAI). After ~a few min (validator signing) you submit the claim yourself in the "Claim on Ethereum" panel below — permissionless, funds always go to you.'}
        </p>

        {deposit && quoteUsds !== null && quoteUsds > 0n && quoteUsds < 50n * 10n ** 18n && (
          <p className="hint" style={{ color: 'var(--warn)' }}>⚠ Small transfer: a fixed ~$1–2 Safe-deploy + bridge gas applies, so this is a poor rate under ~$100.</p>
        )}
        {status && <p className="hint" style={{ color: 'var(--good)' }}>{status}</p>}
        {err && <p className="errors">{err}</p>}

        <button className="cta" disabled={disabled} onClick={deposit ? doForward : doReverse}>{cta}</button>
      </div>

      {address && <SdaiClaim owner={address} chainId={chainId} />}

      {transfers.length > 0 && (
        <div className="widget" style={{ marginTop: 14 }}>
          <h3 style={{ margin: '0 0 10px' }}>Your transfers</h3>
          {transfers.map((t) => (
            <div key={t.uid} style={{ padding: '8px 0', borderTop: '1px solid var(--line, #0001)' }}>
              <div className="kv" style={{ marginBottom: 4 }}>
                <span className="k mono">{t.gnosisSafe.slice(0, 12)}…</span>
                <span className="v">{t.finalizedAt ? '✅ sDAI on Gnosis' : '⏳ bridging / finalizing'}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 13 }}>
                <a href={`https://explorer.cow.fi/orders/${t.uid}`} target="_blank" rel="noreferrer">CoW order ↗</a>
                <a href={`https://etherscan.io/address/${t.mainnetSafe}`} target="_blank" rel="noreferrer">Mainnet Safe ↗</a>
                <a href="https://bridge.gnosischain.com/" target="_blank" rel="noreferrer">Bridge ↗</a>
                <a href={`https://gnosisscan.io/address/${t.gnosisSafe}`} target="_blank" rel="noreferrer">Gnosis Safe ↗</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
