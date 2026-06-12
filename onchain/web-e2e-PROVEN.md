# Frontend e2e (through the actual web routes, organic solver)
Opened Safe16 (0xFBfBa32F8aEAbC2c7386B21a1c247C56BB84E628). Drove a partial close (50%) through the
SAME routes the manage UI calls: /api/relay-execute (relays the owner-signed Retarget through
LevManagerModule.execute) + /api/barn (PUT appData, POST order). Organic solver filled it; collateral
and debt both exactly halved (14307779707405→7153890032479, 15018000371671917→7509000681398529).

## /leverage page rewired to barn flow — e2e proven (2026-06-12)

The production `/leverage` page (twap.koeppelmann.dev/leverage) was rewired from the
self-contained LevLong appData-hook flow (production CoW, unreliable) to the proven
barn mechanism: 1-signature carrier open + LevManagerModule signed-Retarget manage.
Verified live on Gnosis barn with organic solvers (no solver privilege):

- OPEN (carrier, 1 sig): Safe 0xc07D98974D4ab3d14C70Cc89fFf4e18A343e323B (0.01 eq, 2x) — filled
- OPEN: Safe 0x530C50263D19BbE667956Ec6f81CfC3A446D68a9 (0.03 eq, 2x) — filled
- INCREASE (mode 1, page math): filled, HF>=1.05 enforced
- DECREASE (mode 0 flash-assisted, NEW): L 2.197 -> 1.519 (target 1.5x), equity preserved — filled
- FULL CLOSE (mode 0, repay MAX): both Safes -> 0 coll / 0 debt — filled

test harness: onchain/test_adjust.py (mirrors page.tsx doAdjust increase/decrease math).

## v3: full close sweeps ALL proceeds to a signed receiver — e2e proven (2026-06-12)

New `Retarget.receiver` field (LevManagerModule v3 `0xA3044558D8459E37dC26b7d4ee8901e8e6f40fd2`,
LevSupplyHelper v3 `0x8960eD5CB0220CEA1c958E23D0f072BC074822Be`, IntentBootstrap9
`0xfdC5A861c3C7541bD4351b82d7d08dc835Fd99b3`). Full close (repayAmount = MAX, receiver != 0)
runs ONE delegatecall post — `closeAndSweep`: flash repay → minHF check → sweep the ENTIRE
remaining balance of BOTH tokens (debt proceeds + collateral dust) to the receiver.

Verified live on barn (organic solver, via the real /api/relay-execute + /api/barn routes):
- OPEN via IB9: Safe 0xD4a2ffE9B627C4F0504Bd878bF58f25f4D998cbe (0.02 eq, 2x) — filled
- FULL CLOSE w/ receiver = owner EOA: order 0x326257ba… — filled
- after: Safe 0 WXDAI / 0 WETH / 0 aWETH / 0 vDebt (completely empty);
  owner EOA +12.9e15 WXDAI (proceeds) and +4.77e12 WETH (dust) in the same settlement.

Gotcha found en route (v2 burned on it): canonical MultiSend 0x40A2…130D is MultiSendCallOnly —
an inner delegatecall op inside its blob reverts, so a sweep cannot ride inside the MultiSend
post (solver simulation failed; nobody filled). Hence the single-delegatecall post, mirroring
the proven INCREASE pattern. New fork test EXECUTES the sweep delegatecall and asserts fund
movement (preview-only assertions cannot catch this class of bug).

## v4: HF-triggered stop orders (trustless deleverage-if-HF<x) — e2e proven (2026-06-12)

LevManagerModule v4 `0xbd913B8626DD7ACe1810E1797C93f27dD7906A5C` + LevSupplyHelper v4
`0xf663f3f18aEe1632C9FFC801dd30D7FfE7196dCb` + IntentBootstrap10 `0x68d25304A69A9F63288Da73ea6a2d72D01dF0DcF`.
`Retarget.triggerHealthFactor` != 0 prepends `requireHFBelow(safe, trigger)` as the FIRST pre op:
solver simulations revert while HF >= trigger, so the order parks and turns fillable exactly when
live HF crosses under the signed threshold. IB10's open post is now ONE delegatecall `openPost`
(supply-ALL bought collateral — closes the codex 'buyMin only' finding; verified: 0 idle WETH after open).

Live sequence on barn (Safe `0x0C9A1ca6eaA4715EC290A7ca7f9C9b0af07F069B`, organic solvers, real /api routes):
1. open 0.015 @ 2x via IB10 -> HF 1.653, idle WETH 0 (supply-all ✓)
2. armed stop: sell 50% if HF < 1.521 (one signature) -> order parked, uid 0x0dd48d29…
3. `requireHFBelow` on-chain: REVERTS while healthy ✓; order sat UNTOUCHED in the open auction 120s ✓
4. INCREASE filled -> HF 1.388 < trigger; `requireHFBelow` flips to PASSING on-chain ✓
5. caveat found: solver drivers cache an order's failed simulations — the 30-min test order was not
   retried within its remaining validity and expired. Mitigation: long-validity stops (the UI signs
   6h) so driver caches expire and retries happen; with many solvers the fastest cache wins.
6. stop #2 with the trigger already breached at submission: **FILLED in 16s** — collateral and debt
   both exactly halved (0.0372→0.0186 / 0.0221→0.0111 USD), HF preserved.
7. full close w/ receiver: Safe 0/0/0/0, ALL proceeds + dust swept to the owner EOA ✓

Conclusion: HF-conditional validity is enforced ON-CHAIN end to end (park ✓ gate-flip ✓ triggered
fill ✓); the only soft spot is solver-side retry latency for orders that spent time unfillable.

## Any-Aave-pair leverage + eMode — e2e proven (2026-06-12 late)

IntentBootstrap12 `0x7Da9A9043be2DE12348fe0668b72b9da315cE821` + LevSupplyHelper v6
`0xC390b54c4f29157ccbD4feCF598C12404F8607ff` (module v4 unchanged — Retarget was already generic).
'Add Leverage' now appears for ANY pair where Aave allows borrowing the sell token against the
buy token; when the pair shares an eMode category the open enters it (supply-all →
setUserEMode → setUserUseReserveAsCollateral → borrow — LTV-0 collaterals like sDAI are NOT
auto-enabled on supply, caught by the executing fork test before deploy use).

Live proofs (barn, organic solvers, real /api routes):
- generic pair WXDAI→wstETH 2.5x: open filled (Safe 0xC97e7D8c…, liqT 7900 = wstETH's own,
  0 idle collateral) → full close w/ receiver sweep → Safe 0/0/0/0, owner +0.01244 WXDAI.
- eMode pair USDC.e→sDAI (cat 3 'sDAI/USDCe', LTV 90%): open filled (Safe 0x336a00aC…,
  on-chain getUserEMode == 3, leverage 4.01x on a base-LTV-0 collateral — impossible outside
  the category, liqT 9200) → full close w/ sweep → Safe 0/0/0/0, owner +0.0104 USDC.e —
  also exercises a 6-decimals debt token end to end.
UI: slider max derives from the pair's LTV (9.7x on the eMode pair), eMode label + LTV shown
before signing.
