# On-chain implementation (branch: feat/onchain-leverage)

Turns the leverage UI mockup in this repo into a **real on-chain product** on Gnosis staging (barn),
reusing CoW Protocol's wrapper stack. Open and fully manage a one-collateral / one-debt leveraged
position from a fresh EOA — **one signature per action**, everything else executed by organic CoW
solvers. No custom solver privilege is used.

## How it works
- **Open** — the user signs ONE gasless CoW "carrier" order (sell equity → receiver = their
  counterfactual Safe) with a pre-hook that calls `IntentBootstrap`. A solver settlement deploys the
  user's 1/1 Safe (CREATE2 address binds the full intent), enables the wrapper + manager modules,
  reconstructs the leverage order's appData/UID **on-chain**, registers it; the leverage order then
  fills through `CowFlashLoanWrapper → CoWSafeWrapper → settle`.
- **Manage** — the user signs ONE EIP-712 `Retarget` intent over `LevManagerModule`; **anyone relays**
  `execute(intent, sig)`. The module verifies the owner signature + replay nonce + module-enabled,
  derives the canonical pre/post + appData + UID on-chain (the user never signs opaque calldata),
  registers the meta-order, and emits it for the relayer to submit. Two modes:
  - **REDUCE** — close / partial close / decrease leverage (flash debt → repay → withdraw → sell → repay).
    A **full close** with the signed `receiver` field set sweeps ALL residual tokens (proceeds + dust)
    straight to the receiver (default: the owner's wallet) — the Safe ends completely empty.
  - **INCREASE** — increase leverage (borrow → buy collateral → supply full balance), with a signed
    `minHealthFactor` guard enforced on-chain.

## Layout
- `contracts/` — Solidity (LevManagerModule, IntentBootstrap, helpers, the wrapper stack) + a fork test.
- `onchain/` — `open.py`, `manage.py` (reproduce open/increase/decrease/close), and PROVEN.md (on-chain proofs).
- `frontend/` — the real Next.js pages/routes (`/onboard`, `/manage`, `/api/*`).
- `docs/` — PLAN.md and the codex design/security reviews.

## Proven on-chain (organic solvers, no solver privilege)
Open · full close · increase (HF-guarded) · partial close (HF-constant) · the full pipeline through the
production web routes. See `onchain/PROVEN.md` and `onchain/web-e2e-PROVEN.md`.

## Known limitations (acceptable for a staging demo)
1/1 Safe; fresh-quote `minBuy` (oracle-relative bound is a hardening); fixed 5bps flash premium; no-flash
INCREASE is capped by current Aave capacity; positions list is localStorage (no chain auto-discovery);
contracts are unaudited demo code.
