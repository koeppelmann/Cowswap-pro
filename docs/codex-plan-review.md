Reading prompt from stdin...
OpenAI Codex v0.137.0
--------
workdir: /tmp
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: none
reasoning summaries: none
session id: 019eb8d7-979b-7452-8fe0-2ff915804dbc
--------
user
Review this architecture plan for an on-chain leverage-management system on Gnosis (CoW Protocol staging). Focus on DESIGN soundness, security, and whether the action set is complete/correct. Be adversarial and concrete. This is the plan before building — catch design flaws now.

CONTEXT (already built + proven on-chain):
- CoWSafeWrapper (whitelisted CoW solver): enforces a Safe's committed pre/post Safe-transactions around a CoW settlement. A meta-order is registered on it as {uid, expectedFill, preHash, postHash}; at settle it checks keccak(pre)==preHash, runs pre AS the Safe, sets a transient bless flag (so the order's eip1271 validates), settles, checks filledAmount>=expectedFill, runs post.
- CowFlashLoanWrapper (whitelisted): Aave V3 flash layer, chained before CoWSafeWrapper.
- IntentBootstrap: from a high-level Intent, reconstructs a leverage order's appData+UID ON-CHAIN and registers the meta-order via the Safe module. Used as a pre-hook on the user's carrier order to OPEN (one signature). Proven.
- CloseHelper: view-derives a close meta-order from the live position. Used today via owner-signed Safe tx + relay. Proven (closed a real position; debt/coll -> 0).
- Position Safe = a 1/1 Safe owned by the user EOA. Modules: [CoWSafeWrapper, IntentBootstrap]. Fallback handler validates the leverage order's eip1271 "0x" signature via the bless flag.
- Aave repay/withdraw use type(uint256).max for exact (no-dust) debt/collateral handling. Flash repay = flash + ceil(5bps premium) (Aave rounds the premium UP; flooring is 1 wei short -> "underfunded").

NEW CORE TO REVIEW: a shared immutable module `LevManagerModule`, enabled on each position Safe, that turns an owner-signed `ManageIntent` into a registered CoWSafeWrapper meta-order (relayable by anyone). Struct:
  ManageIntent { address safe; uint256 nonce; uint256 deadline; uint8 action; address collateral; address debt; uint256 amount; uint256 minOut; uint256 flash; uint32 orderValidTo; uint256 metaNonce; address receiver; }
execute(intent, ownerSig):
  1. require block.timestamp <= deadline
  2. recover EIP-712 signer; require it's an owner of intent.safe (1/1 Safe)
  3. require !used[safe][nonce]; mark used
  4. derive the canonical pre/post for `action` ON-CHAIN (per-action builder; user signs the high-level intent, NOT opaque calldata)
  5. compute GPv2 order uid + appData on-chain
  6. safe.execTransactionFromModule(WRAPPER, registerMetaOrder(metaNonce, meta))
  7. emit Registered(safe, uid, appDataHash, fullAppData) so the relayer submits the CoW order
Actions: 0 Close(full), 1 DecreaseLev (sell `amount` collateral -> repay debt), 2 IncreaseLev (borrow `amount` debt -> buy collateral -> supply), 3 AddEquity, 4 WithdrawEquity. Partial close = Close with amount<full.

