# On-chain proofs (Gnosis barn, organic solvers — no solver privilege)

## Open (carrier order, 1 signature)
- IntentBootstrap7 enables [CoWSafeWrapper, IntentBootstrap7, LevManagerModule] on the deployed Safe.
- user13 signed ONE carrier order; solver settlement deployed Safe13 `0x4340e89ED5D5D1Ca08327850E7cEA82E0204797E`
  + registered the leverage order; leverage order filled → 2x WETH long (aWETH 9e12 vs debt 0.010012).

## Manage: REDUCE/close via signed intent (relayed through the module)
- user13 signed an EIP-712 `Retarget` (mode REDUCE, full close); the **relay EOA** called
  `LevManagerModule.execute(intent,sig)` (relay tx `0xcaf1f8a2ebf9ed0869c19287a47c48a3ce670f8545caaf2e82b5cf8856484f17`).
- Module verified owner sig + replay nonce + module-enabled, derived pre/post+appData+UID on-chain,
  registered the close meta-order. Relayer submitted the close order (signature "0x").
- Organic solver filled it → position closed: aWETH 0, debt 0, **0.00556 WXDAI returned** to the Safe.

Replay `onchain/manage.py reduce <safe> <ownerKeyFile>` to reproduce a close.
