'use client';

import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { gnosis, mainnet } from 'wagmi/chains';
import { shortAddress } from '../lib/format';

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <button onClick={() => injected && connect({ connector: injected })} disabled={isPending}>
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <select
        value={chainId}
        onChange={(e) => switchChain({ chainId: Number(e.target.value) as typeof mainnet.id | typeof gnosis.id })}
        style={{ width: 'auto' }}
      >
        <option value={mainnet.id}>Ethereum</option>
        <option value={gnosis.id}>Gnosis</option>
      </select>
      <button className="ghost" onClick={() => disconnect()}>
        {shortAddress(address)}
      </button>
    </div>
  );
}
