'use client';

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { isAddress } from './format';

/** Read an address-valued URL query param, kept in sync with back/forward nav. */
function useAddrParam(name: string): Address | null {
  const [val, setVal] = useState<Address | null>(null);
  useEffect(() => {
    const read = () => {
      try {
        const p = new URLSearchParams(window.location.search).get(name);
        setVal(p && isAddress(p) ? (p as Address) : null);
      } catch { /* ignore */ }
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [name]);
  return val;
}

// Read-only "view any account" mode: `?view=0xADDR` lets the app render an
// account's state (balances, positions, orders) without holding its key. Writes
// stay disabled. Handy for support/debugging and for verifying a specific wallet.
export function useViewParam(): Address | null {
  return useAddrParam('view');
}

// Deep-link a specific leverage position: `?pos=0xSAFE` opens the trade page with
// that position pre-selected in the sell selector (so /orders "Manage →" lands on it).
export function usePosParam(): Address | null {
  return useAddrParam('pos');
}
