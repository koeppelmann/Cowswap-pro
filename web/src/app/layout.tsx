import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'TWAP Safe — approve-to-deploy CoW TWAP orders',
  description:
    'Create a CoW Protocol TWAP order, get a deterministic Safe address, approve it, and it auto-deploys — tokens stay in your wallet until then.',
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
