# TWAP Safe — v2 plan

Goal: turn the prototype into a robust, well-designed TWAP app on par with CoW Swap's
TWAP UI, with proper quoting, fund recovery safety, persistence, and redemption.

## A. Quoting & pricing (CoW quote API)

- Server-side quote proxy (`/api/quote`) → CoW `POST /api/v1/quote` (avoids CORS, lets us
  cache + add the eip1271 fields). Sell-kind quotes.
- Quote **two** sizes and surface the difference:
  1. **Full size** (sell entire amount in one shot) → market `buyAmount_full`.
  2. **One TWAP leg** (`partSellAmount`) → `buyAmount_leg`; expected total = `buyAmount_leg × n`.
  - Show **price impact saved** = `(buyAmount_leg×n − buyAmount_full) / buyAmount_full`. This is
    the core value-prop of a TWAP (less impact by slicing).
- **Slippage tolerance** (price protection): user sets % (default 0.5%); `minPartLimit =
  buyAmount_leg × (1 − slippage)`. Auto-fills the limit so users don't hand-enter prices.
- Live re-quote on input change (debounced); show sell/buy per part + est. total.

## B. CoW-parity TWAP form

CoW model: **sell amount + number of parts + total duration**; part duration = total/parts
(read-only); price protection %; sell/buy per part read-only.
- Inputs: sell token, buy token, total sell, number of parts, **part interval preset**.
- **Interval presets: 1m / 5m / 15m / 1h** (the "full minute" requirement) + total-duration view.
- Derived/read-only: part sell, est. buy per part, min buy per part (after slippage), total duration.
- Validation mirrors the handler (n>1, 0<t≤365d, limits>0, sell≠buy).

## C. Redeem / sweep remaining funds

- The Safe is owner-controlled (threshold 1). Add a panel to:
  - **Cancel** remaining parts: `ComposableCoW.remove(orderHash)` (owner self-call via Safe exec).
  - **Sweep** remaining sell token (and any stuck buy token) back to the owner: Safe
    `execTransaction` with a single owner signature (approveHash / eth_sign / 1271).
- Implement via Safe `execTransaction` with the connected owner as the sole signer
  (pre-validated signature `r=owner,s=0,v=1` works when `msg.sender==owner`).

## D. Persistence (DB) + order-recovery

### The risk (now mild — allowance model)
With the **allowance model**, tokens are **never sent** to the undeployed Safe — the user only
grants an allowance, and the deploy tx pulls them via `transferFrom`. So funds can never be
stranded: if an order is never deployed, the user just revokes the approval and keeps their
tokens. The only thing that needs backing up is the ability to *deploy a pending order*, which
requires the exact `initializer` (= `setup(...)` calldata encoding owner + fallback handler +
the TWAP order). If that data is lost **everywhere** (user device + our system) the order can't
be deployed — but the user's funds are untouched. The layers below keep the initializer
recoverable anyway.

### Key insight
The `initializer` is fully determined by a tiny, low-entropy parameter set; everything else
is fixed constants (helper, handler, singleton, factory, saltNonce=0, salt=0, span=0,
appData=0). Variable: `{owner, sellToken, buyToken, receiver, totalSell, n, t, minPartLimit}`
≈ 7 values. So the recovery payload is tiny and the deploy tx is reconstructable from it.

### Mitigation layers (defense in depth)
1. **Deterministic reconstruction** — document the exact param→initializer derivation; any
   copy of the ~7 params reconstructs the deploy tx. (Already true; make it first-class.)
2. **Server DB** (primary, fast): persist every order *before* the Safe address is shown:
   full params + computed `initializer` + predicted address + status. SQLite now (file +
   backups); Postgres in prod. Keyed by predicted address & owner.
3. **On-chain registry (trustless backstop — answers "system AND user lose it"):**
   `TwapDeploymentRegistry.register(singleton, saltNonce, initializer)` computes the predicted
   address on-chain and emits `Registered(address indexed safe, address singleton, uint256
   saltNonce, bytes initializer)`. The app's relayer calls this **at order creation, before
   showing the Safe address** (cheap on Gnosis). Recovery = filter `Registered` by the
   address → get `initializer` → `createProxyWithNonce`. The chain is permanent and
   permissionless, so a pending order is **always** deployable by anyone, even with total off-chain loss.
4. **User-exportable recovery file** — downloadable JSON (params + initializer + address) and
   an import flow that reconstructs & deploys. Self-custody backup independent of us.
5. **Auto-deploy watcher (shrinks the risk window):** backend watches predicted addresses;
   when the owner's allowance to the Safe ≥ required (and balance ≥ required), it submits
   `createProxyWithNonce` (permissionless; owner stays the user). The setup pulls the tokens
   via `transferFrom` at deploy. Approve→deployed window becomes seconds, and we hold the data.
6. **UX guardrails:** don't reveal the Safe address until (DB write ✓ AND registry tx ✓);
   "I've saved my recovery file" gate; warn that this is a fresh undeployed address.

### Chosen default
Layers 1+2+3+4 always on; layer 5 (auto-deploy) optional but recommended. With the allowance
model the headline guarantee is even stronger: **funds are never at risk** (they stay in the
wallet until deploy), and the on-chain registry (3) means a pending order is **always
deployable** by anyone.

## E. Redesign / polish
- Clear 3-step flow (Configure → Review/quote → Approve & auto-deploy), better visual hierarchy,
  status surfacing, recovery export, order history (from DB), per-part fill progress.

## Test strategy
- Contracts: `forge build` + fork tests (existing) + new `TwapDeploymentRegistry` test
  (predicted addr in event matches real deployment on a Gnosis fork).
- Web SDK: vitest for quote math (full vs leg, slippage→minPartLimit), interval/duration
  derivation, recovery file round-trip, address prediction (existing vector).
- App: typecheck + `next build`; manual end-to-end already proven on Gnosis.
