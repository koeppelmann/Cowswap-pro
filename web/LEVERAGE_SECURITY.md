# CoW Leverage — Security Review

## Architecture
Each position is a **Gnosis Safe v1.3.0 (1/1, owner = user EOA)** with a shared **LevModule** set as both
its fallback handler and an enabled module. LevModule answers the CoW/Aave callbacks + EIP-1271 and acts
*as* the Safe via `execTransactionFromModule`. Execution = CoW flash-loan orders (`flashLoanAndSettle`)
with pre/post hooks on the Safe. Trusted, audited deps: Safe, Aave V3 Pool, CoW Settlement/Router/Relayer
(all hardcoded).

## What the user signs (and that ONLY the intended action can be derived)
The user signs an **EIP-712 `SafeMessage` whose domain `verifyingContract` = their Safe**, wrapping the CoW
order digest. The order digest commits to `sellToken, buyToken, receiver, sellAmount, buyAmount, validTo,
appData, kind, …`, and **`appData` contains the exact hook calldata** (the supply/borrow or repay/withdraw +
finalize amounts and targets). So one signature authorizes exactly one fully-specified action on one Safe —
nothing else can be derived from it.

## Findings & fixes

### F1 — Signature replay across Safes / as an EOA order  ·  HIGH  ·  FIXED (v3+)
Originally the user ECDSA-signed the **raw** order digest and `isValidSignature` only checked
`isOwner(ecrecover(digest, sig))`. Not bound to a Safe ⇒ the same signature could be resubmitted as a plain
**EOA** CoW order (pulling the user's *wallet* tokens if the relayer was approved) or validated by **any other
Safe** the user owns.
**Fix:** `isValidSignature` now requires the **Safe-bound `SafeMessage`** (domain.verifyingContract = msg.sender
= the Safe). Fork tests prove a raw-digest sig and an other-Safe-bound sig are both **rejected**.

### F2 — `closeFinalize` fund exfiltration via the shared trampoline  ·  CRITICAL  ·  FIXED (v4)
The hooks gate on `_caller() == TRAMPOLINE`, but the CoW HooksTrampoline is **shared/permissionless** — anyone
can make it call any target by listing `{target: victimSafe, callData: …}` in **their own** order's hooks.
`closeFinalize` took an **arbitrary `recipient`**, so an attacker could trigger
`victimSafe.closeFinalize(recipient = attacker)` from their own order and drain any **liquid** balance in the
Safe (notably the equity sitting in the Safe during the open window).
**Fix:** `closeFinalize` now forwards only to the **Safe owner** (`getOwners()[0]`); there is no caller-supplied
recipient. No hook can move funds to a third party. Fork-tested (`closeFinalize_alwaysPaysOwner_notCaller`).

### F3 — Forced `openLeg` / `reducePrepare` griefing  ·  MEDIUM  ·  RESIDUAL
`openLeg`/`reducePrepare` are also trampoline-reachable by third parties. An attacker can trigger
`victimSafe.openLeg(bigBorrow)` (forces borrow up to the limit → liquidation risk) or `reducePrepare(...)`
(forces repay/withdraw) from their own order. **No funds reach the attacker** (borrowed/withdrawn funds stay in
the victim's Safe = the owner's), so there is no profit motive — only griefing of an open position, at the cost
of the attacker submitting a real order. **Recommended fast-follow:** require the owner's signature on each hook
op (bound to Safe + exact calldata + one-time nonce), the way the production CoW↔Aave adapter does. Cost: one
extra signature per action (UX tradeoff to decide).

### F4 — Flash-loan-borrower griefing  ·  LOW  ·  RESIDUAL
An attacker naming a victim Safe as `protocolAdapter` in their order makes the victim Safe take + repay an Aave
flash loan inside the attacker's settlement. Net-zero unless the victim Safe holds liquid funds to cover the
0.05% premium (tiny). No theft. Same owner-signed-hook fix mitigates.

## Verified-safe properties
- **Custody:** only the owner can move funds outside the hooks; the hooks act solely on the Safe's own
  position/balances and (post-fix) pay out only to the owner. A direct call to LevModule by an attacker operates
  on the attacker's own `msg.sender`, never a victim Safe.
- **Tamper-proof params:** every hook's calldata is committed in the signed order's `appData` (in the order
  digest), so the legitimate flow can't be altered without invalidating the signature.
- **Shared singleton:** LevModule is stateless and keyed by `msg.sender` (the Safe) — no cross-Safe collision.
- **UI:** the token selector is restricted — managing a position offers only its two tokens; opening restricts
  sell→stable and buy→collateral. You cannot select a token outside the involved pair.

## Operational notes
- Small flash-loan orders sometimes need a retry (3-min validity; the UI retries).
- Position discovery is via localStorage; clearing it hides positions from the UI but funds remain on-chain and
  owner-recoverable (on-chain discovery is a follow-up).
- Unaudited application code; relies on audited Safe / Aave / CoW.

## Deployed (Gnosis, Sourcify-verified)
- LevModule **v4** (current): `0x1641c5Ab962e1bEA8806d3A0546987d825eF41Ff`
- LevSafeInit: `0x53A77329A544d235d569D62941303cAbeF536Df0`
- (legacy: v2 `0x6671…7F3` raw-sig, v3 `0x75e0…838e` unused)
