import { createConfig } from 'wagmi';
import { fallback, http } from 'viem';
import { gnosis, mainnet } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';

// CORS-enabled public endpoints with fallback for resilience (viem's default
// mainnet RPC eth.merkle.io blocks browser CORS; rpc.gnosischain.com rate-limits).
// For prod, put a paid RPC first via NEXT_PUBLIC_*_RPC.
// Lead with the official general public Gnosis RPC (drpc/gateway were returning 400s in-browser).
const gnosisRpcs = [process.env.NEXT_PUBLIC_GNOSIS_RPC, 'https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'].filter(Boolean) as string[];
const mainnetRpcs = [process.env.NEXT_PUBLIC_MAINNET_RPC, 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'].filter(Boolean) as string[];

export const wagmiConfig = createConfig({
  chains: [mainnet, gnosis],
  connectors: [injected()],
  transports: {
    [mainnet.id]: fallback(mainnetRpcs.map((u) => http(u))),
    [gnosis.id]: fallback(gnosisRpcs.map((u) => http(u))),
  },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