QUESTIONS:
Q1. Is the signed-intent + module-derives-calldata design sound? Does verifying `signer is a Safe owner` correctly gate authority for a 1/1 Safe? Any way a relayer or third party abuses execute() to harm the owner (front-run with a different intent, replay across safes, grief by consuming nonces, register a wrong order)? Is `used[safe][nonce]` the right replay key, and should the EIP-712 domain bind chainId + module address + safe?
Q2. The intent carries amount/minOut/flash/metaNonce computed off-chain by the frontend from a fresh quote + live position. The module re-derives pre/post from action+amount but TRUSTS minOut/flash/metaNonce as signed. Risks: (a) stale minOut if relay is delayed; (b) flash too small to cover debt that grew since signing -> revert (safe, just fails); (c) a malicious relayer picks an already-used metaNonce -> registration reverts (griefs that nonce). How should metaNonce be chosen to avoid griefing? Should the module derive metaNonce itself (e.g. from the module nonce) instead of trusting the signed value?
Q3. Action correctness: for IncreaseLev, "borrow debt -> sell debt for collateral -> supply collateral", does this need a flash loan at all? For DecreaseLev "sell collateral -> repay debt", you must withdraw collateral first, but withdrawing while debt exists is limited by LTV; is a flash needed to repay-first then withdraw-then-sell-then-repay-flash? Walk through each action's atomic ordering and flag any that can't be done without violating Aave LTV mid-transaction.
Q4. Partial close as "Close with amount<full": full close uses repay(MAX)+withdraw(MAX). For partial, you can't use MAX. How do you size the partial debt repayment and collateral withdrawal so the position stays at the same leverage (or a target), without leaving dust or tripping LTV? Is "sell X collateral, repay the proportional debt" well-defined, and what proportional debt formula keeps HF constant?
Q5. AddEquity / WithdrawEquity: AddEquity must pull tokens from the owner — but the CoW order's sell side comes from the Safe, not the owner. How does equity get IN (a second carrier? an allowance + module transferFrom in pre?)? WithdrawEquity reduces collateral -> must keep HF > 1; where is that checked? Are these two actions well-posed, or should they be deferred?
Q6. Anything missing from the action set for a one-collateral/one-debt position? Is there a cleaner generalization (e.g. a single "retarget to (collateral', debt')" primitive) that the 5 actions are special cases of, and would that be safer/simpler to implement and verify than 5 separate builders?
Q7. Overall: is this plan ready to build, or are there must-fix design changes first? List them ordered by severity.

warning: Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.
codex
This is not ready to build as written. The module pattern is directionally sound, but the action semantics are under-specified in ways that will produce either unsafe orders, stuck positions, or builders that only work accidentally for one leverage direction.

**Highest Severity Findings**

1. **The EIP-712 domain must bind `chainId`, `LevManagerModule`, and ideally `safe`.**

   `signer is owner of intent.safe` is necessary, but not sufficient unless the signed message is unambiguously scoped.

   Required:
   - EIP-712 domain includes `chainId`.
   - EIP-712 domain includes `verifyingContract = LevManagerModule`.
   - `ManageIntent.safe` is part of the signed struct.
   - `execute()` requires `msg.sender` need not be trusted, but all authority must come from the signature.
   - The module should verify that `address(this)` is enabled on `intent.safe`, otherwise signatures may authorize actions on Safes that cannot execute or were not intended for this module.

   Replay key should be:

   ```solidity
   used[intent.safe][intent.nonce]
   ```

   That is fine if `safe` is signed and the domain binds chain/module. Without those bindings, signatures can replay across chains, module deployments, or systems using the same struct.

2. **`metaNonce` should not be caller-controlled or frontend-selected.**

   A malicious or careless relayer should not be able to cause registration conflicts by choosing or racing a bad `metaNonce`.

   Best option: derive it in the module from the signed intent nonce or from a module-managed monotonic counter.

   For example:

   ```solidity
   metaNonce = uint256(keccak256(abi.encode(
       block.chainid,
       address(this),
       intent.safe,
       intent.nonce,
       intent.action
   )));
   ```

   Or simpler: use `intent.nonce` directly if CoWSafeWrapper namespaces meta-orders by Safe/module sufficiently.

   I would remove `metaNonce` from the signed intent unless the wrapper has a strong reason to expose it. The user signs the management intent; the module should derive the registration identity canonically.

3. **Decrease leverage cannot generally be “withdraw collateral -> sell -> repay debt” without a flash loan.**

   Withdrawing collateral first lowers health factor before debt is repaid. If the position is near its target leverage, that withdrawal may violate Aave’s collateral constraints.

   Safer atomic sequence for decrease / partial close is usually:

   1. Flash borrow debt asset.
   2. Repay Aave debt.
   3. Withdraw collateral.
   4. Sell withdrawn collateral for debt asset via CoW.
   5. Repay flash loan plus premium.
   6. Optionally repay residual debt or return surplus.

   Without flash, decrease only works when the requested collateral withdrawal is allowed at the current debt level. That is not generally true for leveraged positions.

