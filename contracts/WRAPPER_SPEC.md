# Spec: `CoWSafeWrapper` — a generic CoW solver-wrapper that enforces Safe pre/post interactions

Status: **draft v3** (incorporates Codex adversarial review of v2; see §12 changelog). Chain: Gnosis
(Cancun/EIP-1153 live). Reviewers: Codex (spec, 2 passes), then Codex (implementation).

---

## 1. Motivation

CoW pre/post hooks (shared `HooksTrampoline`) are **best-effort** and **permissionless**: a solver can
skip them and anyone's order can call your hook targets (the F1 class we hit with LevModule). We want a
primitive where, for a given CoW order, a set of Safe transactions runs **atomically and enforced**
around `settle`, authorized **only** by the owning Safe, where the order **cannot settle at all** unless
that enforcement happens and is fully verified — supporting **many orders from many safes per batch**.

---

## 2. Two-contract architecture (Codex F1/F2 fix)

The state-changing logic and the EIP-1271 entrypoint MUST live in **separate** contracts, because a
Safe fallback handler is reachable by *anyone* (the Safe forwards arbitrary calls to it). If the same
contract held `registerMetaOrder` and were the fallback handler, an attacker could call
`Safe→registerMetaOrder` and the wrapper would see `msg.sender==safe` → register a fund-draining
meta-order. So:

- **`CoWSafeWrapper`** (the engine): holds `metaOrders` storage, the transient proof-debt machinery,
  `registerMetaOrder` / `cancelMetaOrder` (callable **only by a direct CALL from the Safe** — i.e. an
  owner-authorized Safe transaction, *not* via fallback), `wrappedSettle` (solver entry), `activate`
  (settlement pre-interaction), `isBlessed` (view). It is enabled as a **Safe module** so it can run
  pre/post txs as the Safe. **It is NOT the fallback handler.**
- **`CoWSafeSigHandler`** (the EIP-1271 shim): the Safe's **fallback handler**. Implements *only*
  `isValidSignature(bytes32,bytes)`. It reads the original caller appended by the Safe, requires it to
  be the CoW `SETTLEMENT`, and returns MAGIC iff `wrapper.isBlessed(safe, hash)`. Immutable `wrapper`
  + `settlement` addresses. Exposes nothing else.

Because the handler is CoW-only and read-only, and the engine is reachable for state changes only by a
direct Safe CALL, neither finding-1 nor finding-2 spoof is possible.

```
Safe setup per position:
  - enable CoWSafeWrapper as module           (run pre/post as the Safe)
  - set fallbackHandler = CoWSafeSigHandler   (answer isValidSignature, CoW-only)
```

---

## 3. The proof-debt model

Optimistic execution with **mandatory debt discharge**, all within one transaction:

1. `wrappedSettle` (solver entry) opens a new **epoch** and sets `IN_WRAPPED_SETTLE`.
2. Settlement runs `interactions[0]`, which MUST include one `activate(safe, nonce)` per order.
   `activate` **consumes/freezes** the meta-order, sets the transient **bless** flag for its digest,
   pushes a **debt** entry, and runs the registered **pre** tx as the Safe.
3. During trade validation, settlement STATICCALLs `Safe.isValidSignature(digest)` → handler →
   `wrapper.isBlessed(safe,digest)` reads the bless flag → MAGIC.
4. After `settle` returns, `wrappedSettle` **drains every debt entry**: requires the order actually and
   fully filled, runs the registered **post** tx as the Safe. Any failure reverts the whole tx.

Invariant chain: `settle ⇒ bless ⇒ debt ⇒ (filled fully ∧ pre ran ∧ post ran)`, all-or-nothing.

### Why activate (not isValidSignature) writes the debt
`isValidSignature` is reached via `view recoverOrderSigner` → **STATICCALL** → cannot `TSTORE`. A CoW
**pre-interaction** is a normal CALL by the settlement contract → can `TSTORE`. So the pre-interaction
`activate` writes bless+debt; `isValidSignature` only reads.

---

## 4. Registration (direct Safe CALL only)

