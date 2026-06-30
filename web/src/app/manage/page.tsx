'use client';

import { useState, useCallback, useEffect } from 'react';
import { useAccount, useConnect, useSwitchChain, usePublicClient, useWalletClient } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { formatEther, type Address } from 'viem';
import {
  ONBOARD, ERC20_ABI, LEV_MODULE, POOL_ADDR, POOL_ABI, AWETH_ADDR, VDEBT_WXDAI, RETARGET_TYPES,
} from '../../lib/onboard';

const O = ONBOARD;
const MAX = (2n ** 256n) - 1n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function barn(op: string, extra: Record<string, unknown>) {
  return (await fetch('/api/barn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...extra }) })).json();
}

type Pos = { coll: bigint; debt: bigint; hf: bigint; availBase: bigint };

export default function Manage() {
  const { address, isConnected, chainId } = useAccount();
  const { connect } = useConnect();
  const { switchChain } = useSwitchChain();
  const pub = usePublicClient({ chainId: 100 });
  const { data: wallet } = useWalletClient();

  const [safe, setSafe] = useState('');
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => { try { setKnown(JSON.parse(localStorage.getItem('levSafes') || '[]')); } catch { /* */ } }, []);
  const [pos, setPos] = useState<Pos | null>(null);
  const [pct, setPct] = useState(50);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const say = (s: string) => setLog((p) => [...p, s]);

  const refresh = useCallback(async () => {
    if (!pub || !safe) return;
    try {
      const coll = await pub.readContract({ address: AWETH_ADDR as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [safe as Address] }) as bigint;
      const debt = await pub.readContract({ address: VDEBT_WXDAI as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [safe as Address] }) as bigint;
      const acct = await pub.readContract({ address: POOL_ADDR as Address, abi: POOL_ABI, functionName: 'getUserAccountData', args: [safe as Address] }) as readonly bigint[];
      setPos({ coll, debt, hf: acct[5], availBase: acct[2] });
    } catch (e) { setErr((e as Error).message); }
  }, [pub, safe]);
  useEffect(() => { if (safe.length === 42) refresh(); }, [safe, refresh]);

  const act = useCallback(async (mode: 0 | 1) => {
    if (!pub || !wallet || !address || !pos) return;
    setBusy(true); setErr(null); setLog([]);
    try {
      const validTo = Math.floor(Date.now() / 1000) + 1800;
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      let sellAmount: bigint, repayAmount: bigint, minBuy: bigint, flash: bigint, minHF: bigint, sellTok: string, buyTok: string;
      if (mode === 0) { // REDUCE (close / partial)
        const full = pct >= 100;
        sellAmount = full ? pos.coll : (pos.coll * BigInt(pct)) / 100n;
        repayAmount = full ? MAX : (pos.debt * BigInt(pct)) / 100n;
        flash = ((full ? pos.debt : repayAmount) * 103n) / 100n;
        const q = await barn('quote', { sellToken: O.weth, buyToken: O.wxdai, from: safe, sellAmount: sellAmount.toString() });
        minBuy = (BigInt(q.body.quote.buyAmount) * 80n) / 100n; minHF = 0n; sellTok = O.weth; buyTok = O.wxdai;
        say(`Reduce ${pct}%: sell ${formatEther(sellAmount)} WETH`);
      } else { // INCREASE
        const capacity = (pos.availBase * (10n ** 10n) * 80n) / 100n; // availableBorrowsBase(8dec USD)->WXDAI, 80%
        if (capacity === 0n) throw new Error('no borrow capacity');
        sellAmount = capacity; repayAmount = 0n; flash = 0n; minHF = 1050000000000000000n;
        const q = await barn('quote', { sellToken: O.wxdai, buyToken: O.weth, from: safe, sellAmount: sellAmount.toString() });
        minBuy = (BigInt(q.body.quote.buyAmount) * 80n) / 100n; sellTok = O.wxdai; buyTok = O.weth;
        say(`Increase: borrow ${formatEther(sellAmount)} WXDAI`);
      }
      const intent = {
        safe: safe as Address, nonce: BigInt(Math.floor(Date.now() / 1000)), deadline: BigInt(deadline), mode,
        collateral: O.weth as Address, debt: O.wxdai as Address, sellAmount, repayAmount, minBuy, flash,
        orderValidTo: validTo, minHealthFactor: minHF,
      };
      say('Sign the management intent (one signature)…');
      const sig = await wallet.signTypedData({
        account: address, domain: { name: 'LevManagerModule', version: '1', chainId: 100, verifyingContract: LEV_MODULE as Address },
        types: RETARGET_TYPES, primaryType: 'Retarget', message: intent as never,
      });
      say('Relaying through the module…');
      const intentStr = Object.fromEntries(Object.entries(intent).map(([k, v]) => [k, v.toString()]));
      const rl = await (await fetch('/api/relay-execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent: intentStr, sig }) })).json();
      if (!rl.ok) throw new Error('relay: ' + (rl.error ?? JSON.stringify(rl)));
      say('Registered (' + rl.txHash.slice(0, 12) + '…). Submitting order…');
      await barn('appdata', { hash: rl.appDataHash, fullAppData: rl.fullAppData });
      await sleep(1500);
      const order = { sellToken: sellTok, buyToken: buyTok, receiver: safe, sellAmount: sellAmount.toString(), buyAmount: minBuy.toString(), validTo, appData: rl.appDataHash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', signingScheme: 'eip1271', signature: '0x', from: safe };
      const os = await barn('order', { order });
      if (os.status !== 201) throw new Error('order: ' + JSON.stringify(os.body));
      say('Order in the auction. Waiting for a solver…');
      const uid = os.body as string;
      for (let k = 0; k < 60; k++) {
        const st = await barn('status', { uid });
        if (st.body?.status === 'fulfilled') { say('Filled ✅'); break; }
        if (['cancelled', 'expired'].includes(st.body?.status)) throw new Error('order ' + st.body.status);
        await sleep(10000);
      }
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [pub, wallet, address, pos, safe, pct, refresh]);


  return (
    <main style={{ maxWidth: 680, margin: '40px auto', padding: 20, fontFamily: 'ui-sans-serif, system-ui', lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 24 }}>Manage a leverage position</h1>
      <p style={{ color: '#555' }}>Increase / decrease / close a position with a <b>single signature</b>, relayed through the manager module. Solvers do the rest. (Staging / barn.)</p>
      {!isConnected ? (
        <button onClick={() => connect({ connector: injected() })} style={btn}>Connect wallet</button>
      ) : chainId !== 100 ? (
        <button onClick={() => switchChain({ chainId: 100 })} style={btn}>Switch to Gnosis</button>
      ) : (
        <>
          {known.length > 0 && (
            <div style={{ marginBottom: 8, fontSize: 13 }}>
              <span style={{ color: '#888' }}>Your positions: </span>
              {known.map((s) => <button key={s} onClick={() => setSafe(s)} style={{ ...chip, marginRight: 6 }}>{s.slice(0, 8)}…{s.slice(-4)}</button>)}
            </div>
          )}
          <input value={safe} onChange={(e) => setSafe(e.target.value.trim())} placeholder="Position Safe address" style={{ ...inp, width: 440 }} />
          {pos && (
            <div style={{ margin: '16px 0', padding: 16, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
              <div>Collateral: <b>{formatEther(pos.coll)} WETH</b></div>
              <div>Debt: <b>{formatEther(pos.debt)} WXDAI</b></div>
              <div>Health factor: <b>{pos.hf === MAX ? '∞' : (Number(pos.hf) / 1e18).toFixed(3)}</b></div>
            </div>
          )}
          {pos && pos.coll > 0n && (
            <div style={{ display: 'grid', gap: 18 }}>
              <div>
                <div style={{ fontWeight: 600 }}>Reduce / close</div>
                <input type="range" min={5} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} style={{ width: 300 }} />
                <span> {pct}%</span>
                <div style={{ display: 'flex', gap: 6, margin: '4px 0' }}>
                  {[25, 50, 75, 100].map((p) => <button key={p} onClick={() => setPct(p)} style={chip}>{p === 100 ? 'Max' : p + '%'}</button>)}
                </div>
                <button onClick={() => act(0)} disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>{busy ? 'Working…' : `Reduce ${pct}%`}</button>
              </div>
              <div>
                <div style={{ fontWeight: 600 }}>Increase leverage</div>
                <div style={{ color: '#888', fontSize: 12 }}>Borrows up to current Aave capacity, buys collateral, supplies it.</div>
                <button onClick={() => act(1)} disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1, background: '#1d4ed8' }}>{busy ? 'Working…' : 'Increase'}</button>
              </div>
            </div>
          )}
          <ol style={{ marginTop: 20, padding: 0, listStyle: 'none', fontSize: 14 }}>
            {log.map((l, i) => <li key={i} style={{ padding: '3px 0', color: '#444' }}>• {l}</li>)}
          </ol>
          {err && <div style={{ marginTop: 12, padding: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>{err}</div>}
        </>
      )}
    </main>
  );
}

const btn: React.CSSProperties = { padding: '8px 16px', fontSize: 14, fontWeight: 600, background: '#111', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' };
const inp: React.CSSProperties = { padding: '8px 10px', fontSize: 14, border: '1px solid #ccc', borderRadius: 6 };
const chip: React.CSSProperties = { padding: '3px 10px', fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer' };
