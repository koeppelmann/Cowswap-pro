'use client';

import { useState, useCallback } from 'react';
import { useAccount, useConnect, useSwitchChain, usePublicClient, useWalletClient } from 'wagmi';
import { injected } from 'wagmi/connectors';
import {
  encodeFunctionData, keccak256, toHex, parseEther, formatEther, type Address,
} from 'viem';
import { ONBOARD, IB_ABI, ERC20_ABI, GPV2_ORDER_TYPES, CLOSE_HELPER, CLOSE_ABI, SAFE_ABI, WRAPPER_ABI, WRAPPER_ADDR, SAFE_TX_TYPES, type Intent } from '../../lib/onboard';

const O = ONBOARD;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function barn(op: string, extra: Record<string, unknown>) {
  const r = await fetch('/api/barn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...extra }) });
  return r.json();
}

function carrierAppData(bootstrapCalldata: `0x${string}`): { json: string; hash: `0x${string}` } {
  const doc = {
    appCode: 'koeppelmann/cowswap_wrapper', environment: 'barn',
    metadata: { hooks: { pre: [{ target: O.intentBootstrap, callData: bootstrapCalldata, gasLimit: '2500000' }], post: [] } },
    version: '1.6.0',
  };
  const json = JSON.stringify(doc);
  return { json, hash: keccak256(toHex(json)) };
}

type Step = { label: string; state: 'pending' | 'active' | 'done' | 'error'; detail?: string };

export default function Onboard() {
  const { address, isConnected, chainId } = useAccount();
  const { connect } = useConnect();
  const { switchChain } = useSwitchChain();
  const pub = usePublicClient({ chainId: 100 });
  const { data: wallet } = useWalletClient();

  const [equityStr, setEquityStr] = useState('0.01');
  const [leverage, setLeverage] = useState(2);
  const [slippagePct, setSlippagePct] = useState(20);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [safe, setSafe] = useState<Address | null>(null);
  const [position, setPosition] = useState<{ coll: bigint; debt: bigint } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const push = (s: Step) => setSteps((p) => [...p, s]);
  const patch = (i: number, s: Partial<Step>) => setSteps((p) => p.map((x, j) => (j === i ? { ...x, ...s } : x)));

  const run = useCallback(async () => {
    if (!pub || !wallet || !address) return;
    setErr(null); setSteps([]); setSafe(null); setPosition(null); setBusy(true);
    try {
      const equity = parseEther(equityStr);
      const flash = (equity * BigInt(Math.round(leverage * 1000))) / 1000n;
      const validTo = Math.floor(Date.now() / 1000) + 3600;

      // 1. quote the flash leg -> buyMin
      let si = steps.length; push({ label: 'Quote leverage leg', state: 'active' });
      const q = await barn('quote', { sellToken: O.wxdai, buyToken: O.weth, from: '0x25a9A92F3bD7Ce47cFD48a896C5590Cf8F5A03Fb', sellAmount: flash.toString() });
      if (q.status !== 200) throw new Error('quote failed: ' + JSON.stringify(q.body));
      const quoteBuy = BigInt(q.body.quote.buyAmount);
      const buyMin = (quoteBuy * BigInt(100 - slippagePct)) / 100n;
      const repay = (flash * 10006n) / 10000n; // 6bps > Aave's 5bps premium (covers rounding); surplus stays in Safe
      const borrow = repay - equity;
      patch(si, { state: 'done', detail: `min out ${formatEther(buyMin)} WETH` });

      const intent: Intent = { owner: address, equity, flash, buyMin, borrow, repay, validTo, nonce: 1n };
      

      // 2. derive Safe + leverage appData + uid (all on-chain)
      si = steps.length + 1; push({ label: 'Derive Safe + order on-chain', state: 'active' });
      const safeAddr = await pub.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'safeOf', args: [intent] }) as Address;
      const [levJson, levHash] = await pub.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'appData', args: [intent, safeAddr] }) as [string, `0x${string}`];
      const levUid = await pub.readContract({ address: O.intentBootstrap as Address, abi: IB_ABI, functionName: 'uid', args: [intent, safeAddr] }) as `0x${string}`;
      setSafe(safeAddr);
      patch(si, { state: 'done', detail: safeAddr });

      // 3. relayer allowance (standing infra) — approve if missing
      si = steps.length + 2; push({ label: 'Check vault-relayer allowance', state: 'active' });
      const sell = (equity * 105n) / 100n; // sell a touch more so the Safe nets >= equity after fee
      const allowance = await pub.readContract({ address: O.wxdai as Address, abi: ERC20_ABI, functionName: 'allowance', args: [address, O.relayer as Address] }) as bigint;
      if (allowance < sell) {
        patch(si, { state: 'active', detail: 'approving (one-time)...' });
        const h = await wallet.writeContract({ address: O.wxdai as Address, abi: ERC20_ABI, functionName: 'approve', args: [O.relayer as Address, sell * 10n], chain: undefined, account: address });
        await pub.waitForTransactionReceipt({ hash: h });
        patch(si, { state: 'done', detail: 'approved' });
      } else { patch(si, { state: 'done', detail: 'already approved' }); }

      // 4. THE ONE SIGNATURE: carrier order (sell WXDAI -> WXDAI, receiver = Safe, pre-hook = bootstrap)
      si = steps.length + 3; push({ label: 'Sign carrier order (your only signature)', state: 'active' });
      const bootstrapCalldata = encodeFunctionData({ abi: IB_ABI, functionName: 'bootstrap', args: [intent] });
      const { json: carrierJson, hash: carrierHash } = carrierAppData(bootstrapCalldata);
      const carrierValidTo = Math.floor(Date.now() / 1000) + 3600;
      const carrierOrder = {
        sellToken: O.wxdai, buyToken: O.wxdai, receiver: safeAddr,
        sellAmount: sell.toString(), buyAmount: ((sell * 96n) / 100n).toString(),
        validTo: carrierValidTo, appData: carrierHash, feeAmount: '0', kind: 'sell',
        partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
      };
      const sig = await wallet.signTypedData({
        account: address,
        domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 100, verifyingContract: O.settlement as Address },
        types: GPV2_ORDER_TYPES, primaryType: 'Order',
        message: { ...carrierOrder, sellAmount: BigInt(carrierOrder.sellAmount), buyAmount: BigInt(carrierOrder.buyAmount), feeAmount: 0n } as never,
      });
      patch(si, { state: 'done', detail: 'signed' });

      // 5. submit carrier order
      si = steps.length + 4; push({ label: 'Submit carrier order', state: 'active' });
      await barn('appdata', { hash: carrierHash, fullAppData: carrierJson });
      const cs = await barn('order', { order: { ...carrierOrder, signingScheme: 'eip712', signature: sig, from: address } });
      if (cs.status !== 201) throw new Error('carrier rejected: ' + JSON.stringify(cs.body));
      const carrierUid = cs.body as string;
      patch(si, { state: 'done', detail: carrierUid.slice(0, 14) + '…' });

      // 6. wait for carrier to settle (deploys Safe + registers leverage order)
      si = steps.length + 5; push({ label: 'Solver deploys Safe + registers order', state: 'active' });
      let deployed = false;
      for (let k = 0; k < 60; k++) {
        const st = await barn('status', { uid: carrierUid });
        if (st.body?.status === 'fulfilled') { deployed = true; break; }
        if (st.body?.status === 'cancelled' || st.body?.status === 'expired') throw new Error('carrier ' + st.body.status);
        await sleep(10000);
      }
      if (!deployed) throw new Error('carrier did not settle in time');
      patch(si, { state: 'done', detail: 'Safe live + order registered' });

      // 7. submit leverage order (signature 0x — bless-authorized)
      si = steps.length + 6; push({ label: 'Submit leverage order', state: 'active' });
      await barn('appdata', { hash: levHash, fullAppData: levJson });
      const lo = {
        sellToken: O.wxdai, buyToken: O.weth, receiver: safeAddr,
        sellAmount: flash.toString(), buyAmount: buyMin.toString(), validTo,
        appData: levHash, feeAmount: '0', kind: 'sell', partiallyFillable: false,
        sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', signingScheme: 'eip1271', signature: '0x', from: safeAddr,
      };
      const ls = await barn('order', { order: lo });
      if (ls.status !== 201) throw new Error('leverage rejected: ' + JSON.stringify(ls.body));
      const levSubmittedUid = ls.body as string;
      patch(si, { state: 'done', detail: levSubmittedUid.slice(0, 14) + '…' });

      // 8. wait for leverage fill
      si = steps.length + 7; push({ label: 'Solver opens the position', state: 'active' });
      let filled = false;
      for (let k = 0; k < 90; k++) {
        const st = await barn('status', { uid: levUid });
        if (st.body?.status === 'fulfilled') { filled = true; break; }
        if (st.body?.status === 'cancelled' || st.body?.status === 'expired') throw new Error('leverage ' + st.body.status);
        await sleep(10000);
      }
      if (!filled) throw new Error('leverage did not fill in time');
      patch(si, { state: 'done', detail: 'filled' });

      // 9. read the position
      const coll = await pub.readContract({ address: O.aweth as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }) as bigint;
      const debt = await pub.readContract({ address: O.vdebtWxdai as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }) as bigint;
      setPosition({ coll, debt });
    } catch (e) {
      setErr((e as Error).message);
      setSteps((p) => p.map((x) => (x.state === 'active' ? { ...x, state: 'error' } : x)));
    } finally {
      setBusy(false);
    }
  }, [pub, wallet, address, equityStr, leverage, slippagePct, steps.length]);

  return (
    <main style={{ maxWidth: 680, margin: '40px auto', padding: 20, fontFamily: 'ui-sans-serif, system-ui', lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 24 }}>One-signature leverage onboarding</h1>
      <p style={{ color: '#555' }}>
        Open a leveraged WETH position on Gnosis from a fresh EOA with a <b>single signature</b>. A deterministic Safe is
        created and the position opened entirely by solvers — no new wrapper, no keeper. (Staging / barn.)
      </p>

      {!isConnected ? (
        <button onClick={() => connect({ connector: injected() })} style={btn}>Connect wallet</button>
      ) : chainId !== 100 ? (
        <button onClick={() => switchChain({ chainId: 100 })} style={btn}>Switch to Gnosis</button>
      ) : (
        <>
          <div style={{ color: '#555', fontSize: 14 }}>Connected: {address}</div>
          <div style={{ display: 'flex', gap: 16, margin: '16px 0', flexWrap: 'wrap' }}>
            <label>Equity (WXDAI)<br /><input value={equityStr} onChange={(e) => setEquityStr(e.target.value)} style={inp} /></label>
            <label>Leverage<br /><input type="number" min={1.1} max={4} step={0.1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} style={inp} /></label>
            <label>Slippage %<br /><input type="number" min={1} max={50} value={slippagePct} onChange={(e) => setSlippagePct(Number(e.target.value))} style={inp} /></label>
          </div>
          <button onClick={run} disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Working…' : `Open ${leverage}x WETH long`}
          </button>
          <p style={{ color: '#888', fontSize: 12 }}>You hold WXDAI and have (or will set, one-time) a CoW relayer allowance. Everything else is solver-executed.</p>
        </>
      )}

      <ol style={{ marginTop: 24, padding: 0, listStyle: 'none' }}>
        {steps.map((s, i) => (
          <li key={i} style={{ padding: '6px 0', display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <span style={{ width: 18 }}>{s.state === 'done' ? '✅' : s.state === 'active' ? '⏳' : s.state === 'error' ? '❌' : '•'}</span>
            <span><b>{s.label}</b>{s.detail ? <span style={{ color: '#666' }}> — {s.detail}</span> : null}</span>
          </li>
        ))}
      </ol>

      {safe && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          Your Safe: <a href={`https://gnosisscan.io/address/${safe}`} target="_blank" rel="noreferrer">{safe}</a>
        </div>
      )}
      {position && (
        <div style={{ marginTop: 16, padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 }}>
          <b>Position open 🎉</b><br />
          Collateral: {formatEther(position.coll)} WETH<br />
          Debt: {formatEther(position.debt)} WXDAI
        </div>
      )}
      {err && <div style={{ marginTop: 16, padding: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>{err}</div>}

      {isConnected && chainId === 100 && (
        <ClosePanel defaultSafe={safe} />
      )}
    </main>
  );
}

function ClosePanel({ defaultSafe }: { defaultSafe: Address | null }) {
  const { address } = useAccount();
  const pub = usePublicClient({ chainId: 100 });
  const { data: wallet } = useWalletClient();
  const [safeStr, setSafeStr] = useState('');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<CStep[]>([]);
  const [done, setDone] = useState<{ recovered: bigint } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const safeInput = (safeStr || defaultSafe || '') as string;

  const close = useCallback(async () => {
    if (!pub || !wallet || !address) return;
    const safe = safeInput as Address;
    setErr(null); setSteps([]); setDone(null); setBusy(true);
    const push = (s: CStep) => setSteps((p) => [...p, s]);
    const patch = (i: number, s: Partial<CStep>) => setSteps((p) => p.map((x, j) => (j === i ? { ...x, ...s } : x)));
    try {
      // 1. read position + find a free wrapper nonce
      let i = 0; push({ label: 'Read position', state: 'active' });
      const coll = await pub.readContract({ address: O.aweth as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [safe] }) as bigint;
      const debt = await pub.readContract({ address: O.vdebtWxdai as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [safe] }) as bigint;
      if (coll === 0n) throw new Error('no collateral on this Safe');
      let nonce = 0n;
      for (let n = 1n; n <= 30n; n++) {
        const st = await pub.readContract({ address: WRAPPER_ADDR as Address, abi: WRAPPER_ABI, functionName: 'orderStatus', args: [safe, n] }) as number;
        if (st === 0) { nonce = n; break; }
      }
      if (nonce === 0n) throw new Error('no free meta-order nonce');
      patch(i, { state: 'done', detail: `coll ${formatEther(coll)} WETH, debt ${formatEther(debt)} WXDAI` });

      // 2. quote collateral -> WXDAI, size flash to clear the debt
      i = 1; push({ label: 'Quote close + size flash', state: 'active' });
      const q = await barn('quote', { sellToken: O.weth, buyToken: O.wxdai, from: safe, sellAmount: coll.toString() });
      if (q.status !== 200) throw new Error('quote failed: ' + JSON.stringify(q.body));
      const buyMin = (BigInt(q.body.quote.buyAmount) * 80n) / 100n;
      const flash = (debt * 103n) / 100n;
      const repay = (flash * 10006n) / 10000n; // covers Aave premium rounding
      const validTo = Math.floor(Date.now() / 1000) + 3600;
      patch(i, { state: 'done', detail: `min out ${formatEther(buyMin)} WXDAI` });

      // 3. CloseHelper.build -> register calldata + appData + uid
      i = 2; push({ label: 'Derive close order on-chain', state: 'active' });
      const c = { safe, sellWeth: coll, buyMin, flash, repay, validTo, nonce };
      const [target, registerCalldata, json, hash, orderUid] = await pub.readContract({
        address: CLOSE_HELPER as Address, abi: CLOSE_ABI, functionName: 'build', args: [c],
      }) as [Address, `0x${string}`, string, `0x${string}`, `0x${string}`];
      patch(i, { state: 'done' });

      // 4. THE ONE SIGNATURE: owner signs the Safe tx (registerMetaOrder)
      i = 3; push({ label: 'Sign Safe tx (your only signature)', state: 'active' });
      const safeNonce = await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: 'nonce' }) as bigint;
      const ZERO = '0x0000000000000000000000000000000000000000' as const;
      const sig = await wallet.signTypedData({
        account: address,
        domain: { chainId: 100, verifyingContract: safe },
        types: SAFE_TX_TYPES, primaryType: 'SafeTx',
        message: { to: target, value: 0n, data: registerCalldata, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: safeNonce } as never,
      });
      patch(i, { state: 'done', detail: 'signed' });

      // 5. relay executes the Safe tx (gas paid by the relay service)
      i = 4; push({ label: 'Relay registers the close', state: 'active' });
      const rl = await (await fetch('/api/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ safe, to: target, data: registerCalldata, signatures: sig }) })).json();
      if (!rl.ok) throw new Error('relay failed: ' + (rl.error ?? JSON.stringify(rl)));
      patch(i, { state: 'done', detail: rl.txHash.slice(0, 14) + '…' });

      // 6. submit close order + wait
      i = 5; push({ label: 'Submit close order', state: 'active' });
      await barn('appdata', { hash, fullAppData: json });
      const co = { sellToken: O.weth, buyToken: O.wxdai, receiver: safe, sellAmount: coll.toString(), buyAmount: buyMin.toString(), validTo, appData: hash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', signingScheme: 'eip1271', signature: '0x', from: safe };
      const cs = await barn('order', { order: co });
      if (cs.status !== 201) throw new Error('close rejected: ' + JSON.stringify(cs.body));
      patch(i, { state: 'done' });

      i = 6; push({ label: 'Solver closes the position', state: 'active' });
      let filled = false;
      for (let k = 0; k < 90; k++) {
        const st = await barn('status', { uid: orderUid });
        if (st.body?.status === 'fulfilled') { filled = true; break; }
        if (st.body?.status === 'cancelled' || st.body?.status === 'expired') throw new Error('close ' + st.body.status);
        await sleep(10000);
      }
      if (!filled) throw new Error('close did not fill in time');
      patch(i, { state: 'done', detail: 'filled' });
      const recovered = await pub.readContract({ address: O.wxdai as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [safe] }) as bigint;
      setDone({ recovered });
    } catch (e) {
      setErr((e as Error).message);
      setSteps((p) => p.map((x) => (x.state === 'active' ? { ...x, state: 'error' } : x)));
    } finally { setBusy(false); }
  }, [pub, wallet, address, safeInput]);

  return (
    <div style={{ marginTop: 32, paddingTop: 20, borderTop: '1px solid #eee' }}>
      <h2 style={{ fontSize: 18 }}>Close a position (one signature, relayed)</h2>
      <p style={{ color: '#666', fontSize: 13 }}>Sign one gasless Safe transaction; our relay service executes it and the position is unwound by solvers.</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' }}>
        <input value={safeInput} onChange={(e) => setSafeStr(e.target.value)} placeholder="Safe address" style={{ ...inp, width: 380 }} />
        <button onClick={close} disabled={busy || !safeInput} style={{ ...btn, opacity: busy || !safeInput ? 0.6 : 1 }}>{busy ? 'Closing…' : 'Close position'}</button>
      </div>
      <ol style={{ padding: 0, listStyle: 'none' }}>
        {steps.map((s, i) => (
          <li key={i} style={{ padding: '5px 0', display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <span style={{ width: 18 }}>{s.state === 'done' ? '✅' : s.state === 'active' ? '⏳' : s.state === 'error' ? '❌' : '•'}</span>
            <span><b>{s.label}</b>{s.detail ? <span style={{ color: '#666' }}> — {s.detail}</span> : null}</span>
          </li>
        ))}
      </ol>
      {done && <div style={{ marginTop: 12, padding: 14, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 }}><b>Closed ✅</b> — Safe now holds {formatEther(done.recovered)} WXDAI</div>}
      {err && <div style={{ marginTop: 12, padding: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>{err}</div>}
    </div>
  );
}

type CStep = { label: string; state: 'pending' | 'active' | 'done' | 'error'; detail?: string };

const btn: React.CSSProperties = { padding: '10px 18px', fontSize: 15, fontWeight: 600, background: '#111', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' };
const inp: React.CSSProperties = { padding: '6px 8px', fontSize: 14, border: '1px solid #ccc', borderRadius: 6, width: 120 };
