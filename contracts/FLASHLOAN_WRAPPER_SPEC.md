# Spec: flash-loan-enabled CoW wrapper stacks for Aave leverage

Status: **IMPLEMENTED + REVIEWED + E2E-VERIFIED** (see changelog at bottom). Builds on
`WRAPPER_SPEC.md` (CoWSafeWrapper, audited GO). Chain: Gnosis. Both designs are standard
`ICowWrapper`s (inherit CoW DAO's `CowWrapper` base).

> Outcome summary: Model A (`src/CowFlashLoanWrapper.sol` + existing CoWSafeWrapper) — spec review
> "conditionally sound", final audit **GO**; 6/6 e2e fork tests (leverage open 2x + close on real Aave
> + real settlement via the double-wrapper chain). Model B (`src/CowAaveLevWrapper.sol`) — spec review
> demanded delta-accounting/explicit-amounts/registered-payout (all implemented); final audit found one
> High (bless window could span downstream wrappers) → fixed by requiring it to be the FINAL wrapper;
> 9/9 e2e fork tests incl. delta-protection and the final-wrapper guard. Audit hardenings applied to
> both: stranded-funds protection (own-balance snapshots before repay), duplicate-asset rejection (A),
> vault-relayer allowance reset after settle (B), partial-close semantics documented (B).
> Architecture comparison page: web `/leverage/wrappers`.

## Problem

`CoWSafeWrapper`'s pre/post are discrete call frames around `settle`; a flash loan must be borrowed and
repaid within ONE frame, so it cannot span the settlement. Leveraged OPEN/CLOSE need exactly that
(flash-borrow → swap in settlement → repay from proceeds). Two solutions, built and compared:

---

# Model A — generic stack: `CowFlashLoanWrapper` → `CoWSafeWrapper`

Two chained wrappers. The first provides flash liquidity *around* the rest of the chain; the second
(unchanged, already audited) enforces the Safe's hash-committed pre/post around `settle`.

## A.1 `CowFlashLoanWrapper` (new, generic, stateless)

A pure liquidity layer with **no authorization registry**: its safety is the atomicity of flash-loan
repayment. Anyone's funds can't be touched — it holds nothing between txs; a mis-specified loan simply
fails to repay and the whole tx reverts.

```solidity
contract CowFlashLoanWrapper is CowWrapper /* + Aave IFlashLoanReceiver */ {
    IAavePool public immutable POOL;            // Aave V3 pool (per deployment)
    struct Loan { address token; uint256 amount; address recipient; }
    // wrapperData = abi.encode(Loan[])  (1..MAX_LOANS; one aggregated POOL.flashLoan call)
}
```

### Flow
```
_wrap(settleData, wrapperData, remainingWrapperData):
    require(transient FL_IN == 0); FL_IN = 1
    loans = abi.decode(wrapperData)
    POOL.flashLoan(receiver=this, tokens, amounts, modes=0…, onBehalfOf=this,
                   params=abi.encode(settleData, remainingWrapperData, recipients), 0)
    FL_IN = 0

executeOperation(assets, amounts, premiums, initiator, params):   // Aave callback
    require(msg.sender == POOL && initiator == address(this) && FL_IN == 1)
    (settleData, remaining, recipients) = abi.decode(params)
    for each loan: ERC20.transfer(recipient, amount)            // deliver liquidity
    _nextMem(settleData, remaining)                              // continue chain → … → settle
    for each loan: ERC20.approve(POOL, amount + premium)         // repay from OWN balance
    return true                                                  // pool pulls; insufficient → revert
```

- **`_nextMem`**: memory-args re-implementation of the base's `_next` (same semantics incl. settle
  selector check and next-wrapper magic-value check). Needed because the continuation crosses the Aave
  callback boundary (params are re-decoded memory, the base `_next` takes calldata). ⚠ review point.
- **Repayment funding**: the wrapper repays from its **own balance** after `_next` returns. Whoever
  needs the loan must route `amount+premium` back to the wrapper before then — e.g. the Safe's
  registered `post` (inside CoWSafeWrapper, which runs within `_nextMem`) transfers the repayment.
