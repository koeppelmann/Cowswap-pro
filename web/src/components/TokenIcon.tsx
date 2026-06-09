'use client';

import { useState } from 'react';

export function tokenLogo(chainId: number, address: string): string {
  return `https://token-icons.llamao.fi/icons/tokens/${chainId}/${address.toLowerCase()}?h=48&w=48`;
}

export function TokenIcon({ chainId, address, symbol }: { chainId: number; address?: string; symbol?: string }) {
  const [failed, setFailed] = useState(false);
  const initials = (symbol || '?').slice(0, 3);
  if (!address || failed) {
    return <span className="tok-ico">{initials}</span>;
  }
  return (
    <span className="tok-ico">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={tokenLogo(chainId, address)} alt={symbol || ''} onError={() => setFailed(true)} />
    </span>
  );
}
