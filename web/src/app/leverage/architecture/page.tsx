import Link from 'next/link';

export const metadata = { title: 'CoW Leverage — Architecture' };

const A = {
  module: '0x1641c5Ab962e1bEA8806d3A0546987d825eF41Ff',
  init: '0x53A77329A544d235d569D62941303cAbeF536Df0',
  singleton: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
  factory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
  pool: '0xb50201558B00496A145fE76f7424749556E326D8',
  router: '0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69',
  settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  trampoline: '0x60Bf78233f48eC42eE3F101b9a05eC7878728006',
  relayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
};
const scan = (a: string) => `https://gnosisscan.io/address/${a}`;
const Addr = ({ a }: { a: string }) => <a href={scan(a)} target="_blank" rel="noreferrer"><code>{a.slice(0, 6)}…{a.slice(-4)}</code></a>;

export default function ArchitecturePage() {
  return (
    <div className="lev-root">
      <div className="lev-hd">
        <div className="brand">🐮 CoW Leverage — Architecture</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <Link href="/leverage/wrappers" className="nav"><span>wrapper architectures</span></Link>
          <Link href="/leverage" className="nav"><span>← app</span></Link>
        </div>
      </div>

      <div className="lev-wrap" style={{ maxWidth: 820 }}>
        <p className="arch-intro">
          Every leveraged position is its own <b>Gnosis Safe</b> that you (and only you) own. The Safe holds the funds and the
          Aave position, and is the CoW order owner. A shared, verified helper — <b>LevModule</b> — is attached as the Safe&apos;s
          fallback handler and module so the Safe can answer the CoW/Aave callbacks and run the leverage steps, while custody
          stays entirely with your wallet.
        </p>

        {/* ---------- account structure diagram ---------- */}
        <div className="arch-diagram">
          <div className="arch-box eoa">
            <div className="t">👤 Your wallet (EOA)</div>
            <div className="d">The position Safe&apos;s sole owner (threshold 1/1). Authorizes everything — see the table below.</div>
          </div>
          <div className="arch-arrow">▼ owns (1 of 1)</div>
          <div className="arch-box safe">
            <div className="t">🔐 Position Safe — Gnosis Safe v1.3.0</div>
            <div className="d">Holds the collateral + debt (the Aave position) and is the CoW order owner &amp; flash-loan borrower.
              Singleton <Addr a={A.singleton} />, deployed deterministically via factory <Addr a={A.factory} />.</div>
          </div>
          <div className="arch-arrow">▼ fallback handler &amp; enabled module both set to ▼</div>
          <div className="arch-box mod">
            <div className="t">🧩 LevModule (shared, verified) <Addr a={A.module} /></div>
            <div className="d">Answers the Safe&apos;s callbacks (<code>isValidSignature</code>, <code>flashLoanAndCallBack</code>,
              <code>executeOperation</code>) and the leverage hooks (<code>openLeg</code>, <code>reducePrepare</code>,
              <code>closeFinalize</code>). Performs on-chain actions <i>as the Safe</i> via <code>execTransactionFromModule</code>.
              Stateless &amp; shared across all position Safes (keyed by the calling Safe).</div>
          </div>
          <div className="arch-arrow">▲ enabled once at creation by ▲</div>
          <div className="arch-box">
            <div className="t">⚙️ LevSafeInit (setup helper) <Addr a={A.init} /></div>
            <div className="d">Delegate-called inside <code>Safe.setup</code> at creation: enables LevModule as a module and approves
              the CoW VaultRelayer for the sell token. One-shot, no state, no privileges afterward.</div>
          </div>
        </div>

        {/* ---------- external actors ---------- */}
        <div className="arch-card">
          <h2>External contracts the Safe talks to</h2>
          <div className="arch-grid">
            <div className="arch-box"><div className="t">CoW Settlement / Trampoline</div><div className="d">Settles the order &amp; calls the hooks. <Addr a={A.settlement} /> · <Addr a={A.trampoline} /></div></div>
            <div className="arch-box"><div className="t">CoW FlashLoanRouter</div><div className="d">Drives <code>flashLoanAndSettle</code>. <Addr a={A.router} /></div></div>
            <div className="arch-box"><div className="t">Aave V3 Pool</div><div className="d">Flash loan + supply/borrow/repay/withdraw. <Addr a={A.pool} /></div></div>
            <div className="arch-box"><div className="t">CoW VaultRelayer</div><div className="d">Pulls the sell token during settlement. <Addr a={A.relayer} /></div></div>
          </div>
        </div>

        {/* ---------- who can authorize what ---------- */}
        <div className="arch-card">
          <h2>Who can authorize what — and how</h2>
          <table className="arch-tbl">
            <thead><tr><th>Actor</th><th>Can cause</th><th>Authorization method</th></tr></thead>
            <tbody>
              <tr><td>👤 You (Safe owner)</td><td className="can">Move funds out (<code>withdraw</code>/<code>exec</code>), set approvals, open/adjust/close a position</td><td>Safe owner — direct tx, <b>or</b> an off-chain <b>EIP-712 SafeMessage</b> signature bound to <i>your</i> Safe (used as the order&apos;s EIP-1271 signature)</td></tr>
              <tr><td>CoW Settlement (via Trampoline)</td><td className="can">Run the position hooks (<code>openLeg</code>/<code>reducePrepare</code>/<code>closeFinalize</code>) during a settlement</td><td><code>_caller() == Trampoline</code>. ⚠ The trampoline is shared — see security note F1.</td></tr>
              <tr><td>CoW FlashLoanRouter</td><td className="can">Start the flash loan (<code>flashLoanAndCallBack</code>)</td><td><code>_caller() == Router</code></td></tr>
              <tr><td>Aave Pool</td><td className="can">Flash-loan callback (<code>executeOperation</code>)</td><td><code>msg.sender == Pool</code></td></tr>
              <tr><td>🌐 Anyone else</td><td>Nothing that moves funds to them. Hooks only ever act on the Safe&apos;s own position and pay out only to the owner.</td><td>—</td></tr>
            </tbody>
          </table>
          <div className="arch-legend">
            <span><span className="arch-dot" style={{ background: '#46d39a' }} />you / owner</span>
            <span><span className="arch-dot" style={{ background: '#4C82FB' }} />the Safe</span>
            <span><span className="arch-dot" style={{ background: '#ffa53b' }} />helper / module</span>
          </div>
        </div>

        {/* ---------- authorization methods ---------- */}
        <div className="arch-card">
          <h2>Authorization methods</h2>
          <table className="arch-tbl">
            <tbody>
              <tr><td><b>EIP-1271 (Safe-bound)</b></td><td>To approve a CoW order, you sign an EIP-712 <code>SafeMessage</code> whose domain <code>verifyingContract</code> is <i>your specific Safe</i>, wrapping the order digest. LevModule&apos;s <code>isValidSignature</code> recomputes that Safe-bound hash and checks you&apos;re an owner. A signature for one Safe can&apos;t be replayed on another Safe or as a plain wallet (EOA) order.</td></tr>
              <tr><td><b>Safe module</b></td><td>LevModule executes the actual Aave/transfer steps via <code>execTransactionFromModule</code> — only because the Safe enabled it at creation. It acts only on its own Safe and sends any payout to the owner.</td></tr>
              <tr><td><b>Safe owner threshold</b></td><td>1-of-1: your EOA. You can always recover funds directly from the Safe.</td></tr>
            </tbody>
          </table>
        </div>

        {/* ---------- security posture ---------- */}
        <div className="arch-card">
          <h2>Security posture</h2>
          <table className="arch-tbl">
            <thead><tr><th>Item</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              <tr><td>Signature replay (EOA / other Safe)</td><td><span className="arch-sev ok">FIXED</span></td><td>Safe-bound SafeMessage; raw-digest, cross-Safe, and EOA replay all rejected (fork-tested, independently confirmed by an external review).</td></tr>
              <tr><td>Hook fund exfiltration</td><td><span className="arch-sev ok">FIXED</span></td><td><code>closeFinalize</code> pays only the Safe owner — the shared trampoline can&apos;t redirect a Safe&apos;s liquid funds to a third party.</td></tr>
              <tr><td>F1 · Forced borrow via trampoline</td><td><span className="arch-sev crit">RESIDUAL</span></td><td>A third party&apos;s order can trigger your <code>openLeg</code>/<code>reducePrepare</code>. No funds reach them (they stay in your Safe), but they could push a position toward liquidation. Fix in progress: owner-signed hooks (bind each action to the owner + params + nonce).</td></tr>
              <tr><td>F3 · Aave callback initiator check</td><td><span className="arch-sev warn">RESIDUAL</span></td><td><code>executeOperation</code> to also require <code>initiator == this Safe</code>.</td></tr>
            </tbody>
          </table>
          <p className="arch-intro" style={{ marginTop: 10, fontSize: 13 }}>Application code is unaudited; it builds on the audited Safe, Aave V3, and CoW Protocol contracts. Contracts are verified on Gnosisscan/Sourcify.</p>
        </div>

        <p className="lev-foot" style={{ marginTop: 18 }}><Link href="/leverage">← back to the app</Link></p>
      </div>
    </div>
  );
}
