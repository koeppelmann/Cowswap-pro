'use client';

import { useEffect } from 'react';
import type { Address } from 'viem';
import {
  useBytecode,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import type { TokenInfo, ChainConfig } from '../lib/chains';
import type { Plan } from '../lib/plan';
import { composableCowAbi, erc20Abi, safeProxyFactoryAbi, twapDeploymentRegistryAbi } from '../lib/abi';
import { fmtAmount } from '../lib/format';
import { downloadRecovery, orderRecord, recoveryFile, RECOVERY_SALT_NONCE, saveOrder } from '../lib/recovery';

export function DeployPanel({
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
  const need = plan.approveAmount;

  // Persist the order to the DB as soon as the address is known.
  useEffect(() => {
    saveOrder(orderRecord({ chain, owner, plan, sell: sellToken, buy: buyToken }));
  }, [chain, owner, plan, sellToken, buyToken]);

  // Allowance model: funds stay in your wallet; you approve the Safe address.
  const { data: allowanceRaw, refetch: refetchAllowance } = useReadContract({
    address: sellToken.address, abi: erc20Abi, functionName: 'allowance', args: [owner, safe],
    query: { refetchInterval: 8000 },
  });
  const { data: balanceRaw } = useReadContract({
    address: sellToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner],
    query: { refetchInterval: 8000 },
  });
  const { data: bytecode, refetch: refetchCode } = useBytecode({ address: safe, query: { refetchInterval: 8000 } });
  const { data: orderLive, refetch: refetchOrder } = useReadContract({
    address: chain.composableCow, abi: composableCowAbi, functionName: 'singleOrders', args: [safe, plan.deployment.orderHash],
    query: { refetchInterval: 8000 },
  });

  const allowance = (allowanceRaw as bigint | undefined) ?? 0n;
  const balance = (balanceRaw as bigint | undefined) ?? 0n;
  const deployed = !!bytecode && bytecode !== '0x';
  const approved = allowance >= need;
  const hasFunds = balance >= need;

  const approve = useWriteContract();
  const deploy = useWriteContract();
  const register = useWriteContract();
  const approveWait = useWaitForTransactionReceipt({ hash: approve.data });
  const deployWait = useWaitForTransactionReceipt({ hash: deploy.data });
  const registerWait = useWaitForTransactionReceipt({ hash: register.data });

  useEffect(() => { if (approveWait.isSuccess) refetchAllowance(); }, [approveWait.isSuccess, refetchAllowance]);
  useEffect(() => { if (deployWait.isSuccess) { refetchCode(); refetchOrder(); refetchAllowance(); } }, [deployWait.isSuccess, refetchCode, refetchOrder, refetchAllowance]);

  const onApprove = () =>
    approve.writeContract({ address: sellToken.address, abi: erc20Abi, functionName: 'approve', args: [safe, need] });
  const onDeploy = () =>
    deploy.writeContract({ address: chain.safeProxyFactory, abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', args: [chain.safeSingleton, plan.deployment.initializer, 0n] });
  const onRegister = () =>
    register.writeContract({ address: chain.twapDeploymentRegistry, abi: twapDeploymentRegistryAbi, functionName: 'register', args: [chain.safeSingleton, BigInt(RECOVERY_SALT_NONCE), plan.deployment.initializer] });
  const onExport = () => downloadRecovery(recoveryFile({ chain, owner, plan, sell: sellToken, buy: buyToken }));

  return (
    <div className="panel">
      <h2>3 · Approve &amp; activate</h2>

      <div className="kv">
        <span className="k">TWAP Safe (deterministic)</span>
        <span className="v"><a className="addr" href={`${chain.explorer}/address/${safe}`} target="_blank" rel="noreferrer">{safe}</a></span>
      </div>
      <div className="kv">
        <span className="k">Your balance</span>
        <span className="v">{fmtAmount(balance, sellToken.decimals)} {sellToken.symbol} {hasFunds ? '' : <span className="badge bad">too low</span>}</span>
      </div>
      <div className="kv">
        <span className="k">Approved to Safe</span>
        <span className="v">
          {fmtAmount(allowance > need ? need : allowance, sellToken.decimals)} / {fmtAmount(need, sellToken.decimals)} {sellToken.symbol}{' '}
          {approved ? <span className="badge good">approved ✓</span> : <span className="badge warn">not approved</span>}
        </span>
      </div>
      <div className="kv">
        <span className="k">Status</span>
        <span className="v">
          {orderLive ? <span className="badge good">TWAP live ✓</span> : deployed ? <span className="badge good">deployed</span> : <span className="badge">not deployed</span>}
        </span>
      </div>

      <div className="spacer" />
      <p className="notice">
        <strong>Your tokens stay in your wallet.</strong> You approve the Safe for{' '}
        <strong>{fmtAmount(need, sellToken.decimals)} {sellToken.symbol}</strong>; the deploy pulls them in and starts the
        TWAP atomically. Nothing is ever sent to an undeployed address — if you never deploy, just revoke the approval.
      </p>

      <div className="actions">
        <button className="secondary" onClick={onApprove} disabled={approve.isPending || approveWait.isLoading || approved || deployed}>
          {approve.isPending || approveWait.isLoading ? 'Approving…' : approved ? 'Approved ✓' : `Approve ${fmtAmount(need, sellToken.decimals)} ${sellToken.symbol}`}
        </button>
        <button onClick={onDeploy} disabled={!approved || !hasFunds || deployed || deploy.isPending || deployWait.isLoading}>
          {deploy.isPending || deployWait.isLoading ? 'Deploying…' : deployed ? 'Deployed ✓' : 'Deploy & start TWAP'}
        </button>
      </div>

      <div className="actions">
        <button className="ghost" onClick={onExport}>⬇ Export recovery file</button>
        <button className="ghost" onClick={onRegister} disabled={register.isPending || registerWait.isLoading}>
          {register.isPending || registerWait.isLoading ? 'Recording…' : registerWait.isSuccess ? 'On-chain ✓' : '⛓ Record on-chain'}
        </button>
      </div>

      {(approve.error || deploy.error || register.error) && (
        <p className="errors">{(approve.error || deploy.error || register.error)?.message?.slice(0, 200)}</p>
      )}

      {(deployed || orderLive) && (
        <>
          <div className="spacer" />
          <div className="notice">
            <div className="step-done">✓ Safe deployed and TWAP registered.</div>
            <div className="spacer" />
            Track parts on <a href={`${chain.cowExplorer}/address/${safe}`} target="_blank" rel="noreferrer">CoW Explorer</a>{' '}
            · manage on <a href={`https://app.safe.global/home?safe=${chain.safeAppPrefix}:${safe}`} target="_blank" rel="noreferrer">app.safe.global</a>.
          </div>
        </>
      )}
    </div>
  );
}
