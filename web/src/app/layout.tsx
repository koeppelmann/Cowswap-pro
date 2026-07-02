import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cowswap Pro — swaps, TWAP, leverage & sDAI on Gnosis',
  description:
    'An experimental pro interface for CoW Protocol: MEV-protected swaps, TWAP orders, one-signature leverage, and cross-chain swaps into sDAI on Gnosis.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
