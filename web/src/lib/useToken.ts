'use client';

import { useMemo } from 'react';
import type { Address } from 'viem';
import { useReadContracts } from 'wagmi';
import { erc20Abi } from './abi';
import type { ChainConfig, TokenInfo } from './chains';
import { isAddress } from './format';

/**
 * Resolve token metadata: prefer the chain's curated list, otherwise read
 * symbol/decimals/name on-chain for a custom address.
 */
export function useToken(
  chain: ChainConfig | undefined,
  address: string | undefined,
): { token: TokenInfo | undefined; loading: boolean } {
  const known = useMemo(() => {
    if (!chain || !address) return undefined;
    return chain.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
  }, [chain, address]);

  const needsFetch = !!address && isAddress(address) && !known;

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: needsFetch
      ? [
          { address: address as Address, abi: erc20Abi, functionName: 'symbol' },
          { address: address as Address, abi: erc20Abi, functionName: 'decimals' },
          { address: address as Address, abi: erc20Abi, functionName: 'name' },
        ]
      : [],
    query: { enabled: needsFetch },
  });

  const token = useMemo<TokenInfo | undefined>(() => {
    if (known) return known;
    if (!needsFetch || !data || data.length < 3) return undefined;
    const [symbol, decimals, name] = data;
    if (!decimals || decimals.status !== 'success') return undefined;
    return {
      address: address as Address,
      symbol: symbol?.status === 'success' ? (symbol.result as string) : 'TOKEN',
      decimals: Number(decimals.result),
      name: name?.status === 'success' ? (name.result as string) : 'Unknown token',
    };
  }, [known, needsFetch, data, address]);

  return { token, loading: needsFetch && isLoading };
}