**Order-construction order matters** (the uid must commit to the bundle). The precise user flow is:
1. create the Position Safe (module = wrapper, fallback handler = sig-handler, approve VaultRelayer);
2. generate a fresh `nonce`;
3. build the CoW order whose **`appData` embeds `{wrapper, safe, nonce, pre SafeTx, post SafeTx}`** —
   the FULL payloads (on-chain stores only their hashes; solvers fetch the executable calldata from the
   appData). The order digest commits to `appData`, so the resulting `uid` commits to the whole bundle;
4. `registerMetaOrder(nonce, {uid, expectedFill, preHash, postHash, …})`.

This yields **mutual binding**: order → appData → (nonce, payloads); registration → (uid, payload
hashes). appData is solver-discovery only — never trusted on-chain (the hash check at execution is).
```json
{ "metadata": { "coWSafeWrapper": {
    "wrapper":"0x..","safe":"0x..","nonce":"123",
    "pre":  { "to":"0x..","value":"0","data":"0x..","operation":0 },
    "post": { "to":"0x..","value":"0","data":"0x..","operation":1 } } },
  "version":"1.x.0" }
```

```solidity
struct SafeTx { address to; uint256 value; bytes data; }   // CALL only (operation 0); no DELEGATECALL in v1
struct MetaOrder {
    bytes  uid;          // 56-byte CoW UID = digest(32)++owner(20)++validTo(4)
    uint256 expectedFill;// full-fill amount in CoW's filledAmount unit: sellAmount for a SELL order,
                         // buyAmount for a BUY order. Discharge requires filledAfter==expectedFill (F11).
    SafeTx pre;
    SafeTx post;
    uint64  notBefore;   // optional: earliest execution ts (0 = none)        (F10 grief mitigation)
    uint64  deadline;    // optional: latest execution ts (0 = none; ≤ order validTo recommended)
    address allowedSolver; // optional: if set, only this relayer (wrappedSettle caller) may settle it (F10)
    uint8   status;      // 0 none · 1 registered · 2 consumed
}
mapping(address safe => mapping(uint256 nonce => MetaOrder)) public metaOrders;

function registerMetaOrder(uint256 nonce, MetaOrder calldata m) external {
    // msg.sender is the Safe ONLY when invoked by a direct CALL from the Safe (owner-authorized Safe
    // tx). NOT reachable via fallback (the wrapper is not the fallback handler). See §2.
    require(m.uid.length == 56, "uid len");
    require(address(bytes20(_slice(m.uid,32,20))) == msg.sender, "uid owner != safe");
    MetaOrder storage cur = metaOrders[msg.sender][nonce];
    require(cur.status != 2, "nonce consumed");        // cannot reuse a consumed nonce
    require(cur.status != 1 || !_locked(msg.sender,nonce), "active");  // can't overwrite mid-frame (belt)
    metaOrders[msg.sender][nonce] = m; metaOrders[msg.sender][nonce].status = 1;
    emit Registered(msg.sender, nonce, keccak256(m.uid));
}
function cancelMetaOrder(uint256 nonce) external {
    MetaOrder storage cur = metaOrders[msg.sender][nonce];
    require(cur.status == 1, "not active");            // only an un-consumed registration; never mid-frame
    cur.status = 0;  // or delete; data no longer usable
    emit Cancelled(msg.sender, nonce);
}
```

- Stores the **full** pre/post + uid + sellAmount; the solver supplies **only the nonce** at settle.
- Duplicate-uid-across-nonces is *harmless* (blocked at activation by the digest-bless guard, F5) but
  discouraged; no uid→nonce index in v1.
- One on-chain registration tx per order (Path-2 tradeoff). Gasless `registerMetaOrderWithSig` is a
  future extension.

---

## 5. Wrapped settle (solver entry) — multi-order, atomic

**Solver model (F10/#2 fix).** The **wrapper** is the registered CoW solver (settlement enforces
`isSolver(msg.sender==wrapper)` when the wrapper calls `settle`). The **external caller** of
`wrappedSettle` is a *relayer* and need not itself be a CoW solver. Access control on `wrappedSettle` is
an **owner-managed relayer allowlist** (`relayerAllowed[msg.sender]`); the caller is captured into
`SOLVER(epoch)` and each activated order's optional `allowedSolver` is checked against it in `activate`.

