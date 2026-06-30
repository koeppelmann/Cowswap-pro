# CoW Swap Pro (experimental)

An **experimental "pro" interface for [CoW Protocol](https://cow.fi)** with advanced
order types beyond a plain swap:

- **Swap** — ordinary MEV-protected swaps, settled on CoW.
- **TWAP** — time-weighted average price orders via a *deterministic single-use Safe*:
  you only **approve an address**, and the order goes live the instant that Safe is
  deployed — no second signature, no backend custody.
- **Leverage** — one-signature leveraged longs (powered by Aave V3, settled atomically
  by CoW), each position living in its own Safe you fully own. Open, adjust, close,
  and arm trustless on-chain stop-loss protection.

Live (experimental, use at your own risk): **https://cowswap.koeppelmann.dev**

> ⚠️ **Experimental.** This is a research/demo interface. Plain swaps and TWAPs settle on
> CoW production; **leverage runs on CoW's staging (barn) environment**. Contracts are
> verified on-chain (Sourcify) but **unaudited**. Don't risk funds you can't lose.

---

## Why it's interesting

Both TWAPs and leverage trades are initiated the same elegant way: with a **single ordinary
CoW Swap order** — a "funding order" — that sends your funds to a **deterministic Safe address**
computed in advance. That Safe (which you alone own) is created on the fly and immediately runs
the strategy: a TWAP registers and starts its time-sliced order; a leverage position flash-swaps
into the asset and opens the Aave loan. One signature, self-custodied, with nothing stranded — if
you never fund the address, nothing ever happens.

Works on **Gnosis Chain** (full feature set) and **Ethereum** (swaps + TWAP).

---

## Layout

| Path | What |
|------|------|
| `web/` | Next.js dapp (wagmi + viem). Swap / TWAP / Leverage UI, order history with live P&L, `?view=0xADDR` read-only account viewing. Includes a TS SDK (`web/src/lib`) cross-checked byte-for-byte against the on-chain Solidity encoding. |
| `contracts/` | Foundry project — the contracts this app adds *on top of* the CoW wrapper stack: the TWAP `approve-to-deploy` initializers + the leverage onboarding/management contracts (`IntentBootstrap15`, `LevManagerModule`, `CloseHelper`, …), with Gnosis fork tests. The generic CoW wrapper layer is pulled in as a dependency from [`koeppelmann/cowswap_wrapper`](https://github.com/koeppelmann/cowswap_wrapper). See `contracts/DEPLOYMENTS.md`. |

## Run it

```bash
# web app
cd web && npm install && npm test && npm run dev   # http://localhost:3000

# contracts
cd contracts && forge build
GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test -vv   # full fork tests
```

---

## How TWAP works (the three moving parts)

1. **`Safe.setup()` runs an initial transaction** (`delegatecall` after owners + handler are
   set), pointed at `TwapSafeInitializer`, which — running as the Safe — pulls your sell token
   (`transferFrom`, using the allowance you granted this CREATE2 address), sets the GPv2 domain
   verifier (a self-call, the only way past the handler's `onlySelf` guard), approves the CoW
   vault relayer, and registers the TWAP with "start now".
2. **`SafeProxyFactory.createProxyWithNonce` is CREATE2** — `salt` hashes in the full
   initializer above, so the address *is* the commitment.
3. **CoW's watch-tower** indexes `ConditionalOrderCreated` and cuts a signed order per part;
   solvers settle each with MEV protection.

The fork test (`contracts/test/TwapSafeInitializer.fork.t.sol`) predicts the address, approves
it, deploys via the real `SafeProxyFactory`, then asserts predicted == deployed, tokens pulled
at deploy, owner/handler/verifier wired, order registered and started, and a valid first part
with a real ERC-1271 signature.

## How leverage works

A signed in-kind **carrier** order deposits your equity into a deterministic position Safe.
The Safe's pre-signed leverage order then settles atomically through the CoW wrapper stack:
flash-loan the leveraged size → swap to collateral → supply to Aave V3 → borrow the debt token
→ repay the flash. A signed post-settlement **minimum health-factor** floor bounds how much a
solver may under-deliver. Manage/close go through `LevManagerModule` (a signed Retarget intent,
relayed). Realized P&L on closed positions is computed oracle-free from your own opening-swap
rate. Details: `contracts/DEPLOYMENTS.md` + the wrapper repo [`koeppelmann/cowswap_wrapper`](https://github.com/koeppelmann/cowswap_wrapper).

## Recovery & persistence

With the allowance model nothing is ever stranded (revoke if you don't deploy). To *deploy* a
pending TWAP you need its exact initializer — kept recoverable via an on-chain
`TwapDeploymentRegistry` (`Registered(safe, initializer)` event, permissionless), a server DB,
and a downloadable self-custody JSON. Leverage positions are discovered from the CoW orderbook
(carrier orders), so they show on any device, not just the one that opened them.

## Adding a chain

Add an entry to `CHAINS` in `web/src/lib/chains.ts` (CoW/Safe addresses are identical across
chains; only the Safe singleton + token list differ), deploy the helper there, and add the
chain to `web/src/lib/wagmi.ts`.

## Notes & limitations

- TWAP sells **ERC-20s only** (wrap native ETH first); parts ≥ 2; interval ≤ 365 days; use
  ≥ 5m parts (CoW rejects parts whose `validTo` is too soon).
- Leverage is **Gnosis-only** and runs on CoW **staging (barn)**.
- Contracts are verified on-chain (Sourcify) but **unaudited** — research/demo only.