4. **Increase leverage likely does not need flash.**

   For `IncreaseLev`, the natural sequence is:

   1. Borrow debt from Aave.
   2. Sell borrowed debt for collateral through CoW.
   3. Supply bought collateral to Aave.

   The risky point is after borrowing and before supplying, health factor decreases. This is valid only if the incremental borrow is allowed by Aave at that moment.

   A flash loan is not inherently needed unless you are trying to avoid intermediate HF checks or support a path where borrow-first is not allowed. But Aave will enforce borrow limits at borrow time anyway. If the Safe can borrow the debt amount, the sequence can work without flash. If it cannot borrow, flash does not magically make the final position valid.

   So `flash` should probably be action-specific:
   - `IncreaseLev`: usually no flash.
   - `DecreaseLev` / `Close`: usually flash debt asset.
   - `WithdrawEquity`: maybe no flash if withdrawal allowed; otherwise impossible unless debt is first reduced.
   - `AddEquity`: no flash needed.

5. **Partial close is not just “Close with amount < full.”**

   Full close can use `repay(MAX)` and `withdraw(MAX)` because the target is zero debt and zero collateral. Partial close cannot.

   You need an explicit target model.

   If the goal is to preserve the same leverage / HF, then selling `x` collateral and repaying “proportional debt” is meaningful, but the formula must account for prices and liquidation parameters.

   Let:

   - `C` = collateral amount
   - `D` = debt amount
   - `Pc` = collateral price
   - `Pd` = debt price
   - `LT` = liquidation threshold
   - Current HF:

   ```text
   HF = C * Pc * LT / (D * Pd)
   ```

   If withdrawing/selling `x` collateral and repaying `y` debt while preserving HF:

   ```text
   (C - x) * Pc * LT / ((D - y) * Pd) = C * Pc * LT / (D * Pd)
   ```

   Simplifies to:

   ```text
   y = D * x / C
   ```

   So proportional debt repayment preserves HF if prices and LT are unchanged.

   But execution uses swap proceeds, not abstract value. If selling `x` collateral yields less than `y` debt due to price movement/slippage, the post-state has lower HF. Therefore the order must enforce enough bought debt to repay the chosen `y` plus flash premium, or the post-hook must revert.

   For target leverage, use a target debt/collateral ratio instead of “amount means collateral sold.” The module should compute:

   ```text
   targetDebt = targetCollateralValue * targetBorrowRatio
   debtToRepay = currentDebt - targetDebt
   collateralToWithdraw = currentCollateral - targetCollateral
   ```

   Current plan does not define this rigorously enough.

6. **`minOut` alone is not enough. Post-state checks are mandatory.**

   The CoW order can enforce sell/buy amounts, but the security property is the final Aave position.

   Every action should have explicit postconditions, checked on-chain in the post hook or by the module-generated post transaction:

   - Expected debt reduced/increased within bounds.
   - Expected collateral reduced/increased within bounds.
   - Health factor above signed minimum.
   - No unexpected token residue beyond allowed dust policy.
   - Flash loan repayment amount covered, including rounded-up premium.
   - Receiver only receives assets explicitly allowed by the signed intent.

   I would add fields like:

   ```solidity
   uint256 minHealthFactor;
   uint256 maxDebt;
   uint256 minCollateral;
   uint256 maxCollateral;
   ```

   For close, postcondition should be debt == 0 and collateral == 0 or within known dust bounds.

7. **AddEquity is not well-posed unless funding is solved.**

   The CoW sell token comes from the Safe. If the owner holds the token, the module cannot magically sell it from the owner.

   Viable designs:
   - Owner pre-funds the Safe before calling `execute()`.
   - Owner signs ERC-2612 / Permit2 authorization and the module pulls funds in the pre-hook.
   - Use a carrier order from owner funds, as with bootstrap.
   - Require relayer-provided funds is unsafe unless signed and bounded.

   If using `transferFrom(owner, safe, amount)`, the signed intent must bind:
   - token
   - amount
   - max amount
   - owner
   - deadline
   - receiver/safe
   - permit nonce if applicable

   Otherwise AddEquity should be deferred.