```solidity
mapping(address => bool) public relayerAllowed;        // owner-managed (admin §9b)
function wrappedSettle(bytes calldata settleCalldata) external {
    require(relayerAllowed[msg.sender], "relayer");           // F10: mandatory access control (custom path)
    require(tload(IN_WRAPPED_SETTLE) == 0, "nested");          // F4: no nesting/re-entry
    require(settleCalldata.length >= 4 && bytes4(settleCalldata[0:4]) == SETTLE_SELECTOR, "not settle"); // F8
    uint256 epoch = tload(EPOCH) + 1; tstore(EPOCH, epoch);    // F4: fresh namespace per invocation
    tstore(IN_WRAPPED_SETTLE, 1);
    tstore(SOLVER(epoch), uint256(uint160(msg.sender)));       // #2: capture relayer for allowedSolver

    (bool ok, ) = SETTLEMENT.call(settleCalldata);             // settlement sees msg.sender == wrapper (a solver)
    require(ok, "settle failed");

    // ---- discharge ALL proof-debt or revert ----
    uint256 n = tload(COUNT(epoch));
    for (uint256 i = 0; i < n; i++) {
        (address safe, uint256 nonce) = _loadDebt(epoch, i);
        MetaOrder storage m = metaOrders[safe][nonce];         // FROZEN (status set to 2 in activate, F6)
        require(SETTLEMENT.filledAmount(m.uid) == m.expectedFill, "not fully settled"); // F11
        _execAsSafe(safe, m.post);                             // require success (F-hazard)
        emit Discharged(safe, nonce);
    }
    tstore(IN_WRAPPED_SETTLE, 0);
}
```

- `settleCalldata` passed **opaquely** but selector- and length-checked; never parsed for security.
- **Multi-order/multi-safe is first-class:** one `activate` pre-interaction per order; each pushes a
  debt entry under the epoch; the loop drains all. Either every order's pre/fill/post succeeds, or the
  whole tx reverts — **no partial-batch outcome**. `MAX_ITEMS` bounds the loop under block gas.

---

## 6. Activation (settlement pre-interaction → writes bless+debt, runs pre)

```solidity
function activate(address safe, uint256 nonce) external {
    uint256 epoch = tload(EPOCH);
    require(tload(IN_WRAPPED_SETTLE) == 1, "not in wrappedSettle");  // F7: gate, not a generic guard
    require(msg.sender == SETTLEMENT, "only settlement");           // only as a settle pre-interaction
    MetaOrder storage m = metaOrders[safe][nonce];
    require(m.status == 1, "not registered");
    if (m.notBefore != 0) require(block.timestamp >= m.notBefore, "too early"); // F10
    if (m.deadline  != 0) require(block.timestamp <= m.deadline,  "expired");   // F10
    if (m.allowedSolver != address(0))                                          // F10/#2
        require(address(uint160(tload(SOLVER(epoch)))) == m.allowedSolver, "solver");

    bytes32 digest = bytes32(_slice(m.uid, 0, 32));
    require(tload(BLESS(epoch, safe, digest)) == 0, "digest already blessed"); // F5: one bless per digest
    require(SETTLEMENT.filledAmount(m.uid) == 0, "already filled");             // F11: filledBefore==0

    m.status = 2;                          // F6: consume/FREEZE before effects (reverts with tx on failure)
    tstore(BLESS(epoch, safe, digest), 1);
    _pushDebt(epoch, safe, nonce);         // record (safe,nonce); discharge reloads frozen storage; MAX_ITEMS-bounded
    _execAsSafe(safe, m.pre);              // run pre as the Safe; require success
    emit Activated(safe, nonce);
}
```

- Ordering: `interactions[0]` runs before trade validation, so bless is set before `isValidSignature`.
  Putting `activate` later → bless unset at validation → trade reverts → settle reverts.
- `m.status = 2` is written *before* running pre, so a malicious pre can't overwrite/cancel the
  meta-order (register/cancel both reject `status==2`). Discharge reloads the now-immutable entry. If
  the whole tx reverts, the status write reverts too (no permanent consumption on failure).
- `allowedSolver` note: the actual solver is `msg.sender` of `wrappedSettle`, not of `activate` (which
  is settlement). Capture it in a transient slot at `wrappedSettle` entry and compare here.

---

## 7. `isValidSignature` (handler, read-only)

