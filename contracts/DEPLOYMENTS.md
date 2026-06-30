# Deployments

This Foundry project holds **only the contracts this app adds on top of the CoW wrapper
stack** — the TWAP "approve-to-deploy" initializers and the leverage onboarding/management
contracts. The generic CoW wrapper layer is a separate, reusable repo and is pulled in as a
dependency, not copied here.

## CoW wrapper stack → [`koeppelmann/cowswap_wrapper`](https://github.com/koeppelmann/cowswap_wrapper)

`CoWSafeWrapper`, `CoWSafeSigHandler`, `CowFlashLoanWrapper`, and the `CowWrapper` base live in
that repo and are pulled in here as a git submodule at `lib/cowswap_wrapper` (remapping
`cowswap-wrapper/`). Our contracts import its types (`MetaOrder`, `SafeTx`, `OrderExec`) and
reference the deployed wrappers by address. See that repo's `DEPLOYMENTS.md` for the full set and
verification; the instances **this app is wired to** (Gnosis, CoW **staging / barn** settlement
`0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13`, Aave V3 pool
`0xb50201558B00496A145fE76f7424749556E326D8`):

| contract (cowswap_wrapper) | address |
|---|---|
| CoWSafeWrapper | `0x531636e6e18F3A52c283aCCda39D7185E4597A37` |
| CoWSafeSigHandler | `0x29619484de063A3E06e432a0CCBF5a2BE6F024DC` |
| CowFlashLoanWrapper (trampoline + OZ SafeERC20) | `0x2E3fdEe28D7224ED140B4ea08C57F47546679363` |

Chain layout: solo = `CoWSafeWrapper` final; with flash = `CowFlashLoanWrapper → CoWSafeWrapper → settle`.

---

All addresses below are **this repo's** contracts. Deterministic CREATE2 via the Arachnid factory
`0x4e59b44847b379578588920cA78FbF26c0B4956C`; compiler solc 0.8.34, optimizer 200, evm cancun.
Verified on **Sourcify (exact_match)** + **Blockscout** (Gnosisscan where the deploy wasn't a
factory call). No admin anywhere.

## TWAP — `approve-to-deploy` (CoW **production**)

Settlement `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`. The Safe's CREATE2 address commits to a
`setup()` that pulls your tokens and registers the TWAP atomically on deploy (see top-level README).

| contract | address | chain(s) | deploy script |
|---|---|---|---|
| **TwapSafeInitializer** (`setup()` delegatecall helper) | `0x3afA7DB0BEC365b4CF169A3556acDDe6653d0E18` | Ethereum + Gnosis (same addr) | `script/DeployInitializer.s.sol` |
| **TwapDeploymentRegistry** (permissionless recovery: `Registered(safe, initializer)`) | `0xaCa53FB27DDc026A27f039CE98a500C3D6B9091a` | Gnosis | `script/DeployRegistry.s.sol` |
| **TwapOrderLens** (read-only order/leg enrichment) | `0xd1a12ba577A161a486EE53FA62C5b8Ccf14Fd963` | Gnosis | `script/DeployLens.s.sol` |
| **TwapBootstrap** | `0x2C1aB2AF546f9157628dA8F8b50b6f5Ec9f21422` | Gnosis | — |
| **TwapBalanceInitializer** (zero-dust; sizes parts to the Safe's whole balance) | `0x415667181180052B3fad7Bdf65185Ac730Dce0EC` | Gnosis | — |
| **BarnTwapInitializer** (carrier/post-hook TWAP funding) | source in `src/` | Gnosis (barn) | — |

## Leverage (Gnosis, CoW **staging / barn**) — CURRENT

A funding carrier deposits equity into a deterministic Safe; the position is opened, managed, and
closed through these against the wrapper stack above. Current = v5 module + IntentBootstrap15.

| contract | address | notes |
|---|---|---|
| **IntentBootstrap15** (carrier onboarding; signed `minHealthFactor` open) | `0x325afB837204D46A3D4158deD26a8BE2681761B5` | deterministic Safe + UID derivation |
| **LevManagerModule v5** (current) | `0x239D413A6Ac5322D3ccAaaf43e34045bdAcD7E74` | Retarget (15 fields); partial-close payout to receiver (`withdrawExtra`) |
| **LevManagerModule v4** (legacy) | `0xbd913B8626DD7ACe1810E1797C93f27dD7906A5C` | still enabled on Safes opened before v5 |
| **LevSupplyHelper v8** (delegatecall supply/close helper) | `0x29C3E5CC5bF31A749e91000F362Ea6C4195CEC5B` | adaptive borrow + signed post-open minHF floor; eMode |
| **CloseHelper** (relayed close/reduce meta-order builder) | `0x91886ba723Ce332c87ede9985b73A4a37Cd1a16f` | `registerMetaOrder` against CoWSafeWrapper |

Older leverage iterations (module v1–v4 + IntentBootstrap7–14, the standalone `LevModule`/`LevProxy`
architecture, and the experimental `CowAaveLevWrapper`) have been removed from `src/`; Safes opened
against an older module keep working with the version baked into them at creation. Their addresses
remain in this file's git history.

## Build & verify

```bash
forge build
GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test -vv   # fork tests
forge verify-contract <addr> src/<C>.sol:<C> --chain 100 --verifier sourcify
```
