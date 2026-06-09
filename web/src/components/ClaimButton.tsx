'use client';

import { useState } from 'react';
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import type { Address } from 'viem';
import { safeAbi } from '../lib/abi';
import { buildExec, erc20TransferData } from '../lib/safeExec';
import { dispAmount } from '../lib/format';

/**
 * Sweep the un-sold sellToken out of a TWAP Safe back to the owner. The owner
 * executes `execTransaction` directly with a pre-validated signature
 * (msg.sender == owner), so there's no separate signing step.
 *
 * mode='claim'  — recover leftovers from a settled order (one click).
 * mode='cancel' — stop an in-progress order: once the Safe has no sell token,
 *                 no further parts can settle. Asks to confirm in a styled modal.
 */
export function ClaimButton({
  safe,
  sellToken,
  owner,
  remaining,
  symbol,
  decimals,
  mode = 'claim',
}: {
  safe: Address;
  sellToken: Address;
  owner: Address;
  remaining: bigint;
  symbol: string;
  decimals: number;
  mode?: 'claim' | 'cancel';
}) {
  const { address: connected } = useAccount();
  const isOwner = !!connected && connected.toLowerCase() === owner.toLowerCase();
  const cancel = mode === 'cancel';
  const [confirming, setConfirming] = useState(false);

  const tx = useWriteContract();
  const wait = useWaitForTransactionReceipt({ hash: tx.data, query: { enabled: !!tx.data } });
  const busy = tx.isPending || wait.isLoading;

  if (remaining <= 0n) return null;

  const amt = `${dispAmount(remaining, decimals)} ${symbol}`;
  const execute = () =>
    tx.writeContract({
      address: safe,
      abi: safeAbi,
      functionName: 'execTransaction',
      args: buildExec({ to: sellToken, data: erc20TransferData(owner, remaining), owner }),
    });
  const onClick = () => { if (cancel) setConfirming(true); else execute(); };

  if (wait.isSuccess) {
    return <div className="kv"><span className="k">{cancel ? 'Cancelled' : 'Claimed'}</span><span className="v good">{amt} returned ✓</span></div>;
  }

  return (
    <>
      <div className="kv">
        <span className="k">{cancel ? 'Remaining in order' : 'Unsold balance'}</span>
        <span className="v" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{amt}</span>
          <button
            className="secondary"
            style={{ padding: '2px 10px', fontSize: 13 }}
            onClick={onClick}
            disabled={!isOwner || busy}
            title={isOwner ? (cancel ? 'Cancel the order and withdraw the remaining tokens' : 'Withdraw the un-sold tokens to your wallet') : `Connect ${owner} to ${cancel ? 'cancel' : 'claim'}`}
          >
            {busy ? (cancel ? 'Cancelling…' : 'Claiming…') : isOwner ? (cancel ? 'Cancel & withdraw' : 'Claim') : 'Connect owner'}
          </button>
        </span>
        {tx.error && <span className="errors" style={{ flexBasis: '100%' }}>{tx.error.message?.slice(0, 140)}</span>}
      </div>

      {confirming && (
        <div className="modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-head">
              <h3>Cancel order?</h3>
              <button className="x" onClick={() => setConfirming(false)}>✕</button>
            </div>
            <p className="notice" style={{ marginTop: 0 }}>
              The remaining <strong>{amt}</strong> will be sent back to your wallet and <strong>no further parts will fill</strong>. Already-executed parts stay as they are.
            </p>
            {tx.error && <p className="errors">{tx.error.message?.slice(0, 160)}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="ghost" onClick={() => setConfirming(false)} disabled={busy}>Keep order</button>
              <button className="cta" style={{ width: 'auto', padding: '12px 18px', background: 'var(--bad)' }} onClick={execute} disabled={!isOwner || busy}>
                {busy ? 'Cancelling…' : 'Cancel & withdraw'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
