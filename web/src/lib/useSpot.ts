'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

/**
 * Size-independent spot rate (buyToken per sellToken, human units) from CoW's
 * native_price (native atoms per token atom):
 *   spot = nativePrice(sell) / nativePrice(buy) * 10^(sellDecimals - buyDecimals)
 */
export function useSpot(params: {
  chainId: number;
  sellToken?: Address;
  buyToken?: Address;
  sellDecimals?: number;
  buyDecimals?: number;
}) {
  const enabled = !!params.sellToken && !!params.buyToken && params.sellDecimals != null && params.buyDecimals != null && params.sellToken.toLowerCase() !== params.buyToken.toLowerCase();
  return useQuery<number | null>({
    queryKey: ['spot', params.chainId, params.sellToken, params.buyToken],
    enabled,
    refetchInterval: 60000,
    staleTime: 55000,
    queryFn: async () => {
      const r = await fetch(`/api/native-price?chainId=${params.chainId}&sell=${params.sellToken}&buy=${params.buyToken}`);
      if (!r.ok) return null;
      const { sellPrice, buyPrice } = await r.json();
      if (!sellPrice || !buyPrice) return null;
      return (sellPrice / buyPrice) * 10 ** ((params.sellDecimals ?? 0) - (params.buyDecimals ?? 0));
    },
  });
}