8. **WithdrawEquity is also under-specified.**

   Withdrawing collateral while debt remains must preserve HF. The module must either:
   - compute max withdrawable from live Aave data and signed minimum HF, or
   - accept a signed withdrawal amount and enforce post-HF.

   The `receiver` field is dangerous here. It must be signed, nonzero, and probably default to the Safe owner. For close/decrease, arbitrary receiver should not be able to siphon swap surplus unless explicitly intended.

**Per-Action Ordering**

`Close(full)`:

```text
flash borrow debt
repay Aave debt with flashed debt
withdraw all collateral
sell collateral for debt
repay flash + rounded-up premium
send surplus to receiver / Safe owner
postcheck debt == 0, collateral == 0
```

This is sound if `minOut >= flash + premium` and postconditions are strict.

`DecreaseLev`:

```text
flash borrow debtToRepayFirst
repay Aave debt
withdraw collateralToSell
sell collateral for debt
repay flash + premium
optionally repay extra debt or return surplus
postcheck HF >= minHealthFactor and debt/collateral bounds
```

This usually needs flash.

`IncreaseLev`:

```text
borrow debt amount from Aave
sell debt for collateral
supply collateral
postcheck HF >= minHealthFactor and debt/collateral bounds
```

Usually no flash. Must ensure the borrow itself is valid before the later collateral supply.

`AddEquity`:

```text
pull collateral or debt token from owner into Safe, or require Safe pre-funded
if debt token: optionally sell debt token for collateral
supply collateral, or repay debt, depending on intent
postcheck HF improved / bounds satisfied
```

As written, incomplete.

`WithdrawEquity`:

```text
withdraw signed collateral amount
send to receiver
postcheck HF >= minHealthFactor
```

Only valid if Aave allows the withdrawal before any later action. If not, the action must first repay debt, which makes it a decrease/retarget operation.

**Cleaner Generalization**

A safer model is a single `RetargetPosition` primitive:

```solidity
RetargetIntent {
    safe;
    nonce;
    deadline;
    collateral;
    debt;
    targetCollateral;
    targetDebt;
    maxCollateralIn;
    minCollateralOut;
    maxDebtIn;
    minDebtOut;
    minHealthFactor;
    receiver;
    orderValidTo;
}
```

Then builders derive whether the transition requires:
- borrow then buy/supply,
- flash repay then withdraw/sell,
- repay from owner funds,
- withdraw surplus collateral,
- full close.

This is easier to verify than five separate action builders because every action reduces to:

```text
current position -> target position
```

with explicit asset deltas and postconditions.

The five named actions can remain frontend presets, but I would avoid making them five independent low-level protocol paths unless absolutely necessary.

**Other Concrete Risks**

- `collateral` and `debt` must match the actual position or supported market pair. Do not let the user sign arbitrary token addresses that cause builders to interact with unsupported reserves.
- `receiver` should be restricted or signed with explicit surplus policy.
- `orderValidTo` should be checked against `deadline`; avoid an intent valid for execution briefly but a CoW order valid much longer than the user expects.
- `fullAppData` emitted on-chain may be expensive. If needed for relayers, fine, but consider whether the canonical appData can be reconstructed off-chain from event fields.
- `expectedFill` should be derived conservatively from the exact debt/flash requirement, not just frontend quote size.
- If `used` is marked before registration and registration reverts, the revert rolls back the mark, so that is okay.
- If registration succeeds but the order never settles, the management nonce is consumed. That is expected, but UX needs cancellation/replacement using a new nonce.

**Must-Fix Before Build**

