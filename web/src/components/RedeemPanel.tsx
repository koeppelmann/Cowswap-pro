'use client';

import { useAccount, useBytecode, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import type { Address } from 'viem';
import type { ChainConfig, TokenInfo } from '../lib/chains';
import type { Plan } from '../lib/plan';
import { erc20Abi, safeAbi } from '../lib/abi';
import { buildExec, composableCowRemoveData, erc20TransferData } from '../lib/safeExec';
import { fmtAmount, shortAddress } from '../lib/format';

export function RedeemPanel({
  chain,
  plan,
  sellToken,
  buyToken,
  owner,
}: {
  chain: ChainConfig;
  plan: Plan;
  sellToken: TokenInfo;
  buyToken: TokenInfo;
  owner: Address;
}) {
  const safe = plan.safeAddress;
  const { address: connected } = useAccount();
  const isOwner = !!connected && connected.toLowerCase() === owner.toLowerCase();

  const { data: code } = useBytecode({ address: safe, query: { refetchInterval: 10000 } });
  const deployed = !!code && code !== '0x';

  const { data: sellBal, refetch: refetchSell } = useReadContract({
    address: sellToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [safe],
    query: { refetchInterval: 10000 },
  });
  const { data: buyBal, refetch: refetchBuy } = useReadContract({
    address: buyToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [safe],
    query: { refetchInterval: 10000 },
  });

  const tx = useWriteContract();
  const wait = useWaitForTransactionReceipt({ hash: tx.data, query: { enabled: !!tx.data } });
  if (wait.isSuccess) { refetchSell(); refetchBuy(); }

  const sell = (sellBal as bigint | undefined) ?? 0n;
  const buy = (buyBal as bigint | undefined) ?? 0n;
  const busy = tx.isPending || wait.isLoading;

  const exec = (to: Address, data: `0x${string}`) =>
    tx.writeContract({ address: safe, abi: safeAbi, functionName: 'execTransaction', args: buildExec({ to, data, owner }) });

  const cancel = () => exec(chain.composableCow, composableCowRemoveData(plan.deployment.orderHash));
  const sweepSell = () => exec(sellToken.address, erc20TransferData(owner, sell));
  const sweepBuy = () => exec(buyToken.address, erc20TransferData(owner, buy));

  if (!deployed) return null;

  return (
    <div className="panel">
      <h2>Manage / redeem</h2>
      {!isOwner && (
        <p className="notice">Connect the owner wallet (<span className="mono">{shortAddress(owner)}</span>) to cancel or withdraw.</p>
      )}
      <div className="kv"><span className="k">Remaining {sellToken.symbol} in Safe</span><span className="v">{fmtAmount(sell, sellToken.decimals)}</span></div>
      <div className="kv"><span className="k">{buyToken.symbol} in Safe</span><span className="v">{fmtAmount(buy, buyToken.decimals)}</span></div>

      <div className="actions">
        <button className="ghost" onClick={cancel} disabled={!isOwner || busy}>
          {busy ? 'Working…' : 'Cancel remaining parts'}
        </button>
        <button className="secondary" onClick={sweepSell} disabled={!isOwner || busy || sell === 0n}>
          Withdraw {fmtAmount(sell, sellToken.decimals)} {sellToken.symbol}
        </button>
        {buy > 0n && (
          <button className="secondary" onClick={sweepBuy} disabled={!isOwner || busy}>
            Withdraw {fmtAmount(buy, buyToken.decimals)} {buyToken.symbol}
          </button>
        )}
      </div>
      <p className="hint">Funds go to the owner wallet. Cancelling stops future parts (already-settled parts are final).</p>
      {tx.error && <p className="errors">{tx.error.message?.slice(0, 200)}</p>}
    </div>
  );
}
