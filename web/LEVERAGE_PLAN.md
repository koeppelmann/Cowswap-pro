# CoW Leverage — full build plan (overnight)

Goal: a fully functional leverage app at `twap.koeppelmann.dev/leverage` that looks like the
`koeppelmann/Cowswap-Leverage` mockup but is wired to live contracts (real Safes + Aave + CoW).

## Architecture (settled)
- **Per-position Gnosis Safe** (v1.3.0) owned by the user's EOA, with a shared **LevModule**
  as fallback handler + enabled module. LevModule answers CoW/Aave callbacks + EIP-1271 and
  acts as the Safe via `execTransactionFromModule`. (Proven live: open + close.)
- Execution = CoW flash-loan orders (`flashLoanAndSettle`) with pre/post hooks on the Safe.

## Primitives (the SDK must support all)
1. **Open** (new Safe): flashloan debt → buy collateral → `openLeg` (supply+borrow). ✅ done
2. **Increase leverage** (existing Safe): flashloan ΔdebtValue → buy Δcollateral → `openLeg`
   (supply Δ + borrow to repay loan). Equity-preserving. borrow = loan+premium (no equity topup).
3. **Decrease leverage** (existing Safe, equity-preserving): flashloan ΔD → `reducePrepare`
   (repay ΔD, withdraw ΔC) → sell ΔC→debt → `finalize` (repay loan, dust→owner). Position stays open.
4. **Reduce/close by %** to EITHER token: flashloan f·D → reducePrepare(f·D, f·C) → swap → finalize
   (forward freed equity to owner). payout 'debt' = sell-all (kind sell); payout 'collateral' =
   buy-exact loan (kind buy), keep rest as collateral. f=1 → full close.

→ All reduce to 3 module functions: `openLeg`, `reducePrepare(repayAmt, withdrawAmt)`, `closeFinalize`.
   (Generalize the deployed module's `closePrepare`(always-max) → `reducePrepare`(amounts).)

## Phases
- **P1 — Contract**: LevModule v2 with `reducePrepare(repayAmount, withdrawAmount)`. Fork-test ALL
  primitives (open, increase, decrease, partial/full close to debt + to collateral). Deploy + verify.
- **P2 — SDK** (`web/src/lib/sdk/`): `predictSafe`, `buildOpen`, `buildIncrease`, `buildDecrease`,
  `buildReduce/close`, `readPosition` (Aave reads → collateral/debt/HF/leverage/liqPrice), `listPositions`.
  Pure amount-math unit tests + a live integration test (open→increase→decrease→reduce→close) via deployer.
- **P3 — UI**: port the mockup UX to the Next `/leverage` route in plain CSS — swap card, positions in
  the token selector, leverage slider (1–5x), reduce % (25/50/75/Max), adjust-leverage, confirm dialog,
  live metrics (debt, liq price, % to liq, HF). Wire to the SDK + live data (CoW quotes, Aave reads).
- **P4 — Polish**: branding (deep-blue #060918 / cards #12152b / panels #0b0e1e / primary #4C82FB),
  position persistence + on-chain discovery, live test, ship.

## Status
- P1: in progress
