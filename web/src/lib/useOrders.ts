'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

// Mirror of the DB row (db.ts is server-only, so we can't import its type here).
export type OrderRow = {
  safe: string;
  chainId: number;
  owner: string;
  receiver: string;
  sellToken: string;
  buyToken: string;
  totalSell: string;
  partSell: string;
  minPartLimit: string;
  n: number;
  t: number;
  orderHash: string;
  singleton: string;
  saltNonce: string;
  initializer: string;
  createdAt: number;
};

export function useOrders(chainId: number, owner?: Address) {
  return useQuery<OrderRow[]>({
    queryKey: ['orders', chainId, owner],
    enabled: !!owner,
    refetchInterval: 15000,
    queryFn: async () => {
      const r = await fetch(`/api/orders?chainId=${chainId}&owner=${owner}`);
      if (!r.ok) return [];
      const d = await r.json();
      return (d.orders ?? []) as OrderRow[];
    },
  });
}
