import type { Address } from 'viem';
import type { ChainConfig, TokenInfo } from './chains';
import type { Plan } from './plan';

const SALT_NONCE = '0';

/** Order record shape persisted to the DB and exported as a recovery file. */
export function orderRecord(opts: {
  chain: ChainConfig;
  owner: Address;
  plan: Plan;
  sell: TokenInfo;
  buy: TokenInfo;
}) {
  const { chain, owner, plan } = opts;
  return {
    safe: plan.safeAddress,
    chainId: chain.chainId,
    owner,
    receiver: plan.twap.receiver,
    sellToken: plan.twap.sellToken,
    buyToken: plan.twap.buyToken,
    totalSell: plan.effectiveTotalSell.toString(),
    partSell: plan.partSellAmount.toString(),
    minPartLimit: plan.minPartLimit.toString(),
    n: Number(plan.twap.n),
    t: Number(plan.twap.t),
    orderHash: plan.deployment.orderHash,
    singleton: chain.safeSingleton,
    saltNonce: SALT_NONCE,
    initializer: plan.deployment.initializer,
  };
}

/** Persist to the server DB (best-effort; never blocks the UI). */
export async function saveOrder(rec: ReturnType<typeof orderRecord>): Promise<boolean> {
  try {
    const r = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rec),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Everything needed to deploy the Safe and recover funds, with human-readable
 * instructions. The `singleton` + `initializer` + `saltNonce` are the only
 * required fields — anyone can call
 * SafeProxyFactory.createProxyWithNonce(singleton, initializer, saltNonce).
 */
export function recoveryFile(opts: {
  chain: ChainConfig;
  owner: Address;
  plan: Plan;
  sell: TokenInfo;
  buy: TokenInfo;
}) {
  const rec = orderRecord(opts);
  return {
    _: 'TWAP Safe recovery file — keep this safe. It is everything needed to deploy your Safe and reclaim funds.',
    howToRecover:
      'Send the EXACT calldata: SafeProxyFactory.createProxyWithNonce(singleton, initializer, saltNonce) on the given chain. Anyone can submit it; ownership is fixed to `owner`. Also recorded on-chain at the registry, indexed by `safe`.',
    safeProxyFactory: opts.chain.safeProxyFactory,
    registry: opts.chain.twapDeploymentRegistry,
    summary: `${rec.totalSell} ${opts.sell.symbol} -> ${opts.buy.symbol}, ${rec.n} parts every ${rec.t}s`,
    ...rec,
  };
}

export function downloadRecovery(file: ReturnType<typeof recoveryFile>) {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `twap-recovery-${file.safe}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export const RECOVERY_SALT_NONCE = SALT_NONCE;
