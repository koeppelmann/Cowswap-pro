'use client';

import { useMemo } from 'react';
import type { Address } from 'viem';
import { useReadContracts } from 'wagmi';
import type { TokenInfo } from './chains';
import { erc20Abi } from './abi';

/**
 * Read every listed token's balance for `owner` in a SINGLE RPC request.
 *
 * wagmi/viem route all the `balanceOf` calls through the canonical Multicall3
 * getter (`0xcA11…CA11`, deployed on both Gnosis and Ethereum) via its
 * `aggregate3`, so this is one `eth_call` regardless of how many tokens there
 * are. Per-call failures are tolerated (allowFailure) so one odd token can't
 * blank the list.
 *
 * Returns a map keyed by lower-cased token address → balance (bigint).
 */
export function useTokenBalances(tokens: TokenInfo[], chainId: number, owner?: Address): Map<string, bigint> {
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: tokens.map((t) => ({
      address: t.address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: owner ? [owner] : undefined,
      chainId: chainId as 1 | 100,
    })),
    query: { enabled: !!owner && tokens.length > 0, refetchInterval: 15_000 },
  });

  return useMemo(() => {
    const m = new Map<string, bigint>();
    data?.forEach((r, i) => {
      if (r.status === 'success' && typeof r.result === 'bigint') {
        m.set(tokens[i].address.toLowerCase(), r.result);
      }
    });
    return m;
  }, [data, tokens]);
}
