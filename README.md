# CoW Swap Leverage

Leveraged long positions as **CoW Protocol intents**: open, increase, decrease, partially close and
fully close an Aave V3 position with **one human-readable signature per action**. Every trade is a
regular CoW order settled by **organic solvers** in the competitive auction — no custom solver, no
solver privilege, no keeper.

Live demo (Gnosis **staging/barn**): **https://cowswap.koeppelmann.dev** — the Swap tab of the
merged app, e2e-proven with real solver fills (see [`onchain/PROVEN.md`](onchain/PROVEN.md) and
[`onchain/web-e2e-PROVEN.md`](onchain/web-e2e-PROVEN.md)).

> This branch (`feat/onchain-leverage`) turns the original UI mockup (still in `client/`) into a
> working on-chain product. Contracts are unaudited staging code.

---

## The core idea

A leveraged position is just a swap with extra pre/post steps. CoW already lets a solver execute
hooks and flash loans around a swap — the hard part is doing that **trustlessly**, so the user signs
*what they mean* (an intent: "2× long WETH with 100 WXDAI") and not opaque calldata, while solvers
remain free to route the swap however they like.

The user only ever signs **two kinds of EIP-712 messages**:

1. a **GPv2 order** (the same struct cowswap.exchange users sign every day), and
2. a **`Retarget` intent** — a named, human-readable struct (`safe`, `mode`, `sellAmount`,
   `repayAmount`, `minBuy`, `minHealthFactor`, `receiver`, `triggerHealthFactor`, …) over the
   `LevManagerModule` domain.

Everything else — Safe deployment, appData reconstruction, order registration, flash-loan plumbing,
health-factor checks, sweeping proceeds — is derived **on-chain** from those signed intents.

## Architecture

Each position lives in its own **1/1 Gnosis Safe** owned by the user. The Safe's CREATE2 address
commits to the full opening intent, and three modules are enabled at setup:

```
                        ┌────────────────────────────────────────────────┐
   user EOA ──owns──►   │  position Safe (1/1, deterministic CREATE2)    │
                        │  modules: CoWSafeWrapper · IntentBootstrap ·   │
                        │           LevManagerModule                     │
                        └────────────────────────────────────────────────┘
                                ▲                          ▲
            registers meta-orders                    holds aWETH (collateral)
                        │                            and vWXDAI (debt) on Aave V3
        settlement chain:
        CowFlashLoanWrapper ──► CoWSafeWrapper ──► GPv2 settle
        (flash loans)           (enforced pre/post  (CoW auction,
                                 around the fill)    organic solvers)
```

