# Codex review — v3 (receiver sweep, consolidated /leverage), 2026-06-12

Scope: LevManagerModule v3 / LevSupplyHelper v3 (closeAndSweep) / IntentBootstrap9,
frontend relay-execute + /leverage page, README accuracy. Commit reviewed: a60a579.

**Verdict: no direct contract theft path found** in the sweep/delegatecall flow for the
intended WXDAI/WETH staging pair. Findings + dispositions:

1. **medium · relay duplicate-drain** (relay-execute): concurrent submissions of one valid
   intent all pass simulation; all-but-one revert on `used` at the relay's expense.
   → FIXED: in-flight lock per (safe, nonce); duplicates get an immediate JSON error.
2. **medium · README overstated open flow**: claimed "supply ALL bought WETH" — IB9 supplies
   only `buyMin`; positive slippage stays as WETH in the Safe.
   → FIXED in README (and noted that the surplus IS swept to the receiver on full close).
   Supply-all on open (delegatecall post like INCREASE) is a candidate for the next bootstrap rev.
3. **low · minHF vacuous on full close** (no debt → HF ∞; `minBuy` is the real guard).
   → documented in README; the UI already signs `minHealthFactor = 0` on full close.
4. **low · fixed 5 bps flash premium**: a premium increase reverts closes; a decrease strands
   the difference in the flash wrapper. → documented in limitations; runtime premium read or
   wrapper refund is a hardening for the next rev.
5. **low · tuple parsing outside try** (relay-execute): malformed numerics → framework 500.
   → FIXED: parse inside try, JSON 400.
6. **low · stale open plan on fast account switch** (page): plan could briefly outlive the
   account that derived it. → FIXED: doOpen asserts plan.owner == connected account and
   carrier.receiver == plan.safe.
