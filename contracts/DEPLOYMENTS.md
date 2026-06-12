# CoW wrapper deployments

ICowWrapper-compliant (`CowWrapper` base, vendored as `src/CowWrapper.sol`). Deterministic CREATE2 via
the Arachnid factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` (present on all chains). Calldata to
the factory = `salt(32) ++ initcode`, `initcode = creationCode ++ abi.encode(constructorArgs)`. Same
`(args, salt)` on any chain ⇒ same address.

Compiler: solc 0.8.34, optimizer 200, evm_version cancun. No admin anywhere; `wrappedSettle` gated by
CoW's own solver allowlist. Constructors: `CoWSafeWrapper(settlement)`,
`CoWSafeSigHandler(wrapper, settlement)`, `CowFlashLoanWrapper(settlement, aavePool)`.

Salts (ascii): `CoWSafeWrapper.v2` · `CoWSafeSigHandler.v2` · `CowFlashLoanWrapper.v6`.

## Gnosis — STAGING / barn build — LIVE & IN USE (CURRENT, 2026-06-10)
This is the stack actually wired into the live test position Safe (`0x25a9A92F…03Fb`), its on-chain
meta-order registrations, the staging orderbook orders, and the Kaze whitelist proposal. Settlement
(barn) `0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13` · authenticator
`0x02073540567FA1EABcBf74C2F7E6F9029ca7d800` · Aave V3 pool `0xb50201558B00496A145fE76f7424749556E326D8`

| contract | address | notes |
|---|---|---|
| **CoWSafeWrapper** (MetaOrder, hash-committed pre/post, final-wrapper-only) | `0x531636e6e18F3A52c283aCCda39D7185E4597A37` | unchanged |
| **CoWSafeSigHandler** (Safe fallback handler, `WRAPPER`=the above) | `0x29619484de063A3E06e432a0CCBF5a2BE6F024DC` | unchanged |
| **CowFlashLoanWrapper** (generic flash layer, **trampoline build**) | `0x2E3fdEe28D7224ED140B4ea08C57F47546679363` | **NEW — replaces `0x7aC5…785d`** |

The flash wrapper was redeployed (salt `CowFlashLoanWrapper.v6`), addressing review issues #1–#4:
(1) **drops** the solver-supplied `uids` / `filledAmount` proof-of-settle (#1, #4) — `wrapperData =
abi.encode(Loan[])` only, so the appData `metadata.wrappers` hint is complete and the CoW driver's
verbatim chain encoding fills correctly, and the INT_MAX-after-`invalidateOrder` false positive is gone;
(2) adds a **TRAMPOLINE** data-integrity guard (#3) — `_wrap` commits `keccak256(ctx)` to transient
storage and `executeOperation` reverts `ParamsTampered` unless the callback `params` hash matches, so the
pool can't inject/alter the settle calldata; (3) routes all token moves through **OpenZeppelin v5.5.0
`SafeERC20`** (#2, vendored submodule per review feedback — not a hand-rolled lib). Fill-correctness still lives in `CoWSafeWrapper`
(`filledAmount >= expectedFill`, with a `filledBefore == 0` precheck). CoWSafeWrapper/handler unchanged.
Verified on-chain: `name()`/`POOL()`/`SETTLEMENT()` correct; runtime bytecode matches the public-repo
source (Sourcify-reproducible) except the immutable `POOL` insertion. Deploy: `script/DeployFlashWrapper.s.sol`.

**For Kaze / staging allowlisting (UPDATED):** allowlist on the staging authenticator
- CoWSafeWrapper `0x531636e6e18F3A52c283aCCda39D7185E4597A37`
- CowFlashLoanWrapper `0x2E3fdEe28D7224ED140B4ea08C57F47546679363`  ← NOT the old `0x7aC5…785d`
- plus the solver address that will call `wrappedSettle`.

⚠️ The queued Kaze proposal (manager Safe nonce 201, 3/4 confirmations) whitelists the **old** flash
wrapper `0x7aC55b24af85C6F5e866293B38E3ff795CAe785d`. It must be swapped to `0x2E3fdEe28D7224ED140B4ea08C57F47546679363`
(or a follow-up proposal added) before/after execution. CoWSafeWrapper `0x531636e6…` in that proposal is fine.

Chain layout: solo = `CoWSafeWrapper` final; with flash = `CowFlashLoanWrapper → CoWSafeWrapper → settle`.

### Alternate staging stack (deployed, NOT wired to the live Safe — do not use for the demo)
A second, equivalent CoWSafeWrapper/handler/flash set also exists on staging settlement but is not the
one the live Safe/orders use: CoWSafeWrapper `0x27EBDB6Cefd590FEAF79B20F6e77BF79dc3C04FE`,
CoWSafeSigHandler `0x311A5e7B318e8f2f09B4f7C9b06f5BcF980e8F23`, CowFlashLoanWrapper (old proof-of-settle)
`0x7c20a2ca046c08b9509035D84BeE79f7B28F781D`.

## Leverage management stack (Gnosis staging/barn) — CURRENT (2026-06-12, v3)
| contract | address | notes |
|---|---|---|
| LevManagerModule **v3** | `0xA3044558D8459E37dC26b7d4ee8901e8e6f40fd2` | Retarget has `receiver`; full close = single-delegatecall `closeAndSweep` post (flash repay + minHF + sweep BOTH tokens to receiver) |
| LevSupplyHelper **v3** | `0x8960eD5CB0220CEA1c958E23D0f072BC074822Be` | delegatecall helpers: `supplyAllAndCheck` (INCREASE) + `closeAndSweep` (full close) |
| IntentBootstrap9 | `0xfdC5A861c3C7541bD4351b82d7d08dc835Fd99b3` | wires module v3 into new Safes' `enableModules` |

Superseded (do not use for new Safes): LevManagerModule v1 `0xd504138e…2985` + IntentBootstrap7 `0x0795ec54…0Da5`;
v2 `0x451BA89B…c089` + IntentBootstrap8 `0xB820a25b…a28F` (v2 sweep rode inside MultiSend `0x40A2…130D`,
which is MultiSend**CallOnly** — inner delegatecalls revert, solvers could not fill the close).
Old Safes keep working with the module version baked into them at creation; the webapp only manages v3 Safes.

## PROD build — cross-network anchors (NOT deployed; same salts ⇒ same address on every chain)
Settlement (prod) `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`:
- CoWSafeWrapper `0xf0648c2143Ee2A4B3422982F35946eE6C5DdFD3e`
- CoWSafeSigHandler `0xB28d31C53AfAe3a12ff42DCfF30a388d985D959B`
- CowFlashLoanWrapper `0x02a80029E730937d35CE97D240E19C957E82E7d9` (trampoline + SafeERC20 build, salt `…v6`; Aave pool arg is per-chain — anchor holds only where the pool address matches Gnosis')

## Not yet deployed
- **CowAaveLevWrapper** (Model B specialized) — e2e-tested 9/9; deploy on request once Model A staging e2e is done.

## Superseded (do NOT use)
- **CowFlashLoanWrapper `0x7aC55b24af85C6F5e866293B38E3ff795CAe785d`** (staging, proof-of-settle build) —
  replaced 2026-06-10 by the trampoline build. Required a solver-supplied non-empty `uids` array, which is
  unfillable through the appData hint path (the uid can't embed itself), so a real staging solver's
  attempt reverted with `"uids"` (Tenderly-confirmed).
- **CowFlashLoanWrapper `0x450266BDdb1F17e369Ddf4d516A3908E178C6B9f`** (staging, trampoline build, salt
  `…v2`) — interim deploy compiled from the twap working copy (GPL header / different remappings), so its
  metadata hash did NOT match the published MIT source. Abandoned.
- **CowFlashLoanWrapper `0x8dC813d89Dd4240ab16b8f74337148f3Db49a888`** (staging, trampoline build, salt
  `…v3`) — public-repo-reproducible, but pre-SafeERC20.
- **CowFlashLoanWrapper `0x1Dc6F07799C479a553ded6a3E485abE71089106f`** (staging, v4) — hand-rolled
  SafeTransfer without the `token.code.length` check (Codex finding on issue #2).
- **CowFlashLoanWrapper `0xfe983Ae3837d4cC3ae1d4F18283e80083612E4CD`** (staging, v5) — fixed the code
  check but still hand-rolled; replaced by v6 with vendored OZ SafeERC20 per @fleupold's review.
- 2026-06-09 staging: wrapper `0xA7B70bd4e589B589c6665E26fC55917BEF872533`, handler `0x19E98f06CE83592917A854d624392956b8f6162f` (pre hash-commit/delegatecall/final-only)
- earlier drafts: `0xe7b8409f…7561`/`0x523cEB30…DE12`; `0x2888…8C9f`/`0x966b…0260`
