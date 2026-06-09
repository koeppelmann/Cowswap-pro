# Spec: sign-the-intent leverage authorization (v5)

## Goal (your proposal)
The user signs **one** human-readable intent, and *everything* (the CoW order + every on-chain
action) is derived from and authorized by that single signature, with a nonce so it executes once.

```
LevIntent {
  address safe;          // the position Safe this intent acts on
  uint8   action;        // 0 OPEN · 1 INCREASE · 2 DECREASE · 3 REDUCE(partial) · 4 CLOSE
  address longToken;     // collateral
  address shortToken;    // debt / stable
  uint256 collateralDelta; // amount bought/sold (or max for full close)
  uint256 debtDelta;       // amount borrowed/repaid
  uint256 minOut;        // slippage floor for the swap
  uint256 nonce;         // per-Safe, one-time
  uint256 deadline;      // expiry
}
```
EIP-712 domain `verifyingContract = safe` (so it's bound to that Safe + chain). The wallet shows the
intent in plain terms ("OPEN 2× long WETH with 1 WXDAI on 0x…"), which is *clearer* than today's raw order.

## Does it work? Yes — with one architectural change

The thing that makes the current design hard to secure is **CoW trampoline hooks**: `openLeg` /
`reducePrepare` / `closeFinalize` are separate functions the *shared, permissionless* trampoline calls,
so a third party can invoke them on your Safe (Codex finding F1). You can't bind those hook calls to the
signed order, because the hooks live *inside* the order's `appData` — referencing the order from within
itself is circular.

**The fix: do all leverage logic inside the flash-loan borrower callback, and use no trampoline hooks.**

The Safe is the flash-loan borrower. The router calls `flashLoanAndCallBack` (router-only) → the Safe
takes the Aave flash loan → Aave calls `executeOperation` (Aave-only). Inside `executeOperation` we can do
work **both before and after** handing control to the settlement:

```
executeOperation():                       // msg.sender == Aave Pool; runs only inside OUR flash loan
   require(initiator == this Safe)         // (fixes Codex F3)
   [pre-trade]   for CLOSE/REDUCE: repay debt, withdraw collateral, approve relayer
   router.borrowerCallBack(data)           // ← the CoW trade executes here (sell→buy)
   [post-trade]  for OPEN/INCREASE: supply bought collateral, borrow; for CLOSE: forward to owner
   return true                             // Aave pulls loan+premium
```

So **there are no public hook functions at all** — the only externally reachable entrypoints are
`flashLoanAndCallBack` (router-gated) and `executeOperation` (Aave-gated, initiator-checked). The F1/F2/F3
hook-abuse class disappears entirely. The Safe's `appData` becomes just the flash-loan hint (no hooks).

## Authorization with one signature

Because `appData` is now a simple, deterministic flash-loan hint, the CoW order is a pure function of the
intent. The order's EIP-1271 signature = `abi.encode(intent, ownerSig)`, and `isValidSignature(orderDigest, …)`:
1. recovers `ownerSig` over `LevIntent` (Safe-bound EIP-712) and checks the signer is a Safe owner;
2. checks `nonce` unused and `deadline`;
3. **recomputes the canonical order from the intent** (sellToken/buyToken/amounts/validTo/receiver=safe +
   the deterministic flash-loan appData hash) and requires it equals `orderDigest`.

That single check guarantees the on-chain order is *exactly* the one the intent describes — nothing else can
be derived from the signature (a different order → different digest → rejected; another Safe → different
domain → rejected; an EOA replay → it's a SafeMessage, not a raw digest → rejected).

`executeOperation` learns the action/amounts from the **same intent** (carried in the order's `appData`,
which is committed by the validated `orderDigest`), so the trade *and* the Aave actions are driven by one
authorization. It derives every concrete step from `intent.action` + the amounts.

## Replay / nonce
- `mapping(address safe => mapping(uint256 nonce => bool)) used;`
- Consumed in `executeOperation` (a real call, can write state) the first time the intent executes.
- An intent can therefore execute **at most once**. Re-posting the same signature is a no-op (digest already
  filled at CoW + nonce consumed on-chain).

## Security properties (what this guarantees)
- Only the Safe **owner** can authorize an action; the signature is bound to the **specific Safe + chain**.
- From the signature, **only the exact intended action** can be executed — same order, same amounts, once.
- **No third party** can move funds, change parameters, force a borrow/withdraw, or trigger any action — the
  abusable trampoline hooks no longer exist; `executeOperation` runs only inside the Safe's own flash loan
  with `initiator == safe`.
- Funds only ever land in the Safe or go to the **owner**.

## UX
Unchanged vs today: **one signature per action**, and management (adjust/close) stays gasless (sign + post).
Open still needs the deploy + fund txs (Safe creation + equity), then one intent signature.

## Cost / migration
This is a **contract redesign (LevModule v5)**: move openLeg/reducePrepare/closeFinalize logic into
`executeOperation`, add intent verification to `isValidSignature`, add the nonce map, and update the SDK to
build+sign `LevIntent` and encode it in the order. The trickiest engineering bit is `isValidSignature`
recomputing the canonical order digest from the intent (the flash-loan appData must be byte-deterministic).
Existing v4 positions keep working on v4 (version-aware), new ones use v5.

## Open question for you
The above keeps everything in `appData` + the order signature (gasless, one sig). The only alternative if the
appData-recompute proves too brittle is a tiny **on-chain intent registration** (one extra tx) that
`executeOperation` reads — simpler contract, but it makes adjust/close cost a tx instead of a signature.
Recommended: try the appData-recompute path first; fall back to registration only if needed.