1. Define the exact per-action Aave ordering, especially decrease and partial close.
2. Replace `metaNonce` as signed/frontend input with module-derived deterministic identity.
3. Add signed and enforced post-state bounds: `minHealthFactor`, `maxDebt`, `minCollateral`, and action-specific dust/surplus rules.
4. Redesign partial close around explicit target debt/collateral or mathematically defined proportional reduction.
5. Solve AddEquity funding explicitly or remove it from v1.
6. Make WithdrawEquity enforce live HF constraints and signed receiver policy.
7. Bind EIP-712 domain to `chainId` and module address; keep `safe` inside the signed struct.
8. Treat the five actions as frontend presets over a retarget primitive if possible.

The core idea, “owner signs high-level intent and immutable module derives canonical Safe calldata,” is good. The weak part is the current action set: it mixes user-facing verbs with underdefined Aave state transitions. Build the module around explicit target state and strict postconditions, then expose Close/Increase/Decrease/Add/Withdraw as convenience modes.
tokens used
6,420
This is not ready to build as written. The module pattern is directionally sound, but the action semantics are under-specified in ways that will produce either unsafe orders, stuck positions, or builders that only work accidentally for one leverage direction.

**Highest Severity Findings**

1. **The EIP-712 domain must bind `chainId`, `LevManagerModule`, and ideally `safe`.**

   `signer is owner of intent.safe` is necessary, but not sufficient unless the signed message is unambiguously scoped.

   Required:
   - EIP-712 domain includes `chainId`.
   - EIP-712 domain includes `verifyingContract = LevManagerModule`.
   - `ManageIntent.safe` is part of the signed struct.
   - `execute()` requires `msg.sender` need not be trusted, but all authority must come from the signature.
   - The module should verify that `address(this)` is enabled on `intent.safe`, otherwise signatures may authorize actions on Safes that cannot execute or were not intended for this module.

   Replay key should be:

   ```solidity
   used[intent.safe][intent.nonce]
   ```

   That is fine if `safe` is signed and the domain binds chain/module. Without those bindings, signatures can replay across chains, module deployments, or systems using the same struct.

2. **`metaNonce` should not be caller-controlled or frontend-selected.**

   A malicious or careless relayer should not be able to cause registration conflicts by choosing or racing a bad `metaNonce`.

   Best option: derive it in the module from the signed intent nonce or from a module-managed monotonic counter.

   For example:

   ```solidity
   metaNonce = uint256(keccak256(abi.encode(
       block.chainid,
       address(this),
       intent.safe,
       intent.nonce,
       intent.action
   )));
   ```

   Or simpler: use `intent.nonce` directly if CoWSafeWrapper namespaces meta-orders by Safe/module sufficiently.

   I would remove `metaNonce` from the signed intent unless the wrapper has a strong reason to expose it. The user signs the management intent; the module should derive the registration identity canonically.

3. **Decrease leverage cannot generally be “withdraw collateral -> sell -> repay debt” without a flash loan.**

   Withdrawing collateral first lowers health factor before debt is repaid. If the position is near its target leverage, that withdrawal may violate Aave’s collateral constraints.

   Safer atomic sequence for decrease / partial close is usually:

   1. Flash borrow debt asset.
   2. Repay Aave debt.
   3. Withdraw collateral.
   4. Sell withdrawn collateral for debt asset via CoW.
   5. Repay flash loan plus premium.
   6. Optionally repay residual debt or return surplus.

   Without flash, decrease only works when the requested collateral withdrawal is allowed at the current debt level. That is not generally true for leveraged positions.

4. **Increase leverage likely does not need flash.**

   For `IncreaseLev`, the natural sequence is:

   1. Borrow debt from Aave.
   2. Sell borrowed debt for collateral through CoW.
   3. Supply bought collateral to Aave.

   The risky point is after borrowing and before supplying, health factor decreases. This is valid only if the incremental borrow is allowed by Aave at that moment.

   A flash loan is not inherently needed unless you are trying to avoid intermediate HF checks or support a path where borrow-first is not allowed. But Aave will enforce borrow limits at borrow time anyway. If the Safe can borrow the debt amount, the sequence can work without flash. If it cannot borrow, flash does not magically make the final position valid.

   So `flash` should probably be action-specific:
   - `IncreaseLev`: usually no flash.
   - `DecreaseLev` / `Close`: usually flash debt asset.
   - `WithdrawEquity`: maybe no flash if withdrawal allowed; otherwise impossible unless debt is first reduced.
   - `AddEquity`: no flash needed.

