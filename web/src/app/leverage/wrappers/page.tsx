import Link from 'next/link';

export const metadata = { title: 'CoW Leverage — Wrapper Architectures' };

const Code = ({ c }: { c: string }) => <code>{c}</code>;

export default function WrappersPage() {
  return (
    <div className="lev-root">
      <div className="lev-hd">
        <div className="brand">🐮 CoW Leverage — Wrapper Architectures</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <Link href="/leverage/architecture" className="nav"><span>account structure</span></Link>
          <Link href="/leverage" className="nav"><span>← app</span></Link>
        </div>
      </div>

      <div className="lev-wrap" style={{ maxWidth: 860 }}>
        <p className="arch-intro">
          A CoW <b>wrapper</b> is a contract on the protocol&apos;s solver allowlist that wraps <Code c="settle()" /> and can
          therefore <i>enforce</i> work around a swap — unlike best-effort hooks, an order placed through a wrapper{' '}
          <b>cannot settle at all</b> unless the wrapper&apos;s logic runs and verifies. We built the leveraged-position flow
          (flash-loan → swap → Aave ops, all-or-nothing) in <b>two architectures</b> on this primitive — a <b>generic,
          composable stack</b> and a <b>specialized single contract</b> — both proven end-to-end on a Gnosis fork against
          the real settlement contract and real Aave V3. This page explains both and compares them.
        </p>

        {/* ---------- shared enforcement core ---------- */}
        <div className="arch-card">
          <h2>The shared enforcement core (both models)</h2>
          <table className="arch-tbl">
            <tbody>
              <tr><td><b>Registration</b></td><td>The position Safe itself (owner-authorized, direct call) registers what may happen: the exact CoW order UID, the minimum fill, and what runs around it. Solvers can never invent or alter an action — at most decline to execute it.</td></tr>
              <tr><td><b>Transient bless</b></td><td>The order&apos;s EIP-1271 signature validates <i>only while the wrapper is mid-settlement</i>: the wrapper sets a transient (EIP-1153) &quot;bless&quot; flag for the order digest just before calling <Code c="settle" />; the Safe&apos;s fallback handler answers <Code c="isValidSignature" /> by reading it. Outside the wrapper the order is unsettleable — no bypass, no hook-skipping.</td></tr>
              <tr><td><b>Proof of fill</b></td><td>After <Code c="settle" /> returns, the wrapper requires <Code c="filledAmount(uid) ≥ expectedFill" /> — a solver can run the preparation but cannot skip the trade.</td></tr>
              <tr><td><b>One-shot</b></td><td>The registration is frozen &amp; consumed before any side effect; replay is impossible. Every failure anywhere reverts the entire transaction.</td></tr>
              <tr><td><b>Flash atomicity</b></td><td>The flash loan is repaid from the wrapper&apos;s own balance at the end of the Aave callback. If the committed flows don&apos;t route <Code c="loan + premium" /> back, Aave&apos;s pull fails and <i>everything</i> unwinds.</td></tr>
            </tbody>
          </table>
        </div>

        {/* ---------- MODEL A ---------- */}
        <div className="arch-card">
          <h2>Model A — generic stack: FlashLoanWrapper → SafeWrapper</h2>
          <p className="arch-intro" style={{ fontSize: 13 }}>
            Two small, <b>reusable</b> wrappers chained per CoW&apos;s standard wrapper-chaining. Neither knows anything about
            leverage: one provides flash liquidity around <i>whatever comes next</i>; the other enforces <i>any</i>{' '}
            Safe-committed pre/post transactions around a swap. Leverage is just one configuration of them.
          </p>
          <div className="arch-diagram">
            <div className="arch-box eoa"><div className="t">🤖 Solver</div><div className="d">calls <Code c="wrappedSettle(settleData, chain)" /> — chain = flash-loans data ++ safe-wrapper data</div></div>
            <div className="arch-arrow">▼ takes Aave flash loan; runs the rest of the chain inside the loan window</div>
            <div className="arch-box mod"><div className="t">⚡ CowFlashLoanWrapper <span className="arch-sev ok">generic</span></div><div className="d">Stateless. Delivers solver-specified loans (e.g. 200 WXDAI → the Safe), continues the chain, repays from its own balance at the end. No registry — its safety <i>is</i> atomic repayment.</div></div>
            <div className="arch-arrow">▼ chain continues</div>
            <div className="arch-box safe"><div className="t">🔐 CoWSafeWrapper <span className="arch-sev ok">generic</span></div><div className="d">The Safe pre-registered <b>hashes</b> of a pre-tx and post-tx (any calls, incl. MultiSend batches). Solver supplies the calldata; wrapper verifies the hashes, runs <b>pre</b> as the Safe, blesses the order, settles, proves the fill, runs <b>post</b>.</div></div>
            <div className="arch-arrow">▼ inside: GPv2Settlement.settle — the swap</div>
            <div className="arch-box"><div className="t">🏦 The leverage OPEN, expressed as pre/post</div><div className="d"><b>pre</b>: approve Aave for WETH. <b>swap</b>: sell 200 flash-WXDAI → WETH. <b>post</b> (MultiSend): supply WETH · borrow 100.1 WXDAI · send 200.1 to the flash wrapper. CLOSE mirrors it (repay+withdraw in pre, sell collateral, repay flash in post).</div></div>
          </div>
        </div>

        {/* ---------- MODEL B ---------- */}
        <div className="arch-card">
          <h2>Model B — specialized: CowAaveLevWrapper</h2>
          <p className="arch-intro" style={{ fontSize: 13 }}>
            One wrapper that <b>understands leverage</b>. The Safe registers ~8 <b>semantic fields</b> — no calldata
            engineering — and the wrapper performs the flash loan <i>and</i> every Aave operation itself, as the Safe
            (it is the Safe&apos;s module).
          </p>
          <div className="arch-diagram">
            <div className="arch-box eoa"><div className="t">🤖 Solver</div><div className="d">calls <Code c="wrappedSettle(settleData, (safe, nonce))" /> — that&apos;s the whole wrapper data</div></div>
            <div className="arch-arrow">▼</div>
            <div className="arch-box mod"><div className="t">🎯 CowAaveLevWrapper <span className="arch-sev warn">specialized</span></div><div className="d">Loads the Safe&apos;s registered <Code c="LevParams" /> — <Code c="{kind, collateral, debt, flashAmount, borrowAmount, withdrawAmount, payout, uid, expectedFill}" /> — freezes them, flash-borrows, and executes the whole recipe: deliver loan → (close: repay+withdraw) → approve relayer → bless → settle → prove fill → (open: supply <i>the swap proceeds</i> + borrow) → route repayment → pay surplus to the registered <Code c="payout" />.</div></div>
            <div className="arch-arrow">▼ inside: GPv2Settlement.settle — the swap</div>
            <div className="arch-box safe"><div className="t">🛡 Delta accounting</div><div className="d">Everything dynamic is a <b>balance delta vs pre-action snapshots</b>: it supplies only the collateral <i>gained by the swap</i>, sells only what <i>this close withdrew</i>, pays out only the surplus <i>this action produced</i>. Pre-existing Safe funds are untouchable (fork-tested: unrelated WETH/WXDAI in the Safe stay put to the wei).</div></div>
          </div>
        </div>

        {/* ---------- comparison ---------- */}
        <div className="arch-card">
          <h2>Comparison</h2>
          <table className="arch-tbl">
            <thead><tr><th></th><th>Model A — generic stack</th><th>Model B — specialized</th></tr></thead>
            <tbody>
              <tr><td>Scope</td><td className="can">Any protocol, any action: the pre/post are arbitrary Safe transactions; the flash layer wraps <i>any</i> chain. Leverage is one use case of many.</td><td>Aave leverage only (open / close).</td></tr>
              <tr><td>Composability</td><td className="can">Standard CoW wrapper chaining — add more wrappers, reuse each layer independently.</td><td>Self-contained; could itself be chained, but its logic isn&apos;t reusable elsewhere.</td></tr>
              <tr><td>Contracts to allowlist</td><td>2 (flash + safe wrapper)</td><td className="can">1</td></tr>
              <tr><td>What the Safe registers</td><td>order UID + expected fill + <b>hashes of 2 SafeTxs</b> (pre/post — incl. MultiSend batches, exact calldata fixed in advance)</td><td className="can">order UID + expected fill + <b>~8 semantic fields</b> (&quot;OPEN, WETH/WXDAI, flash 200, borrow 100.1&quot;)</td></tr>
              <tr><td>Settle-time payload</td><td>full pre/post calldata (hash-verified on-chain)</td><td className="can"><Code c="(safe, nonce)" /> — 2 words</td></tr>
              <tr><td>Amounts</td><td>pre-committed exactly at registration; stale market → re-register</td><td className="can">dynamic deltas (supplies <i>actual</i> swap proceeds; sells <i>actual</i> withdrawal) — robust to drift &amp; rounding</td></tr>
              <tr><td>Close payout</td><td>extra committed transfer, or equity stays in the Safe</td><td className="can">automatic surplus-delta payout to a <b>registered</b> recipient</td></tr>
              <tr><td>Integration effort</td><td>SDK must build MultiSend batches + hashes per action</td><td className="can">one registration call with readable fields</td></tr>
              <tr><td>Audit surface</td><td className="can">two small generic contracts (flash layer is ~150 lines, stateless); SafeWrapper already audited</td><td>one larger bespoke contract re-audited per product change</td></tr>
              <tr><td>Upgrading the product</td><td className="can">new behavior = new pre/post registrations — <b>no new contracts</b></td><td>new behavior = new wrapper version + allowlisting</td></tr>
              <tr><td>Trust model</td><td colSpan={2}>identical: Safe-only registration · transient bless (no bypass) · fill proof · one-shot · full-revert atomicity · flash repaid or everything unwinds</td></tr>
            </tbody>
          </table>
          <p className="arch-intro" style={{ marginTop: 10, fontSize: 13 }}>
            <b>Rule of thumb:</b> Model A is infrastructure — build it once and every future product (TWAP exits,
            collateral swaps, other money markets) rides the same two audited layers. Model B is product — the best UX
            and robustness for <i>this</i> use case, at the cost of generality. They share the enforcement core, so they
            can coexist: ship B for leverage UX while A serves as the general platform.
          </p>
        </div>

        {/* ---------- verification status ---------- */}
        <div className="arch-card">
          <h2>Verification status</h2>
          <table className="arch-tbl">
            <thead><tr><th>Item</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td>CoWSafeWrapper (generic pre/post)</td><td><span className="arch-sev ok">audited</span> multiple adversarial review rounds; 13/13 fork tests vs real settlement</td></tr>
              <tr><td>CowFlashLoanWrapper (generic flash layer)</td><td><span className="arch-sev ok">spec-reviewed + tested</span> 6/6 fork tests: full leverage open/close via the double-wrapper chain on real Aave V3, incl. attack rejections</td></tr>
              <tr><td>CowAaveLevWrapper (specialized)</td><td><span className="arch-sev ok">spec-reviewed + tested</span> 8/8 fork tests: open/close/payout + delta-protection + attack rejections; review-driven redesign (explicit registered amounts, delta accounting, registered payout)</td></tr>
              <tr><td>Production prerequisite</td><td><span className="arch-sev warn">pending</span> wrapper allowlisting by CoW (staging first, then CIP) — applies to either model</td></tr>
            </tbody>
          </table>
          <p className="arch-intro" style={{ marginTop: 10, fontSize: 13 }}>
            Application contracts are unaudited by an external firm; they build on the audited Safe v1.3.0, Aave V3,
            CoW Protocol core, and CoW DAO&apos;s <Code c="CowWrapper" /> base. Both end-to-end suites run against unmodified
            mainnet-fork state (real settlement, real Aave pool, real oracle prices).
          </p>
        </div>

        <p className="lev-foot" style={{ marginTop: 18 }}>
          <Link href="/leverage/architecture">account structure →</Link> · <Link href="/leverage">← back to the app</Link>
        </p>
      </div>
    </div>
  );
}
