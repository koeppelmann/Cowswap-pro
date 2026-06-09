'use client';

import { useMemo } from 'react';
import type { Address } from 'viem';
import { useReadContracts } from 'wagmi';

const metaAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export type TokenMeta = { symbol: string; decimals: number };

/**
 * Resolve symbol + decimals for arbitrary token addresses (those not in the
 * curated/official list) in ONE multicall (via Multicall3) — no per-token RPC.
 * Returns a map keyed by lower-cased address. Long-cached (token meta is static).
 */
export function useTokenMeta(chainId: number, addresses: string[]): Map<string, TokenMeta> {
  const uniq = useMemo(() => Array.from(new Set(addresses.map((a) => a.toLowerCase()))), [addresses]);
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: uniq.flatMap((a) => [
      { address: a as Address, abi: metaAbi, functionName: 'symbol' as const, chainId: chainId as 1 | 100 },
      { address: a as Address, abi: metaAbi, functionName: 'decimals' as const, chainId: chainId as 1 | 100 },
    ]),
    query: { enabled: uniq.length > 0, staleTime: 60 * 60 * 1000, gcTime: 24 * 60 * 60 * 1000 },
  });
  return useMemo(() => {
    const m = new Map<string, TokenMeta>();
    if (!data) return m;
    uniq.forEach((a, i) => {
      const sym = data[i * 2];
      const dec = data[i * 2 + 1];
      if (sym?.status === 'success' && dec?.status === 'success') {
        m.set(a, { symbol: String(sym.result), decimals: Number(dec.result) });
      }
    });
    return m;
  }, [data, uniq]);
}