5. **Partial close is not just “Close with amount < full.”**

   Full close can use `repay(MAX)` and `withdraw(MAX)` because the target is zero debt and zero collateral. Partial close cannot.

   You need an explicit target model.

   If the goal is to preserve the same leverage / HF, then selling `x` collateral and repaying “proportional debt” is meaningful, but the formula must account for prices and liquidation parameters.

   Let:

   - `C` = collateral amount
   - `D` = debt amount
   - `Pc` = collateral price
   - `Pd` = debt price
   - `LT` = liquidation threshold
   - Current HF:

   ```text
   HF = C * Pc * LT / (D * Pd)
   ```

   If withdrawing/selling `x` collateral and repaying `y` debt while preserving HF:

   ```text
   (C - x) * Pc * LT / ((D - y) * Pd) = C * Pc * LT / (D * Pd)
   ```

   Simplifies to:

   ```text
   y = D * x / C
   ```

   So proportional debt repayment preserves HF if prices and LT are unchanged.

   But execution uses swap proceeds, not abstract value. If selling `x` collateral yields less than `y` debt due to price movement/slippage, the post-state has lower HF. Therefore the order must enforce enough bought debt to repay the chosen `y` plus flash premium, or the post-hook must revert.

   For target leverage, use a target debt/collateral ratio instead of “amount means collateral sold.” The module should compute:

   ```text
   targetDebt = targetCollateralValue * targetBorrowRatio
   debtToRepay = currentDebt - targetDebt
   collateralToWithdraw = currentCollateral - targetCollateral
   ```

   Current plan does not define this rigorously enough.

6. **`minOut` alone is not enough. Post-state checks are mandatory.**

   The CoW order can enforce sell/buy amounts, but the security property is the final Aave position.

   Every action should have explicit postconditions, checked on-chain in the post hook or by the module-generated post transaction:

   - Expected debt reduced/increased within bounds.
   - Expected collateral reduced/increased within bounds.
   - Health factor above signed minimum.
   - No unexpected token residue beyond allowed dust policy.
   - Flash loan repayment amount covered, including rounded-up premium.
   - Receiver only receives assets explicitly allowed by the signed intent.

   I would add fields like:

   ```solidity
   uint256 minHealthFactor;
   uint256 maxDebt;
   uint256 minCollateral;
   uint256 maxCollateral;
   ```

   For close, postcondition should be debt == 0 and collateral == 0 or within known dust bounds.

7. **AddEquity is not well-posed unless funding is solved.**

   The CoW sell token comes from the Safe. If the owner holds the token, the module cannot magically sell it from the owner.

   Viable designs:
   - Owner pre-funds the Safe before calling `execute()`.
   - Owner signs ERC-2612 / Permit2 authorization and the module pulls funds in the pre-hook.
   - Use a carrier order from owner funds, as with bootstrap.
   - Require relayer-provided funds is unsafe unless signed and bounded.

   If using `transferFrom(owner, safe, amount)`, the signed intent must bind:
   - token
   - amount
   - max amount
   - owner
   - deadline
   - receiver/safe
   - permit nonce if applicable

   Otherwise AddEquity should be deferred.

8. **WithdrawEquity is also under-specified.**

   Withdrawing collateral while debt remains must preserve HF. The module must either:
   - compute max withdrawable from live Aave data and signed minimum HF, or
   - accept a signed withdrawal amount and enforce post-HF.

   The `receiver` field is dangerous here. It must be signed, nonzero, and probably default to the Safe owner. For close/decrease, arbitrary receiver should not be able to siphon swap surplus unless explicitly intended.

**Per-Action Ordering**

`Close(full)`:

