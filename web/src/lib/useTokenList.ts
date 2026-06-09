'use client';

import { useQuery } from '@tanstack/react-query';
import { getAddress, type Address } from 'viem';
import type { ChainConfig, TokenInfo } from './chains';

// Official CoW Swap token list (Uniswap token-list format, multi-chain).
const COW_TOKEN_LIST = 'https://files.cow.fi/tokens/CowSwap.json';

type ListToken = { chainId: number; address: string; symbol: string; name?: string; decimals: number };

/**
 * Tokens for the picker: the curated defaults (in their nice order) first, then
 * the rest of the OFFICIAL CoW Swap token list for this chain, de-duped by
 * address. Falls back to just the curated list while loading / on error.
 */
export function useTokenList(chain: ChainConfig): TokenInfo[] {
  const { data } = useQuery<TokenInfo[]>({
    queryKey: ['cow-token-list', chain.chainId],
    staleTime: 60 * 60 * 1000, // 1h
    gcTime: 24 * 60 * 60 * 1000,
    queryFn: async () => {
      const r = await fetch(COW_TOKEN_LIST);
      if (!r.ok) throw new Error('token list fetch failed');
      const j = (await r.json()) as { tokens: ListToken[] };
      const out: TokenInfo[] = [];
      for (const t of j.tokens) {
        if (t.chainId !== chain.chainId || !t.address) continue;
        try {
          out.push({ address: getAddress(t.address) as Address, symbol: t.symbol, decimals: Number(t.decimals), name: t.name ?? t.symbol });
        } catch { /* skip malformed entry */ }
      }
      return out;
    },
  });

  const official = data ?? [];
  if (official.length === 0) return chain.tokens;

  const seen = new Set(chain.tokens.map((t) => t.address.toLowerCase()));
  const merged: TokenInfo[] = [...chain.tokens];
  for (const t of official) {
    const k = t.address.toLowerCase();
    if (!seen.has(k)) { seen.add(k); merged.push(t); }
  }
  return merged;
}