```solidity
// CoWSafeSigHandler (the Safe's fallback handler)
function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
    address safe = msg.sender;                 // Safe forwards as fallback handler
    address orig = _appendedCaller();          // last 20 calldata bytes the Safe appended
    if (orig != SETTLEMENT) return 0xffffffff;  // F2: CoW-only; rejects all other EIP-1271 consumers
    return IWrapper(WRAPPER).isBlessed(safe, hash) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
}
```
```solidity
// CoWSafeWrapper
function isBlessed(address safe, bytes32 digest) external view returns (bool) {
    return tload(BLESS(tload(EPOCH), safe, digest)) == 1;     // reads the engine's own transient slot
}
```

- Call chain stays read-only: settlement STATICCALL → Safe → handler → `wrapper.isBlessed` (TLOAD).
- **Bypass-proof:** outside a `wrappedSettle`, no `activate` runs → no bless → never validates.
- **Off-chain caveat (real, see §11):** because the handler requires `orig==SETTLEMENT`, the CoW
  orderbook's off-chain `isValidSignature` simulation (different caller) returns failure. v1 targets a
  **custom solver submission path**, not public-orderbook discovery. Empirically confirm or design a
  separate, carefully-reviewed owner-sig path later (it risks reintroducing a direct-settle bypass).

---

## 8. Transient storage (EIP-1153) — domain-separated + epoch-scoped (F3/F4)

Every key is `keccak256(abi.encode(TAG, epoch, …))` with a distinct string `TAG`, so no two namespaces
can collide regardless of attacker-chosen numeric values:

| name | key | holds |
|---|---|---|
| `EPOCH` | `keccak256("CoWSafeWrapper.EPOCH")` | monotonic per-tx invocation id |
| `IN_WRAPPED_SETTLE` | `keccak256("CoWSafeWrapper.IN")` | 1 while inside a wrappedSettle |
| `SOLVER` | `keccak256("CoWSafeWrapper.SOLVER", epoch)` | the `wrappedSettle` caller (for allowedSolver) |
| `BLESS` | `keccak256("CoWSafeWrapper.BLESS", epoch, safe, digest)` | 1 if blessed |
| `COUNT` | `keccak256("CoWSafeWrapper.COUNT", epoch)` | debt entries this epoch |
| `DEBT` | `keccak256("CoWSafeWrapper.DEBT", epoch, i)` → safe; `…,i,1)` → nonce | debt entry i |

Epoch is incremented (never reset) each `wrappedSettle`, so stale slots from a prior invocation in the
same tx are unreachable (their keys used a smaller epoch). Transient storage clears at tx end anyway.

---

## 9. Atomicity & authorization invariants (Codex must re-attack)

I1 **Bless ⇒ debt** — bless set only in `activate`, which always `_pushDebt`.
I2 **Debt ⇒ discharge-or-revert** — `wrappedSettle` drains every entry (full-fill check + post) or reverts.
I3 **Settle ⇒ bless ⇒ debt** — an order fills only if `isValidSignature` returned MAGIC, which needs bless.
I4 **Activate ⇒ our frame** — requires `IN_WRAPPED_SETTLE==1` ∧ `msg.sender==SETTLEMENT`.
I5 **Owner-only** — meta-order exists only via a direct Safe CALL to `registerMetaOrder` (not fallback).
I6 **One-shot** — `status→2` (frozen) at activate; never re-registerable; one bless per digest per epoch.
I7 **Funds** — pre/post are the Safe's own registered txs, CALL-only; the wrapper moves nothing else.
I8 **Full-fill proof** — discharge requires `filledBefore==0` (activate) ∧ `filledAfter==expectedFill`
   (expectedFill = sellAmount for sell orders, buyAmount for buy orders).
I9 **Access control** — `wrappedSettle` only by an owner-allowlisted relayer; per-order `allowedSolver`
   (if set) must equal the relayer. The wrapper (not the relayer) is the CoW solver.

### 9a. Presign is owner-only (F9 resolution — not a third-party bypass)
CoW's `setPreSignature(uid, signed)` enforces `require(owner == msg.sender)`, and the order's `owner` is
the **Safe**. So only the Safe can presign its own order. A third party / malicious solver therefore
**cannot** create a presign path to bypass the EIP-1271 + activate enforcement. Owner-self-presign is
equivalent to the owner simply trading the order without the leverage hooks — a self-action by an actor
who already fully controls the Safe, hence out of the attacker threat model. Mitigations: the SDK never
presigns wrapped orders; the e2e test asserts a non-owner `setPreSignature(uid)` reverts. (A Safe Guard
forbidding `setPreSignature` is an optional extra for paranoid deployments.)