- **Solver-supplied loans are unauthorized by design**: a bogus/oversized loan can only revert (nothing
  funds its repayment); recipients receive funds they never asked for at worst (and the tx still
  reverts unless repaid). No registry needed. ⚠ review point: confirm no grief/abuse path.
- **Callback gating**: `msg.sender==POOL ∧ initiator==this ∧ FL_IN` — a third party calling
  `POOL.flashLoan(receiver=thisWrapper, …)` produces `initiator != this` → revert.
- Both wrappers must be CoW-allowlisted (chain rule: each wrapper checks `isSolver(caller)`, and the
  settlement checks `isSolver(lastWrapper)`).

## A.2 Leverage flows on the generic stack (Gnosis: WXDAI debt, WETH collateral)

Multi-call pre/post use **`MultiSendCallOnly`** (canonical Safe v1.3.0 `0x40A2aCCb…49130D`) via the
SafeTx `operation = 1` (DELEGATECALL) that CoWSafeWrapper already supports — MultiSendCallOnly executes
its inner txs CALL-only, so the delegatecall is batching-only, hash-committed by the Safe.

**OPEN (equity E, leverage X)** — flash F = X·E of WXDAI:
- chain data: FlashLoanWrapper: `[{WXDAI, F, recipient: safe}]` · CoWSafeWrapper: `OrderExec{safe, nonce, pre, post}`
- order: sell F WXDAI → ≥ minBuy WETH (fok), owner = safe
- registered `pre` (CALL): `WETH.approve(POOL, max)`
- registered `post` (DELEGATECALL MultiSendCallOnly): `POOL.supply(WETH, buyAmount, safe)` ·
  `POOL.borrow(WXDAI, F+prem−E, 2, 0, safe)` · `WXDAI.transfer(flashWrapper, F+prem)`
- result: collateral = buyAmount WETH, debt = F+prem−E WXDAI, flash repaid, nothing left over.

**CLOSE** — flash R ≥ debt of WXDAI:
- registered `pre` (DELEGATECALL MultiSend): `WXDAI.approve(POOL, R)` · `POOL.repay(WXDAI, max, 2, safe)` ·
  `POOL.withdraw(WETH, max, safe)` · `WETH.approve(vaultRelayer, sellAmount)`
- order: sell (known) collateral WETH → ≥ minOut WXDAI
- registered `post` (CALL or MultiSend): `WXDAI.transfer(flashWrapper, R+prem)` (+ optional payout txs);
  remaining equity stays in the Safe (owner controls it).

Properties: everything the Safe does is hash-committed at registration; the loan is solver-supplied
but self-securing; all-or-nothing across (flash → pre → swap → post → repay).

---

# Model B — specialized: `CowAaveLevWrapper` (one wrapper, leverage-aware)

One wrapper that *understands* the leverage use case: it takes the flash loan itself AND performs the
Aave operations itself as the Safe (it is a Safe module), so there are **no generic pre/post blobs** —
the Safe registers small **semantic params** instead, and amounts can be **dynamic** (`balanceOf` at
execution) rather than pre-committed.

```solidity
struct LevParams {
    bytes   uid;            // CoW order UID (56B); digest blessed during settle
    uint256 expectedFill;   // ≥ check after settle
    uint8   kind;           // 0 OPEN · 1 CLOSE
    address collateral;     // e.g. WETH
    address debt;           // e.g. WXDAI
    uint256 flashAmount;    // F (open) or R (close)
    uint64  deadline;       // 0 = none
    uint8   status;         // 0/1/2 like MetaOrder
}
registerLeverage(uint256 nonce, LevParams p)   // direct Safe CALL; uid owner == msg.sender
// wrapperData = abi.encode(safe, nonce)       // one action per wrapped settlement (v1)
```

