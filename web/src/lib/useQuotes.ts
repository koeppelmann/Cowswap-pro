'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { fetchQuote, type QuoteResult } from './quote';

/**
 * Fetch a CoW quote for one TWAP leg and for the full size, so the UI can
 * auto-fill the limit and show the price difference. Refetches on input change
 * (debounced via react-query's staleness) and periodically while mounted.
 */
export function useQuotes(params: {
  chainId: number;
  sellToken?: Address;
  buyToken?: Address;
  from?: Address;
  partSellAmount?: bigint;
  totalSell?: bigint;
}) {
  const enabled =
    !!params.sellToken &&
    !!params.buyToken &&
    !!params.from &&
    !!params.partSellAmount &&
    params.partSellAmount > 0n &&
    !!params.totalSell &&
    params.totalSell > 0n &&
    params.sellToken.toLowerCase() !== params.buyToken.toLowerCase();

  return useQuery<QuoteResult>({
    queryKey: [
      'quotes',
      params.chainId,
      params.sellToken,
      params.buyToken,
      params.from,
      params.partSellAmount?.toString(),
      params.totalSell?.toString(),
    ],
    enabled,
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: 1,
    queryFn: async () => {
      const [leg, full] = await Promise.all([
        fetchQuote({
          chainId: params.chainId,
          sellToken: params.sellToken!,
          buyToken: params.buyToken!,
          from: params.from!,
          sellAmount: params.partSellAmount!,
        }),
        fetchQuote({
          chainId: params.chainId,
          sellToken: params.sellToken!,
          buyToken: params.buyToken!,
          from: params.from!,
          sellAmount: params.totalSell!,
        }),
      ]);
      return { leg, full };
    },
  });
}