| contract | role |
|---|---|
| **CoWSafeWrapper** | solver wrapper enforcing hash-committed `pre`/`post` Safe transactions around a fill, and `filledAmount ≥ expectedFill`. Meta-orders are registered through the Safe's module slot — only code the *Safe* authorized can register. |
| **CowFlashLoanWrapper** | generic Aave flash-loan layer (`wrapperData = abi.encode(Loan[])`), trampoline-guarded so the pool cannot tamper with the settle calldata. |
| **IntentBootstrap** (current: `IntentBootstrap14`) | one call deploys the user's Safe (if needed) and registers the opening meta-order. The Intent carries `collateral`/`debt`/`eMode`, so ANY Aave pair (borrow sell against buy) can be opened; shared eMode categories are entered automatically for their boosted LTV. The Safe address **commits to every intent field**, so a front-run with different parameters lands on a *different* address — public `bootstrap()` is grief-free. Reconstructs the order's appData JSON and UID fully on-chain. |
| **LevManagerModule** | owner-signed, **anyone-relayed** management. Verifies the EIP-712 `Retarget` signature, replay nonce and module-enablement, derives the canonical pre/post + appData + UID on-chain, registers the meta-order, emits everything the relayer needs. |
| **LevSupplyHelper** | stateless delegatecall helpers run *as the Safe*: `openPostA` (ADAPTIVE open: supply the full bought balance, enter eMode, borrow exactly what the settlement fee shaved off the delivered equity, repay the flash — the user's outlay is EXACT), `supplyAllAndCheck` (INCREASE) and `closeAndSweep` (repay flash → HF check → pay residual tokens to the signed `receiver`). |

Current deployed addresses (Gnosis staging/barn) are in
[`contracts/DEPLOYMENTS.md`](contracts/DEPLOYMENTS.md).

## Flow 1 — opening a position (one signature, gasless)

The user picks equity `E` and leverage `L`. The app derives `flash = E·L`,
`repay = flash·1.0006` (covers Aave's 5 bps premium), `borrow = repay − E`, and shows the
**deterministic Safe address and both order UIDs before anything is signed**.

```
user signs ───► carrier order: sell EXACTLY E (the stated amount) → receiver = counterfactual Safe
                appData pre-hook: IntentBootstrap.bootstrap(intent)

solver settles the carrier order:
  1. pre-hook bootstrap(intent):
       · CREATE2-deploys the 1/1 Safe (address commits to the whole intent)
       · enables the three modules, registers the leverage meta-order on CoWSafeWrapper
  2. the fill itself delivers the user's equity to the Safe

the leverage order (EIP-1271, signature "0x", from = the Safe) then fills:
  CowFlashLoanWrapper: flash-borrow `flash` WXDAI to the Safe
    CoWSafeWrapper pre:  approve relayer / pool
      GPv2 settle:       sell `flash` WXDAI → ≥ `buyMin` WETH (receiver = Safe)
    CoWSafeWrapper post: openPostA (one delegatecall) — supply the FULL bought balance (positive
                         slippage earns yield immediately) · enter the pair's eMode category (if
                         any) · borrow exactly `repay − equity_received` (settlement fees shift the
                         borrow by their size, never the user's outlay) · repay the flash loan
```

The user's only on-chain prerequisite is the standard one-time WXDAI approval to the CoW vault
relayer (WXDAI has no permit) — identical to using cowswap.exchange.

Both order UIDs are deterministic: the leverage UID is reconstructed on-chain by
`IntentBootstrap.uid(intent, safe)`; the carrier UID is `GPv2 digest ++ owner ++ validTo`.

## Flow 2 — managing a position (one signature, anyone relays)

The owner signs a `Retarget` intent; a relay EOA (or anyone) calls
`LevManagerModule.execute(intent, sig)`. The module checks *owner signature*, *replay nonce*,
*deadline* and *module-enabled*, then registers a meta-order whose pre/post it derived itself —
the relayer contributes gas, never authority. The resulting CoW order is submitted with
`signingScheme: eip1271, signature: "0x"`; the Safe's sig-handler attests it because the wrapper
registration exists.

Two modes cover all management verbs:

**REDUCE (mode 0)** — close / partial close / decrease leverage:

```
flash-borrow `flash` WXDAI
  pre:  repay `repayAmount` debt (MAX = full close) · withdraw collateral · approve relayer
  fill: sell `sellAmount` WETH → ≥ `minBuy` WXDAI   (the CoW order)
  post: repay flash + premium
        · with `receiver` set (full OR partial): closeAndSweep — pay the freed equity to the
          receiver, balances read at execution time. Full close sweeps everything; a partial close
          pays the debt-token surplus plus `withdrawExtra` collateral, so the user can choose to
          receive EITHER asset. Default receiver = the owner's wallet.
        · receiver = 0: residual stays in the Safe; enforce signed minHealthFactor
```

**INCREASE (mode 1)** — increase leverage (no flash; bounded by current Aave capacity):

```
pre:  borrow `sellAmount` WXDAI · approve relayer
fill: sell WXDAI → ≥ `minBuy` WETH
post: supplyAllAndCheck — supply the FULL bought balance, require HF ≥ minHealthFactor
```

**Stop protection (HF-triggered deleverage)** — a REDUCE intent with `triggerHealthFactor` set
parks in the orderbook and is fillable **only while the live health factor is below the trigger**:

```
pre[0]: requireHFBelow(safe, trigger)   ← reverts while HF >= trigger (on-chain, every simulation)
pre[1…]: the normal REDUCE steps        ← unchanged
```

One signature arms it. While the position is healthy every solver simulation reverts at `pre[0]`,
so the order sits untouched; the moment the market pushes HF under the signed threshold the whole
competitive auction races to deleverage you — no keeper decides the timing, the trigger lives
on-chain, and `minBuy` is priced for the trigger scenario (HF scales 1:1 with price at constant
debt). Caveat: solvers cache failed simulations per order, so a stop that parked for a while may
be retried with some delay after triggering — sign stops with long validity (the UI uses 6h).

Safety properties of `Retarget` (see `contracts/src/LevManagerModule.sol`):
- domain binds `chainId` + module address; `safe` is part of the signed struct;
- per-Safe replay nonces; deadline; `orderValidTo ≤ deadline`;
- partial REDUCE requires `repayAmount ≤ flash` (always flash-covered);
- INCREASE forbids flash/repay and enforces a signed `minHealthFactor` post-condition on-chain;
- `receiver` is signed — a relayer can never redirect proceeds;
- on a *full* close `minHealthFactor` is vacuous (no debt remains → HF is ∞); execution quality is
  protected by the signed `minBuy` only, so the UI signs `minHealthFactor = 0` there;
- low-s + v∈{27,28} signature malleability hardening.

### A gotcha worth knowing

The canonical MultiSend `0x40A2…130D` used for pre/post blobs is **MultiSendCallOnly** — inner
`delegatecall` ops revert. Balance-dependent steps (supply-all, sweep-all) therefore run as a
**single delegatecall SafeTx** to `LevSupplyHelper`, never inside a MultiSend blob. The fork test
suite executes these delegatecalls for real (`contracts/LevManagerModule.fork.t.sol`).

## Repo layout

- `contracts/` — Solidity sources (module, bootstrap, helpers, wrapper stack) + fork tests + deployments.
- `onchain/` — `open.py` / `manage.py` / `test_adjust.py`: scriptable reproductions of every flow, plus on-chain proofs.
- `frontend/` — the real Next.js surfaces: `components/SwapTab.tsx` (the merged app's default Swap
  tab: plain swaps for any listed pair, 'Add Leverage' on the supported pair, positions in the token
  list with close/adjust/stop), `app/page.tsx` (Swap · Limit · TWAP tabs), `lib/onboard.ts`
  (constants/ABIs), `app/api/barn` (orderbook proxy), `app/api/relay-execute` (gas-paying relay).
- `docs/` — design plan and codex security reviews.
- `client/` — the original UI mockup this work implements.

## Proven end-to-end (organic solvers)

Open (carrier, 1 sig) · increase (HF-guarded) · decrease (partial REDUCE) · full close with
**sweep-to-owner** (Safe ends 0/0/0/0; owner EOA receives proceeds + dust) — all through the real
web routes against the barn orderbook. Receipts and UIDs: [`onchain/PROVEN.md`](onchain/PROVEN.md),
[`onchain/web-e2e-PROVEN.md`](onchain/web-e2e-PROVEN.md).

## Known limitations (staging demo)

1/1 Safe only; `minBuy` comes from a fresh quote (an oracle-relative bound is a planned hardening);
flash premium fixed at 5 bps (a premium *increase* makes closes revert until redeploy; a decrease
strands the difference in the flash wrapper rather than the receiver); no-flash INCREASE is capped by current Aave borrow capacity; the
positions list is localStorage-seeded (filtered on-chain by `isOwner` + `isModuleEnabled`);
contracts are unaudited.

---

### Running the original UI mockup

The design prototype lives in `client/` (React + Vite + Tailwind + shadcn/ui):
`npm install && npm run dev`, then open the printed local port.
