# On-chain Leverage — implementation plan

Turn the CoW-Swap leverage UI (frontend mockup in this repo) into a **real, on-chain** product on
Gnosis staging (barn), reusing the proven wrapper stack. Open positions with one signature (carrier
order); manage them (close / partial close / increase-lev / decrease-lev / add-equity / withdraw-equity)
via an **owner-signed intent** that **anyone can relay**. No solver privilege is used — organic barn
solvers fill everything.

## Background (already proven, this is the foundation)
- **CoWSafeWrapper** `0x531636e6…` (whitelisted): enforces a Safe's committed pre/post around a CoW
  settlement, validated by a registered meta-order (uid + preHash + postHash) and a transient "bless".
- **CowFlashLoanWrapper** `0x2E3fdEe2…` (whitelisted): Aave V3 flash layer, trampoline-committed.
- **IntentBootstrap6** `0x5eCCd048…`: from a high-level Intent → deploy the user's deterministic Safe,
  reconstruct the leverage order's appData + UID **on-chain**, register the meta-order. Used as the
  pre-hook of the user's **carrier order** (one signature) → solver deploys + opens. PROVEN, codex MET.
- **CloseHelper** `0x91886ba7…`: view-derives a close meta-order (appData/uid/registerCalldata) from the
  live position. Used today via an owner-signed Safe tx + relay. PROVEN.
- The position Safe is a 1/1 Safe owned by the user, with modules [CoWSafeWrapper, IntentBootstrap6] and
  fallback handler CoWSafeSigHandlerSim2 (bless + sim-validity for eip1271 `0x` orders).

## The new core: `LevManagerModule` (signed-intent management)
A single shared, immutable module enabled on every position Safe (added to the Safe's module list at
open time). It turns an **owner-signed `ManageIntent`** into a registered CoWSafeWrapper meta-order, so
the user signs once (gasless) and anyone (a relay) lands it.

```
struct ManageIntent {
  address safe;          // the position Safe
  uint256 nonce;         // module-level replay nonce (per safe)
  uint256 deadline;      // intent expiry
  uint8   action;        // 0 Close, 1 DecreaseLev, 2 IncreaseLev, 3 AddEquity, 4 WithdrawEquity
  address collateral;    // position collateral token (e.g. WETH)
  address debt;          // position debt token (e.g. WXDAI)
  uint256 amount;        // action-specific: collateral to sell / debt to add / equity in / etc.
  uint256 minOut;        // worst-case swap output (frontend computes from a fresh quote + slippage)
  uint256 flash;         // flash-loan size (0 if none); repay derived = flash + ceil(premium)
  uint32  orderValidTo;  // CoW order validity
  uint256 metaNonce;     // CoWSafeWrapper meta-order nonce (unused)
  address receiver;      // for Withdraw/Close: where residual equity goes (default = safe)
}
```

`execute(ManageIntent intent, bytes ownerSig)` (permissionless):
1. `block.timestamp <= intent.deadline`.
2. recover EIP-712 signer; require it is an owner of `intent.safe` (1/1 Safe → the user).
3. `!used[safe][nonce]` → mark used (replay protection).
4. **Derive the canonical pre/post for `action` ON-CHAIN** (per-action builder; user signs the
   high-level intent, NOT opaque calldata — the module builds the dangerous calldata deterministically,
   which is the security property codex flagged).
5. compute the GPv2 order UID + appData on-chain (IntentBootstrap pattern).
6. `safe.execTransactionFromModule(WRAPPER, registerMetaOrder(metaNonce, meta))`.
7. emit `Registered(safe, uid, appDataHash, fullAppData)` so the relayer/frontend submits the CoW order.

### Per-action pre/post (all use Aave `max` semantics for moving amounts → no dust)
- **Close (full)**: order sells `collateral` (amount=live aToken bal) → `debt`; pre = [approve debt→pool,
  repay(debt, MAX), withdraw(collateral, MAX), approve collateral→relayer]; flash `debt*1.03`; post =
  transfer `repay` to flash wrapper. Residual `debt` token → receiver (or stays in safe).
- **Partial Close**: same but amount = a fraction of collateral; flash sized to the proportional debt;
  repay proportional. (Aave repay is the proportional debt, computed; or repay MAX of a sub-amount —
  needs care: partial close repays only part of the debt → flash = that part.)
- **DecreaseLev**: sell `amount` collateral → debt, repay that much debt (no equity out). flash to
  bridge; pre withdraws `amount` collateral, sells, repays.
- **IncreaseLev**: borrow `amount` more debt → sell for collateral → supply. flash not needed (borrow
  first), or flash collateral. pre = [borrow(debt, amount), approve relayer]; order sells debt→collateral;
  post = supply bought collateral.
- **AddEquity**: pull `amount` of a token from the owner (needs the order to deliver it, or a transfer);
  supply as collateral / repay debt. (May piggyback a small carrier or use the order receiver.)
- **WithdrawEquity**: withdraw `amount` collateral → optionally sell → receiver. Must keep HF safe.

> Each builder is ~CloseHelper-sized. Build + unit/fork test each before wiring the UI.

## Frontend (real, matching the mockup's features)
Implement in the live app. Reuse `/onboard` pieces. Pages/flows:
- **Open** (done): one carrier signature → position.
- **Positions list**: read the user's Safes (from a registry / events) + live coll/debt/HF/liq-price.
- **Manage**: leverage slider (increase/decrease), close with % (25/50/75/Max) — each builds a
  `ManageIntent`, gets a fresh quote, the user signs once, the relay (`/api/relay` → module.execute)
  lands it, the CoW order is submitted, status polled, position refreshed.
- **Quotes for all trades** incl. plain (non-leverage) swaps from the Safe.

## Test strategy (regular on-chain, no solver privilege)
- Fork tests (forge) for each module action against real Aave + settlement.
- Live barn tests: open a small position, then each management action via signed-intent + relay; verify
  on-chain end state; diagnose failures with the CoW debugger (debug.barn.cow.fi).
- Economical: ~0.01–0.05 WXDAI per position; reuse positions across actions where possible.

## Phases & checkpoints (codex review at each ★)
1. ★ This plan.
2. `LevManagerModule` skeleton + Close action; fork test; deploy; live close via signed intent. ★
3. DecreaseLev + IncreaseLev builders; fork + live. ★
4. Partial close + Add/Withdraw equity; fork + live. ★
5. Frontend: positions list + manage (close %, lev slider) wired to module + relay. ★
6. Quotes for all trades, polish, docs, final review. ★

## Security notes (carry from codex's prior reviews)
- User signs the **intent**, module derives calldata → no opaque-calldata signing.
- Replay nonce per safe; intent deadline.
- minOut is the user's price floor (oracle-relative is a future hardening; v1 uses a fresh-quote minOut
  signed at action time — fine for immediate management).
- Module verifies signer is a Safe owner; 1/1 Safe assumption documented.
- Relay can only land what the owner signed; it cannot forge intents.
- Idempotent registration; HF-safety checks where withdrawals happen.
