'use client';

import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { useBytecode, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import type { ChainConfig, TokenInfo } from '../lib/chains';
import type { Plan } from '../lib/plan';
import { composableCowAbi, erc20Abi, safeProxyFactoryAbi } from '../lib/abi';
import { dispAmount, humanizeSeconds, shortAddress } from '../lib/format';
import { orderRecord, saveOrder } from '../lib/recovery';

const MANUAL_DEPLOY_PROMOTE_S = 30;

export function ConfirmModal({
  chain, plan, sellToken, buyToken, owner, onClose,
}: {
  chain: ChainConfig; plan: Plan; sellToken: TokenInfo; buyToken: TokenInfo; owner: Address; onClose: () => void;
}) {
  const safe = plan.safeAddress;
  const need = plan.approveAmount;
  const [elapsed, setElapsed] = useState(0); // seconds since approval (drives the 30s promotion)
  const approvedAt = useRef<number | null>(null);
  const custom = plan.twap.receiver.toLowerCase() !== owner.toLowerCase();

  // Persist the order to the DB only once it's REAL (the user approves). Saving on
  // mere review-open created throwaway "Not started" drafts. Idempotent upsert.
  const persist = () => { saveOrder(orderRecord({ chain, owner, plan, sell: sellToken, buy: buyToken })); };
  // register the appData document so the order's appData hash resolves (best-effort, idempotent)
  useEffect(() => { fetch('/api/app-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: chain.chainId }) }).catch(() => {}); }, [chain.chainId]);

  // Poll fast so approval/deploy are detected quickly (the modal is short-lived).
  const { data: allowanceRaw, refetch: refetchAllow } = useReadContract({
    address: sellToken.address, abi: erc20Abi, functionName: 'allowance', args: [owner, safe], query: { refetchInterval: 2500 },
  });
  const { data: balRaw } = useReadContract({ address: sellToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner], query: { refetchInterval: 8000 } });
  const { data: code, refetch: refetchCode } = useBytecode({ address: safe, query: { refetchInterval: 3000 } });
  const { data: orderLive, refetch: refetchOrder } = useReadContract({
    address: chain.composableCow, abi: composableCowAbi, functionName: 'singleOrders', args: [safe, plan.deployment.orderHash], query: { refetchInterval: 3000 },
  });

  const allowance = (allowanceRaw as bigint | undefined) ?? 0n;
  const balance = (balRaw as bigint | undefined) ?? 0n;
  const deployed = !!code && code !== '0x';
  const live = orderLive === true;

  const approve = useWriteContract();
  const deploy = useWriteContract();
  const approveWait = useWaitForTransactionReceipt({ hash: approve.data });
  const deployWait = useWaitForTransactionReceipt({ hash: deploy.data });

  // Approved = the moment the approve tx mines (instant, no poll wait) OR the
  // on-chain allowance already covers it (e.g. a pre-existing approval).
  const approved = allowance >= need || approveWait.isSuccess;
  const hasFunds = balance >= need;
  const approving = approve.isPending || approveWait.isLoading;
  const deploying = deploy.isPending || deployWait.isLoading;

  useEffect(() => { if (approveWait.isSuccess) refetchAllow(); }, [approveWait.isSuccess, refetchAllow]);
  useEffect(() => { if (deployWait.isSuccess) { refetchCode(); refetchOrder(); } }, [deployWait.isSuccess, refetchCode, refetchOrder]);
  useEffect(() => { if (approved && approvedAt.current === null) { approvedAt.current = Date.now(); persist(); } }, [approved]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1s ticker while we're waiting on the auto-deploy, so the 30s promotion is timely.
  useEffect(() => {
    if (!approved || deployed) return;
    const id = setInterval(() => setElapsed(approvedAt.current ? Math.floor((Date.now() - approvedAt.current) / 1000) : 0), 1000);
    return () => clearInterval(id);
  }, [approved, deployed]);

  // PUSH: the instant the allowance is detected, tell the server to deploy now
  // (instead of waiting for the polling relayer). Retries a few times if the
  // server's RPC hasn't yet seen the fresh allowance.
  useEffect(() => {
    if (!approved || deployed) return;
    let cancelled = false; let tries = 0;
    const go = async () => {
      if (cancelled) return;
      tries++;
      try {
        const r = await fetch('/api/deploy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ safe }) });
        const d = await r.json().catch(() => ({}));
        // 'not-found' = DB save hasn't landed yet; 'not-ready' = allowance not seen yet. Retry both.
        if (!cancelled && (d?.status === 'not-ready' || d?.status === 'not-found') && tries < 6) setTimeout(go, 3000);
      } catch { if (!cancelled && tries < 5) setTimeout(go, 3000); }
    };
    go();
    return () => { cancelled = true; };
  }, [approved, deployed, safe]);

  const stalled = approved && !deployed && !deploying && elapsed >= MANUAL_DEPLOY_PROMOTE_S;

  const onApprove = () => { persist(); approve.writeContract({ address: sellToken.address, abi: erc20Abi, functionName: 'approve', args: [safe, need] }); };
  const onDeploy = () => deploy.writeContract({ address: chain.safeProxyFactory, abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', args: [chain.safeSingleton, plan.deployment.initializer, 0n] });

  const cls = (done: boolean, on: boolean) => `step ${done ? 'done' : on ? 'on' : ''}`;
  const tlink = (sym: string, addr: string) => <a className="addr" href={`${chain.explorer}/token/${addr}`} target="_blank" rel="noreferrer">{sym}</a>;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Review TWAP</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>

        <div className="summary" style={{ marginTop: 0 }}>
          <div className="kv"><span className="k">Sell</span><span className="v">{dispAmount(plan.effectiveTotalSell, sellToken.decimals)} {tlink(sellToken.symbol, sellToken.address)}</span></div>
          <div className="kv"><span className="k">Receive (est.)</span><span className="v">≥ {dispAmount(plan.minPartLimit * plan.fundedParts, buyToken.decimals)} {tlink(buyToken.symbol, buyToken.address)}</span></div>
          <div className="kv"><span className="k">Schedule</span><span className="v">{plan.fundedParts.toString()} parts × {humanizeSeconds(plan.twap.t)}{plan.windows > plan.fundedParts ? ` (up to ${plan.windows.toString()} windows)` : ''} = {humanizeSeconds(plan.totalDuration)}</span></div>
          {(plan.aligned || plan.twap.span > 0n) && (
            <div className="kv"><span className="k">Windows</span><span className="v hint">{plan.aligned ? `aligned to ${humanizeSeconds(plan.twap.t)} marks (UTC)` : 'start at deploy'}{plan.twap.span > 0n ? ` · ${humanizeSeconds(plan.twap.span)} trade window/part` : ''}</span></div>
          )}
          <div className="kv"><span className="k">Per part</span><span className="v">{dispAmount(plan.partSellAmount, sellToken.decimals)} {tlink(sellToken.symbol, sellToken.address)} → ≥ {dispAmount(plan.minPartLimit, buyToken.decimals)} {tlink(buyToken.symbol, buyToken.address)}</span></div>
          <div className="kv"><span className="k">Recipient</span><span className="v mono"><a className="addr" href={`${chain.explorer}/address/${plan.twap.receiver}`} target="_blank" rel="noreferrer">{custom ? shortAddress(plan.twap.receiver, 5) : 'your wallet'}</a></span></div>
        </div>

        {/* progress stepper */}
        <div className="steps">
          <span className={cls(approved, approving)}>1 · Approve</span>
          <span className="sep">→</span>
          <span className={cls(deployed, approved && !deployed)}>2 · Deploy</span>
        </div>

        <p className="notice" style={{ marginTop: 6 }}>
          You <strong>approve once</strong>; your tokens move only when the Safe deploys, which happens
          <strong> automatically</strong> (gas-free for you).
          <br />
          <span className="hint">TWAP order Safe: <a className="addr" href={`${chain.explorer}/address/${safe}`} target="_blank" rel="noreferrer">{shortAddress(safe, 6)}</a></span>
        </p>

        {/* status / actions */}
        {live || deployed ? (
          <div className="notice" style={{ borderColor: 'var(--good)' }}>
            <div className="step-done">✓ {live ? 'TWAP live — parts fill on schedule.' : 'Safe deployed — starting…'}</div>
            <div className="spacer" />
            <a href={`${chain.cowExplorer}/address/${safe}`} target="_blank" rel="noreferrer">Track on CoW Explorer</a>
            {' · '}<a href={`https://app.safe.global/home?safe=${chain.safeAppPrefix}:${safe}`} target="_blank" rel="noreferrer">Open in Safe</a>
            {' · '}<a href="/orders">My orders</a>
          </div>
        ) : !hasFunds ? (
          <button className="cta" disabled>Insufficient {sellToken.symbol} balance</button>
        ) : !approved ? (
          <button className="cta" onClick={onApprove} disabled={approving}>
            {approving ? 'Approving…' : `Approve ${dispAmount(need, sellToken.decimals)} ${sellToken.symbol} & start`}
          </button>
        ) : deploying ? (
          <button className="cta" disabled>Deploying your Safe…</button>
        ) : stalled ? (
          <>
            <button className="cta" onClick={onDeploy}>Deploy now</button>
            <p className="hint center">Auto-deploy is taking longer than usual ({elapsed}s) — deploy it yourself (small gas fee) to start immediately.</p>
          </>
        ) : (
          <>
            <button className="cta" disabled>✓ Approved — auto-deploying…{elapsed ? ` ${elapsed}s` : ''}</button>
            <button className="linkbtn" style={{ display: 'block', margin: '8px auto 0' }} onClick={onDeploy}>Deploy it yourself instead</button>
          </>
        )}

        {(approve.error || deploy.error) && <p className="errors">{(approve.error || deploy.error)?.message?.slice(0, 160)}</p>}
      </div>
    </div>
  );
}
