'use client';

import { useMemo, useState } from 'react';
import type { Address } from 'viem';
import type { ChainConfig } from '../lib/chains';
import { dispAmount, isAddress, shortAddress } from '../lib/format';
import { useToken } from '../lib/useToken';
import { useTokenBalances } from '../lib/useTokenBalances';
import { useTokenList } from '../lib/useTokenList';
import { TokenIcon } from './TokenIcon';

/** CoW-style token pill that opens a picker (curated list + custom address). */
export function TokenPicker({
  chain,
  value,
  onChange,
  owner,
}: {
  chain: ChainConfig;
  value: string;
  onChange: (addr: string) => void;
  owner?: Address;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  // official CoW Swap token list (curated defaults first), with fallback
  const tokens = useTokenList(chain);
  const selected = tokens.find((t) => t.address.toLowerCase() === value.toLowerCase());
  const { token: customTok } = useToken(chain, isAddress(custom) ? custom : undefined);

  // one multicall for every listed token's balance; only while the picker is open
  const balances = useTokenBalances(open ? tokens : [], chain.chainId, open ? owner : undefined);
  // tokens with a balance float to the top (by amount), then the rest in order
  const sortedTokens = useMemo(() => {
    return tokens
      .map((t, i) => ({ t, i, bal: balances.get(t.address.toLowerCase()) ?? 0n }))
      .sort((a, b) => (a.bal === b.bal ? a.i - b.i : a.bal > b.bal ? -1 : 1))
      .map((x) => x.t);
  }, [tokens, balances]);

  return (
    <>
      <button type="button" className={`token-pill ${value ? '' : 'empty'}`} onClick={() => setOpen(true)}>
        {value && <TokenIcon chainId={chain.chainId} address={value} symbol={selected?.symbol} />}
        <span>{selected?.symbol ?? (value ? shortAddress(value) : 'Select token')}</span>
        <span className="chev">▼</span>
      </button>

      {open && (
        <div className="picker-backdrop" onClick={() => setOpen(false)}>
          <div className="picker" onClick={(e) => e.stopPropagation()}>
            <h3>Select a token</h3>
            <input
              placeholder="Paste token address (0x…)"
              value={custom}
              spellCheck={false}
              onChange={(e) => setCustom(e.target.value.trim())}
              className="mono"
              style={{ marginBottom: 8 }}
            />
            {isAddress(custom) && customTok && (
              <div className="tok" onClick={() => { onChange(customTok.address); setOpen(false); setCustom(''); }}>
                <TokenIcon chainId={chain.chainId} address={customTok.address} symbol={customTok.symbol} />
                <div><div className="sym">{customTok.symbol}</div><div className="nm">{customTok.name}</div></div>
              </div>
            )}
            {sortedTokens.map((t) => {
              const bal = balances.get(t.address.toLowerCase());
              return (
                <div key={t.address} className="tok" onClick={() => { onChange(t.address); setOpen(false); }}>
                  <TokenIcon chainId={chain.chainId} address={t.address} symbol={t.symbol} />
                  <div><div className="sym">{t.symbol}</div><div className="nm">{t.name}</div></div>
                  {bal !== undefined && bal > 0n && <div className="tok-bal">{dispAmount(bal, t.decimals)}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
