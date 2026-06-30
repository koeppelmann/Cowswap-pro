'use client';

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { isAddress } from './format';

// Read-only "view any account" mode: `?view=0xADDR` lets the app render an
// account's state (balances, positions, orders) without holding its key. Writes
// stay disabled. Handy for support/debugging and for verifying a specific wallet.
export function useViewParam(): Address | null {
  const [view, setView] = useState<Address | null>(null);
  useEffect(() => {
    const read = () => {
      try {
        const p = new URLSearchParams(window.location.search).get('view');
        setView(p && isAddress(p) ? (p as Address) : null);
      } catch { /* ignore */ }
    };
    read();
    // also re-read on back/forward so the viewed account stays in sync with the URL
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  return view;
}
