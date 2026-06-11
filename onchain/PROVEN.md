# On-chain proofs (Gnosis barn, organic solvers — NO solver privilege)

All management actions are owner-signed EIP-712 `Retarget` intents relayed by anyone through
`LevManagerModule.execute`, then the resulting CoW order (signature "0x") is filled by an organic
barn solver. Verified on-chain.

## Open (carrier order, one signature)
IntentBootstrap7 enables [CoWSafeWrapper, IntentBootstrap7, LevManagerModule] on the deployed Safe.
A single carrier signature → solver settlement deploys the Safe + registers + opens the leverage order.

## REDUCE (full close) — Safe13
Signed Retarget(mode=REDUCE, repayAmount=MAX) → relay execute → solver fill → position 0/0, equity
returned (0.00556 WXDAI). Relay tx 0xcaf1f8a2…4f17.

## INCREASE (increase leverage) — Safe15
Signed Retarget(mode=INCREASE, borrow capped at Aave availableBorrows) → borrow debt → buy collateral
→ supply FULL bought balance (delegatecall LevSupplyHelper, no idle slippage) → minHF guard.
Result: collateral 1.907e13→2.647e13, debt 2.002e16→2.443e16, WETH dust → 0, HF 1.505 ≥ 1.05 floor.
Relay tx 0xf03e17d6…a189.

## REDUCE (partial close 50% / decrease leverage) — Safe15
Signed Retarget(mode=REDUCE, fraction 50%): flash 50% debt → repay 50% → withdraw 50% collateral →
sell → repay flash. Result: collateral and debt EXACTLY halved, **HF unchanged (1.505)** — proportional
reduction keeps health constant. Proceeds returned to the Safe. Relay tx 0x638a67b0…241c.

Reproduce: `onchain/open.py <key> <equityWei> <levX1000>` then
`onchain/manage.py {reduce|increase} <safe> <key> [fractionBps|extraWei]`.
