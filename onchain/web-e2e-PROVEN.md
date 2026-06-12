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
