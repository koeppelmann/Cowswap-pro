'use client';

import { useEffect, useMemo, useState } from 'react';
import { maxUint256, type Address } from 'viem';
import { useBytecode, useReadContract, useWaitForTransactionReceipt, useWalletClient, useWriteContract } from 'wagmi';
import type { ChainConfig, TokenInfo } from '../lib/chains';
import type { Plan } from '../lib/plan';
import { buildTwapCarrier, GPV2_ORDER_TYPES } from '../lib/carrier';
import { erc20Abi } from '../lib/abi';
import { dispAmount, humanizeSeconds, shortAddress } from '../lib/format';
import { orderRecord, saveOrder } from '../lib/recovery';

type Phase = 'review' | 'approving' | 'signing' | 'submitting' | 'submitted' | 'error';

export function ConfirmModal({
  chain, plan, sellToken, buyToken, owner, onClose,
}: {
  chain: ChainConfig; plan: Plan; sellToken: TokenInfo; buyToken: TokenInfo; owner: Address; onClose: () => void;
}) {
  const safe = plan.safeAddress;
  const need = plan.carrierSellAmount; // the carrier sells the full input, in-kind
  const custom = plan.twap.receiver.toLowerCase() !== owner.toLowerCase();
  const { data: walletClient } = useWalletClient();

  const [phase, setPhase] = useState<Phase>('review');
  const [err, setErr] = useState<string | null>(null);
  const [submittedUid, setSubmittedUid] = useState<string | null>(null);
  const carrier = useMemo(() => {
    try { return buildTwapCarrier({ plan, owner, chain, validTo: Math.floor(Date.now() / 1000) + 3 * 3600 }); }
    catch { return null; }
  }, [plan, owner, chain]);

  // register the twap-parts appData document (best-effort, idempotent)
  useEffect(() => { fetch('/api/app-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: chain.chainId }) }).catch(() => {}); }, [chain.chainId]);

  // one-time allowance to the CoW vault relayer (same as cowswap.exchange) — NOT to the Safe
  const { data: allowanceRaw, refetch: refetchAllow } = useReadContract({
    address: sellToken.address, abi: erc20Abi, functionName: 'allowance', args: [owner, chain.vaultRelayer], query: { refetchInterval: 2500 },
  });
  const { data: balRaw } = useReadContract({ address: sellToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner], query: { refetchInterval: 8000 } });
  const { data: code } = useBytecode({ address: safe, query: { refetchInterval: 4000, enabled: phase === 'submitted' } });

  const allowance = (allowanceRaw as bigint | undefined) ?? 0n;
  const balance = (balRaw as bigint | undefined) ?? 0n;
  const approved = allowance >= need;
  const hasFunds = balance >= need;
  const deployed = !!code && code !== '0x';
  // Deploy + arm happen atomically in the carrier's post-interaction, so the Safe
  // existing on-chain means the balance-sized TWAP is live. (The exact order hash
  // isn't known until deploy, so we can't poll singleOrders here.)
  const live = deployed;

  const approve = useWriteContract();
  const approveWait = useWaitForTransactionReceipt({ hash: approve.data });
  useEffect(() => { if (approveWait.isSuccess) { refetchAllow(); setPhase('review'); } }, [approveWait.isSuccess, refetchAllow]);
  // A rejected/failed approval must not strand the modal in 'approving'.
  useEffect(() => { if (approve.error && phase === 'approving') setPhase('review'); }, [approve.error, phase]);

  const onApprove = () => { setPhase('approving'); approve.writeContract({ address: sellToken.address, abi: erc20Abi, functionName: 'approve', args: [chain.vaultRelayer, maxUint256] }); };

  async function onSign() {
    if (!walletClient) return;
    setErr(null);
    try {
      setPhase('signing');
      // Build with a FRESH validTo at sign time (the modal may have been open a
      // while); never sign an already-expired order.
      const c = buildTwapCarrier({ plan, owner, chain, validTo: Math.floor(Date.now() / 1000) + 3 * 3600 });
      const sig = await walletClient.signTypedData({
        account: owner,
        domain: { name: 'Gnosis Protocol', version: 'v2', chainId: chain.chainId, verifyingContract: chain.cowSettlement },
        types: GPV2_ORDER_TYPES, primaryType: 'Order',
        message: { ...c.order, sellAmount: BigInt(c.order.sellAmount), buyAmount: BigInt(c.order.buyAmount), validTo: BigInt(c.order.validTo), feeAmount: 0n } as never,
      });
      setPhase('submitting');
      // 1) register both appData docs (carrier post-hook + twap parts), then 2) post the carrier
      await fetch('/api/cow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: chain.chainId, kind: 'appData', appDataHash: c.appDataHash, fullAppData: c.appDataJson }) });
      const r = await (await fetch('/api/cow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: chain.chainId, kind: 'order', order: { ...c.order, signingScheme: 'eip712', signature: sig, from: owner } }) })).json();
      if (!r.ok || !r.uid) throw new Error('orderbook rejected the carrier: ' + (r.raw || r.status));
      saveOrder(orderRecord({ chain, owner, plan, sell: sellToken, buy: buyToken }));
      setSubmittedUid(c.uid);
      setPhase('submitted');
    } catch (e) { setErr((e as Error).message?.slice(0, 200) || 'failed'); setPhase('error'); }
  }

  const tlink = (sym: string, addr: string) => <a className="addr" href={`${chain.explorer}/token/${addr}`} target="_blank" rel="noreferrer">{sym}</a>;
  const exOrder = (uid: string) => `${chain.cowExplorer}/orders/${uid}`;
  const exAddr = (a: string) => `${chain.cowExplorer}/address/${a}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{phase === 'submitted' ? 'TWAP submitted' : 'Review TWAP'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>

        <div className="summary" style={{ marginTop: 0 }}>
          <div className="kv"><span className="k">Sell</span><span className="v">{dispAmount(plan.carrierSellAmount, sellToken.decimals)} {tlink(sellToken.symbol, sellToken.address)}</span></div>
          <div className="kv"><span className="k">Receive (est.)</span><span className="v">≥ {dispAmount(plan.minPartLimit * plan.fundedParts, buyToken.decimals)} {tlink(buyToken.symbol, buyToken.address)}</span></div>
          <div className="kv"><span className="k">Schedule</span><span className="v">{plan.fundedParts.toString()} parts × {humanizeSeconds(plan.twap.t)}{plan.windows > plan.fundedParts ? ` (up to ${plan.windows.toString()} windows)` : ''} = {humanizeSeconds(plan.totalDuration)}</span></div>
          <div className="kv"><span className="k">Per part</span><span className="v">{dispAmount(plan.partSellAmount, sellToken.decimals)} {tlink(sellToken.symbol, sellToken.address)} → ≥ {dispAmount(plan.minPartLimit, buyToken.decimals)} {tlink(buyToken.symbol, buyToken.address)}</span></div>
          <div className="kv"><span className="k">Recipient</span><span className="v mono"><a className="addr" href={exAddr(plan.twap.receiver)} target="_blank" rel="noreferrer">{custom ? shortAddress(plan.twap.receiver, 5) : 'your wallet'}</a></span></div>
        </div>

        {phase !== 'submitted' ? (
          <>
            <p className="notice" style={{ marginTop: 6 }}>
              <strong>One signature.</strong> A CoW order moves your {sellToken.symbol} to a fresh single-use Safe that you own; the same fill deploys the Safe and arms the TWAP — no separate deploy tx.
              <br />
              <span className="hint">Your TWAP Safe: <a className="addr" href={exAddr(safe)} target="_blank" rel="noreferrer">{shortAddress(safe, 6)}</a></span>
            </p>

            {!carrier ? (
              <button className="cta" disabled>TWAP carrier not available on {chain.name}</button>
            ) : !hasFunds ? (
              <button className="cta" disabled>Insufficient {sellToken.symbol} balance</button>
            ) : !approved ? (
              <button className="cta" onClick={onApprove} disabled={phase === 'approving'}>
                {phase === 'approving' ? 'Approving…' : `Approve ${sellToken.symbol} (one-time)`}
              </button>
            ) : (
              <button className="cta" onClick={onSign} disabled={phase === 'signing' || phase === 'submitting'}>
                {phase === 'signing' ? 'Confirm in wallet…' : phase === 'submitting' ? 'Submitting…' : 'Sign & start TWAP'}
              </button>
            )}
          </>
        ) : (
          <div className="notice" style={{ borderColor: 'var(--good)' }}>
            <div className="step-done">✓ Order signed &amp; submitted — solvers will deploy your Safe and run the TWAP.</div>
            <div className="steps" style={{ marginTop: 10 }}>
              <span className="step done">1 · Carrier order</span><span className="sep">→</span>
              <span className={`step ${deployed ? 'done' : 'on'}`}>2 · Safe {deployed ? 'deployed' : 'deploying…'}</span><span className="sep">→</span>
              <span className={`step ${live ? 'done' : ''}`}>3 · TWAP {live ? 'live' : '…'}</span>
            </div>
            <div className="spacer" style={{ marginTop: 8 }} />
            <div className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <a href={exOrder(submittedUid ?? carrier!.uid)} target="_blank" rel="noreferrer">↗ Carrier order (funds the Safe)</a>
              <a href={exAddr(safe)} target="_blank" rel="noreferrer">↗ Your TWAP Safe + parts</a>
              <a href={`https://app.safe.global/home?safe=${chain.safeAppPrefix}:${safe}`} target="_blank" rel="noreferrer">↗ Open in Safe</a>
              <a href="/orders">↗ My orders</a>
            </div>
          </div>
        )}

        {(err || approve.error) && <p className="errors">{err || approve.error?.message?.slice(0, 160)}</p>}
      </div>
    </div>
  );
}