```text
flash borrow debt
repay Aave debt with flashed debt
withdraw all collateral
sell collateral for debt
repay flash + rounded-up premium
send surplus to receiver / Safe owner
postcheck debt == 0, collateral == 0
```

This is sound if `minOut >= flash + premium` and postconditions are strict.

`DecreaseLev`:

```text
flash borrow debtToRepayFirst
repay Aave debt
withdraw collateralToSell
sell collateral for debt
repay flash + premium
optionally repay extra debt or return surplus
postcheck HF >= minHealthFactor and debt/collateral bounds
```

This usually needs flash.

`IncreaseLev`:

```text
borrow debt amount from Aave
sell debt for collateral
supply collateral
postcheck HF >= minHealthFactor and debt/collateral bounds
```

Usually no flash. Must ensure the borrow itself is valid before the later collateral supply.

`AddEquity`:

```text
pull collateral or debt token from owner into Safe, or require Safe pre-funded
if debt token: optionally sell debt token for collateral
supply collateral, or repay debt, depending on intent
postcheck HF improved / bounds satisfied
```

As written, incomplete.

`WithdrawEquity`:

```text
withdraw signed collateral amount
send to receiver
postcheck HF >= minHealthFactor
```

Only valid if Aave allows the withdrawal before any later action. If not, the action must first repay debt, which makes it a decrease/retarget operation.

**Cleaner Generalization**

A safer model is a single `RetargetPosition` primitive:

```solidity
RetargetIntent {
    safe;
    nonce;
    deadline;
    collateral;
    debt;
    targetCollateral;
    targetDebt;
    maxCollateralIn;
    minCollateralOut;
    maxDebtIn;
    minDebtOut;
    minHealthFactor;
    receiver;
    orderValidTo;
}
```

Then builders derive whether the transition requires:
- borrow then buy/supply,
- flash repay then withdraw/sell,
- repay from owner funds,
- withdraw surplus collateral,
- full close.

This is easier to verify than five separate action builders because every action reduces to:

```text
current position -> target position
```

with explicit asset deltas and postconditions.

The five named actions can remain frontend presets, but I would avoid making them five independent low-level protocol paths unless absolutely necessary.

**Other Concrete Risks**

- `collateral` and `debt` must match the actual position or supported market pair. Do not let the user sign arbitrary token addresses that cause builders to interact with unsupported reserves.
- `receiver` should be restricted or signed with explicit surplus policy.
- `orderValidTo` should be checked against `deadline`; avoid an intent valid for execution briefly but a CoW order valid much longer than the user expects.
- `fullAppData` emitted on-chain may be expensive. If needed for relayers, fine, but consider whether the canonical appData can be reconstructed off-chain from event fields.
- `expectedFill` should be derived conservatively from the exact debt/flash requirement, not just frontend quote size.
- If `used` is marked before registration and registration reverts, the revert rolls back the mark, so that is okay.
- If registration succeeds but the order never settles, the management nonce is consumed. That is expected, but UX needs cancellation/replacement using a new nonce.

**Must-Fix Before Build**

1. Define the exact per-action Aave ordering, especially decrease and partial close.
2. Replace `metaNonce` as signed/frontend input with module-derived deterministic identity.
3. Add signed and enforced post-state bounds: `minHealthFactor`, `maxDebt`, `minCollateral`, and action-specific dust/surplus rules.
4. Redesign partial close around explicit target debt/collateral or mathematically defined proportional reduction.
5. Solve AddEquity funding explicitly or remove it from v1.
6. Make WithdrawEquity enforce live HF constraints and signed receiver policy.
7. Bind EIP-712 domain to `chainId` and module address; keep `safe` inside the signed struct.
8. Treat the five actions as frontend presets over a retarget primitive if possible.

The core idea, “owner signs high-level intent and immutable module derives canonical Safe calldata,” is good. The weak part is the current action set: it mixes user-facing verbs with underdefined Aave state transitions. Build the module around explicit target state and strict postconditions, then expose Close/Increase/Decrease/Add/Withdraw as convenience modes.
