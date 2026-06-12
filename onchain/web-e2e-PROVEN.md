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