### 9b. Admin (owner of the wrapper)
`owner` (us, for the v1 custom path) manages `relayerAllowed[addr]` via `setRelayer(addr,bool)`. The
owner has **no power over funds or registrations** — it only gates who may *drive* `wrappedSettle`.
A future permissionless mode opens the allowlist; per-order `allowedSolver` still lets each Safe pin its
own relayer regardless.

---

## 10. Adversarial brief for the re-review (Codex)

Re-attack each v2 finding under the v3 fixes (confirm closed or show a residual): F1 register-spoof,
F2 cross-consumer bless, F3 transient collision, F4 stale/multi-call state, F5 same-uid double post,
F6 pre-mutates-metaorder, F7 activate guard deadlock, F8 non-settle calldata, F9 presign bypass,
F10 solver grief, F11 filled-proof. Then hunt NEW issues introduced by the two-contract split and the
epoch scheme, e.g.:
- handler ↔ wrapper trust: can anything other than the real Safe make the handler call `isBlessed` with
  a `safe` it doesn't control? Does `_appendedCaller()` parse correctly for the Safe v1.3.0 fallback?
- can a pre/post tx (running as the Safe) call back into `wrappedSettle`/`activate`/`register` to do
  anything (it's the Safe, so it could `registerMetaOrder` — does that matter mid-frame)?
- `EPOCH` read in `isBlessed` vs the epoch active during settle — are they guaranteed equal?
- module-not-enabled, `execTransactionFromModule` returning false, reentrancy via post, MAX_ITEMS DoS,
  `allowedSolver`/`SOLVER` capture correctness, presign interaction, partial-fill orders.
Give exact sequences, the invariant broken, and a fix. Verdict: is v3 sound for a custom-solver path?

---

## 11. Open item — off-chain validation

Confirmed real (Codex): strict transient bless + `orig==SETTLEMENT` ⇒ off-chain orderbook validation
fails by design. v1 scope = **custom solver path** (we submit/relay the settlement as/through an
allowlisted solver). Public-orderbook discovery and any owner-sig compatibility branch are a separate,
later design pass. The e2e test (§13) acts as our own solver, matching this scope.

---

## 12. Changelog v2→v3 (all from Codex review)

F1 two-contract split (engine vs CoW-only fallback handler); F2 handler requires `orig==SETTLEMENT`;
F3 domain-separated transient keys; F4 per-invocation epoch + `IN_WRAPPED_SETTLE` no-nest;
F5 one bless per digest/epoch; F6 freeze `status→2` before pre + discharge from frozen storage;
F7 `activate` gated by flag+sender (no generic reentrancy guard); F8 settle-selector check;
F9 documented presign prohibition; F10 optional notBefore/deadline/allowedSolver; F11 `filledBefore==0`
+ `filledAfter==sellAmount`; hazards: `_execAsSafe` require-success, `uid.length==56`, cancel only on
`status==1`, no unrelated functions via fallback.

**Security audit (3 focused questions, me + Codex, 2026-06-10):** (Q1) the wrapper can only call
`settle` (selector-checked) with the solver's verbatim `settleData` — no injection. (Q2) it can only
`execTransactionFromModule` a Safe's OWN hash-committed pre/post (registration requires
`msg.sender==safe` ∧ `uid-owner==safe`; module check on the target Safe; two-pass freeze) — no
cross-safe unauthorized exec. (Q3) on-chain authorization = the registered preHash/postHash, NOT the
appData; a solver lying about the UID-committed calldata can at worst cause a harmless revert — never an
unauthorized action/fund move. **Fix applied:** `require(remainingWrapperData.length == 0)` — CoWSafeWrapper
is now FINAL-wrapper-only (bless window covers only the direct settle, closes Codex's chaining caveat;
compatible with the flash stack where it's already last). 14/14 SafeWrapper tests incl. `test_reject_notFinalWrapper`.

**Conform to CoW's ICowWrapper standard (per user):** `CoWSafeWrapper` now inherits CoW DAO's official
`CowWrapper` base (vendored verbatim as `src/CowWrapper.sol`) instead of a bespoke interface. The entry
is the standard `wrappedSettle(bytes settleData, bytes chainedWrapperData)` (solver-auth + chained-bundle
routing + magic-value return from the base); our logic lives in `_wrap(settleData, wrapperData,
remainingWrapperData)` and calls `_next(...)` to continue the chain to `settle`. Per-wrapper data =
`abi.encode(Activation[])`. Also implements `name()` and `validateWrapperData()`. This is required to be
allowlist-approvable and compatible with CoW's solver/driver and with wrapper chaining. The proof-debt
logic is unchanged; bless is set right before `_next` and closed right after.

**Redesign (post-deploy simplification, per user):** REMOVED the owner role + custom relayer allowlist
(`owner`/`setOwner`/`setRelayer`/`relayerAllowed`/`allowedRelayer`) — `wrappedSettle` now gates on
**CoW's own solver allowlist** read live (`AUTHENTICATOR.isSolver(msg.sender)`, authenticator cached
from `settlement.authenticator()` at deploy). REMOVED the separate `activate` function: activation
(freeze + bless + run pre) happens inside `wrappedSettle` in a loop BEFORE it calls `settle`, and
discharge (require full fill + run post) loops the same `acts` array after — so the transient debt-list
is gone too. `wrappedSettle(Activation[] acts, bytes settleCalldata)`; constructor is just `(settlement)`.
Net: no admin, no custom allowlist, one fewer function, smaller surface. 12/12 fork tests (incl. a
direct-`settle` bypass-blocked test).

