'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Address, type Hex } from 'viem';
import { usePublicClient, useSwitchChain, useWalletClient } from 'wagmi';
import { mainnet, gnosis } from 'wagmi/chains';
import { dispAmount } from '../lib/format';
import {
  FOREIGN_BRIDGE, type Withdrawal, type ClaimState,
  withdrawalFromTx, readClaimState, isClaimed, executeSignaturesCalldata,
} from '../lib/sdaiClaim';
import { listWithdrawals, saveWithdrawal, removeWithdrawal } from '../lib/sdaiWithdrawals';

type Row = { txHash: Hex; w?: Withdrawal; state?: ClaimState; claimed?: boolean; error?: string };

/** Panel listing the user's reverse withdrawals and letting them submit the
 *  mainnet `executeSignatures` claim themselves (indexer-free, permissionless). */
export function SdaiClaim({ owner, chainId }: { owner: Address; chainId: number }) {
  const gno = usePublicClient({ chainId: gnosis.id });
  const eth = usePublicClient({ chainId: mainnet.id });
  const { data: walletClient } = useWalletClient();
  const { switchChain } = useSwitchChain();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!gno || !eth) return;
    const pending = listWithdrawals(owner);
    const enriched = await Promise.all(pending.map(async (p): Promise<Row> => {
      try {
        const w = await withdrawalFromTx(gno, p.txHash);
        if (!w) return { txHash: p.txHash, error: 'no bridge event in tx' };
        const [state, claimed] = await Promise.all([readClaimState(gno, w), isClaimed(eth, w)]);
        return { txHash: p.txHash, w, state, claimed };
      } catch (e) { return { txHash: p.txHash, error: (e as Error).message }; }
    }));
    setRows(enriched);
    // prune already-claimed from storage
    for (const r of enriched) if (r.claimed) removeWithdrawal(owner, r.txHash);
  }, [owner, gno, eth]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 20000); return () => clearInterval(t); }, [refresh]);

  async function claim(r: Row) {
    if (!walletClient || !eth || !r.w || !r.state?.packed) return;
    if (chainId !== mainnet.id) { switchChain({ chainId: mainnet.id }); return; }
    setBusy(r.txHash);
    try {
      const hash = await walletClient.sendTransaction({
        account: owner, chain: mainnet, to: FOREIGN_BRIDGE as Address,
        data: executeSignaturesCalldata(r.w.message, r.state.packed),
      });
      await eth.waitForTransactionReceipt({ hash });
      removeWithdrawal(owner, r.txHash);
      await refresh();
    } catch (e) { setRows((rs) => rs.map((x) => x.txHash === r.txHash ? { ...x, error: (e as Error).message } : x)); }
    finally { setBusy(null); }
  }

  if (rows.length === 0) return null;

  return (
    <div className="widget" style={{ marginTop: 14 }}>
      <h3 style={{ margin: '0 0 10px' }}>Claim on Ethereum</h3>
      {rows.map((r) => (
        <div key={r.txHash} style={{ padding: '8px 0', borderTop: '1px solid var(--line, #0001)' }}>
          <div className="kv" style={{ marginBottom: 6 }}>
            <span className="k">{r.w ? <>{dispAmount(r.w.amount, 18)} USDS</> : 'Withdrawal'} · <a href={`https://gnosisscan.io/tx/${r.txHash}`} target="_blank" rel="noreferrer">Gnosis ↗</a></span>
            <span className="v">
              {r.claimed ? '✅ claimed'
                : r.error ? <span style={{ color: 'var(--warn)' }}>error</span>
                : r.state && !r.state.ready ? `⏳ validators ${r.state.collected}/${r.state.required}`
                : r.state?.ready ? 'ready to claim' : '…'}
            </span>
          </div>
          {r.state?.ready && !r.claimed && (
            <button className="cta" style={{ padding: '10px 0' }} disabled={busy === r.txHash} onClick={() => claim(r)}>
              {busy === r.txHash ? 'Claiming…' : chainId !== mainnet.id ? 'Switch to Ethereum to claim' : `Claim ${r.w ? dispAmount(r.w.amount, 18) : ''} USDS`}
            </button>
          )}
          {r.error && <p className="hint" style={{ color: 'var(--warn)', margin: '4px 0 0' }}>{r.error}</p>}
        </div>
      ))}
      <p className="hint" style={{ marginTop: 8 }}>
        Withdrawals settle when 4 bridge validators sign (~a few min), then you submit the claim on Ethereum. Permissionless — anyone can submit it, funds always go to you.
      </p>
    </div>
  );
}

export { saveWithdrawal };