### Flow (inside `_wrap` → flash callback)
```
load p = lev[safe][nonce]; require status==1; status=2 (freeze); deadline check; filledBefore==0
POOL.flashLoan(this, [p.debt], [p.flashAmount], …)
executeOperation:
    debt.transfer(safe, flashAmount)
    if CLOSE (pre-settle, as the Safe via module):
        approve(POOL, flashAmount); repay(debt, max, 2, safe); withdraw(collateral, max, safe);
        approve(vaultRelayer, collateral balance)
    bless(uid digest) → _nextMem(settleData, remaining) → unbless; require filled ≥ expectedFill
    if OPEN (post-settle, as the Safe):
        approve(POOL, collateral) ; supply(collateral, balanceOf(safe), safe)          // DYNAMIC amount
        borrow(debt, flashAmount+prem − debtToken.balanceOf(safe), 2, 0, safe)         // exact repay math
        transfer(debt, wrapper, flashAmount+prem)
    if CLOSE (post-settle):
        transfer(debt, wrapper, flashAmount+prem)
        sweep remaining debt-token balance → Safe owner (getOwners()[0], like v4 — no recipient arg)
    approve(POOL, flashAmount+prem); return true
```

- Same `isBlessed` interface → a second `CoWSafeSigHandler` instance pointing at this wrapper serves as
  the Safe's fallback handler.
- The wrapper is the Safe's enabled module (like CoWSafeWrapper) and executes the Aave ops directly via
  `execTransactionFromModule` — multiple calls, no MultiSend needed.
- Registration is ~6 small fields; UX = "register {OPEN, WETH, WXDAI, flash 200}" instead of encoding
  pre/post calldata + hashes.

---

# Comparison (to be expanded on the website)

| | A: generic stack | B: specialized |
|---|---|---|
| composability | any protocol, any pre/post, chainable further | Aave leverage only |
| wrappers to allowlist | 2 (flash + safe) | 1 |
| Safe registration | uid + expectedFill + 2 SafeTx hashes | uid + 6 semantic fields |
| settle-time data | full pre/post calldata (hash-checked) | (safe, nonce) only |
| amounts | pre-committed exactly (incl. MultiSend batches) | dynamic (`balanceOf` at exec) |
| payout on close | extra committed transfer or stays in Safe | automatic sweep to owner |
| audit surface | FlashLoanWrapper (small) + CoWSafeWrapper (audited) | one bigger bespoke contract |
| failure mode | revert (committed amounts can go stale → re-register) | revert (dynamic amounts more robust) |

# Adversarial review brief (Codex)

Attack BOTH designs. Specifically:
1. **Unbundling** anywhere: pre without settle, settle without post, loan without repay, repay from the
   wrong party, partial application after any revert point.
2. **FlashLoanWrapper abuse**: solver-supplied `Loan[]` with hostile token (malicious ERC20 callbacks /
   reentrancy into `_wrap`/`executeOperation`), hostile recipient, loans aimed at OTHER protocols'
   balances; `initiator`/`FL_IN` gating; third-party `POOL.flashLoan(receiver=wrapper)`; nested chains
   containing the flash wrapper twice; `_nextMem` divergence from base `_next` (selector check,
   magic-value check, memory slicing bugs).
3. **Repayment-funding confusion**: can Safe A's post end up repaying Safe B's loan (cross-subsidy) in a
   multi-loan batch? Is per-loan accounting needed, or is whole-batch atomicity acceptable?
4. **Specialized wrapper**: dynamic `balanceOf` amounts — can a solver or third party inflate/deflate
   balances mid-flow (e.g. donate tokens) to skew supply/borrow/sweep? Frozen-params adequacy; the
   owner-sweep (`getOwners()[0]`) assumptions; module-exec ordering; one-action-per-settle limit.
5. **Cross-wrapper interactions**: FlashLoanWrapper → CoWSafeWrapper epoch/T_IN interplay; can the chain
   contain CoWSafeWrapper twice (re-entry guard) or FlashLoanWrapper inside CoWSafeWrapper's pre/post?
6. Aave specifics: flashLoan premium math, repay(max) with mode 2, withdraw(max) aToken rounding,
   supply-then-borrow health checks mid-tx, same-block interest accrual assumptions.
For each finding: severity, exact sequence, fix. Verdict per design: sound to implement?