**Implementation pass (3rd Codex review, on the deployed code):** added `require(n > 0)` after settle
(don't lend the solver slot to zero-wrapped-order settlements); `isBlessed` now also requires
`IN_WRAPPED_SETTLE==1` (blessings readable only during the active wrappedSettle, no stale reads later in
the same tx); renamed `allowedSolver`→`allowedRelayer` (it binds the wrappedSettle caller); accepted &
documented that arbitrary extra settlement interactions/trades may share the batch (the relayer is
owner-allowlisted, each order's own limit price protects its economics, and pre/post are enforced — we
deliberately do not parse settle calldata). The handler is a full `DefaultCallbackHandler` subclass that
reproduces the `CompatibilityFallbackHandler` signature surface and special-cases only the CoW caller.
Verified end-to-end on a Gnosis shadow-fork acting as a whitelisted solver (10/10 tests).

**v3→v3.1 (2nd Codex pass):** F9 reclassified as owner-only/out-of-threat-model with the
`setPreSignature` `owner==msg.sender` fact (+ test); F10/#2 solver model fixed — wrapper is the CoW
solver, `wrappedSettle` gated by owner-managed `relayerAllowed`, `SOLVER(epoch)` actually stored and
checked against per-order `allowedSolver`; F11 `sellAmount`→`expectedFill` (sell⇒sellAmount,
buy⇒buyAmount) since we use buy orders; `MAX_ITEMS` enforced in `_pushDebt`; `_appendedCaller()` to be
implemented exactly for Safe v1.3.0 + malformed-calldata tests; settle-calldata length-checked.

---

## 13. Test plan (shadow-fork Gnosis, act as solver)

1. Fork Gnosis; deploy `CoWSafeWrapper` + `CoWSafeSigHandler`.
2. Whitelist the wrapper as a solver: impersonate the CoW solver-auth manager, `addSolver(wrapper)`.
3. Safe with wrapper enabled as module + fallback handler = the sig handler.
4. Owner (Safe tx) calls `wrapper.registerMetaOrder(nonce, m)`.
5. As solver: build a `settle` batch (counter-liquidity/AMM) with `interactions[0]` =
   `wrapper.activate(safe, nonce)`; call `wrapper.wrappedSettle(settleCalldata)`.
6. Assert: pre ran, `filledAmount == sellAmount`, post ran, `status==2`, funds correct.
7. **Multi-order test:** two safes, two orders, one batch → both enforced atomically.
8. Negatives (mirror §10): unregistered/consumed nonce; tampered pre/post; solver omits the trade;
   activate outside wrappedSettle; another solver direct-`settle`; non-solver caller; isValidSignature
   from non-settlement caller; reentrant register from a pre tx; same-uid two nonces; nonce==digest
   collision attempt; nested wrappedSettle; expired/notBefore/allowedSolver.
9. (If feasible) point the real orderbook at it to settle §11 empirically.
```
