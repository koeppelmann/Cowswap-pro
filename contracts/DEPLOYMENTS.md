# On-chain deployments (Gnosis staging / barn)

| Contract | Address | Role |
|---|---|---|
| CoWSafeWrapper | `0x531636e6e18F3A52c283aCCda39D7185E4597A37` | enforced Safe pre/post around a CoW settlement (whitelisted solver) |
| CowFlashLoanWrapper | `0x2E3fdEe28D7224ED140B4ea08C57F47546679363` | Aave V3 flash layer (whitelisted) |
| CoWSafeSigHandlerSim2 | `0xf2044b74959F6bC291dc803C24bF0D7E6379fcC8` | Safe fallback handler (bless + sim-validity) |
| IntentBootstrap7 | `0x0795ec54A7C79403C2CD6BE77C738bf298670Da5` | open: deploy Safe + register leverage order from intent (modules incl. LevManager) |
| LevManagerModule | `0xd504138eD8d6bF01A6C2c3e6f83298aE7242E985` | manage: owner-signed Retarget → registered meta-order, anyone-relayed |
| LevSupplyHelper | `0x28168683E6115A99DA995f9fDA95A88e885C9A15` | delegatecall: supply full collateral (INCREASE) |
| CloseHelper | `0x91886ba723Ce332c87ede9985b73A4a37Cd1a16f` | view-derive a close meta-order (legacy Safe-tx close path) |

External: settlement (barn) `0xf553d092…CB13` · vaultRelayer (barn) `0xC7242d16…8FB2` · Aave V3 pool
`0xb5020155…26D8` · WXDAI `0xe91D153E…a97d` · WETH `0x6A023CCd…f6e1`.
