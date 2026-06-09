# TWAP Safe — approve-to-deploy CoW Protocol TWAPs

Create a CoW Protocol **TWAP** order, get a **deterministic Safe address**, and just
**approve that address** to spend your sell token. The Safe is deployed only when
someone triggers it, and the **moment it's deployed the TWAP order is already live**
— the deploy tx pulls your tokens via `transferFrom`, registers the order, and
starts it, all atomically. No second signature, no backend required, and your
tokens never sit in an undeployed address.

The trick: the Safe's CREATE2 address is derived from its entire `setup()`
initializer, so the address *commits* to (a) your wallet as the only owner, (b)
the CoW `ExtensibleFallbackHandler`, and (c) an initial transaction that pulls the
sell token from you and registers your exact TWAP. Because the Safe runs that
initializer *as itself*, it is the approved spender — so a deployment can only
ever reproduce precisely your configuration; a malicious deployer can't substitute
different params (the address would change) and can't redirect your funds (you
approved that specific address, and proceeds go to your wallet).

**Allowance model (why no tokens are ever stranded):** you grant an ERC-20
allowance to the counterfactual Safe address instead of transferring tokens to it.
If the order is never deployed, just revoke the approval — nothing was ever moved.

Works on **Ethereum** and **Gnosis Chain** (more chains are a config entry away).

```
┌── you ──────────┐     ┌── this app ─────────────┐     ┌── chain ─────────────┐
│ pick sell/buy,  │ ──▶ │ build setup() initializer│ ──▶ │ predicted Safe addr  │
│ amount, parts,  │     │ predict CREATE2 address  │     │ (not deployed yet)   │
│ interval        │     └──────────────────────────┘     └──────────┬───────────┘
└─────────────────┘                                                  │ approve addr
                                                                     ▼
                              anyone calls createProxyWithNonce ─▶ Safe deployed:
                              • owner = you   • transferFrom pulls your tokens
                              • relayer approved   • TWAP registered & started
                                                                     ▼
                                          CoW watch-tower cuts each part → solvers settle
```

## Layout

| Path | What |
|------|------|
| `contracts/` | Foundry project. `TwapSafeInitializer` (the delegatecall helper), interfaces, the deterministic-deploy script, and a **Gnosis fork test** proving the whole flow on real chain state. |
| `web/` | Next.js dapp (wagmi + viem). Configure → predict → approve → auto-deploy. Includes a TS SDK (`web/src/lib`) that is **cross-checked byte-for-byte** against the on-chain-proven Solidity encoding. |

## How it works (the three moving parts)

1. **`Safe.setup()` runs an initial transaction.** Its `to`/`data` args are a
   `delegatecall` executed after owners and the fallback handler are set. We point
   it at `TwapSafeInitializer`, which (running in the Safe's context) does:
   - `transferFrom(you, Safe, n × partSellAmount)` — pulls your sell token using
     the allowance you granted to this CREATE2 address (msg.sender == the Safe ==
     the approved spender);
   - `setDomainVerifier(GPv2 domain, ComposableCoW)` — a **self-call**, the only
     way to satisfy the handler's `onlySelf` guard (this is why a plain MultiSend
     can't do it: it would need the Safe's own address, which is circular);
   - `approve(VaultRelayer, n × partSellAmount)`;
   - `ComposableCoW.createWithContext(params, CurrentBlockTimestampFactory, …)` —
     registers the TWAP and stamps "start now" into the cabinet (so `t0 = 0`).
2. **`SafeProxyFactory.createProxyWithNonce` is CREATE2.**
   `salt = keccak256(keccak256(initializer) ++ saltNonce)`, and the address hashes
   in the singleton + the full initializer above. → address = commitment.
3. **The CoW watch-tower** indexes the `ConditionalOrderCreated` event and cuts a
   signed discrete order for each part; solvers settle them with MEV protection.

## Contracts

```bash
cd contracts
forge build
forge test                                              # offline: fork test skips
GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test -vv   # full end-to-end fork test
```

The fork test (`test/TwapSafeInitializer.fork.t.sol`) predicts the address, has the
user **approve** it (tokens stay in the user's wallet), deploys via the real
`SafeProxyFactory`, then asserts: predicted == deployed, the sell token was pulled
from the user into the Safe at deploy (`transferFrom`), owner/threshold set, domain
verifier wired, order registered, start-time stamped, relayer approved, and that
`getTradeableOrderWithSignature` returns a valid first part with a real ERC-1271
signature.

### Deploy the helper (one-time per chain, deterministic address)

```bash
forge script script/DeployInitializer.s.sol --sig "predict()"          # show address
forge script script/DeployInitializer.s.sol --sig "run()" \
    --rpc-url <RPC> --broadcast --private-key $PK
```

It deploys through the canonical CREATE2 deployer so the helper lands at the **same
address on every chain**: `0x3afA7DB0BEC365b4CF169A3556acDDe6653d0E18` (with the
pinned solc 0.8.34 / optimizer 200 / cancun settings in `foundry.toml`). After
deploying, that address is already wired into `web/src/lib/chains.ts`.

## Web app

```bash
cd web
npm install
npm test          # SDK cross-check vs the Solidity vector
npm run dev       # http://localhost:3000
```

Connect a browser wallet (MetaMask etc.), pick Ethereum or Gnosis, configure the
order, then **Approve** the predicted Safe address. The relayer auto-deploys the
instant the approval lands (a manual **Deploy** button is the fallback). Your
tokens stay in your wallet until that single deploy tx pulls them and starts the
TWAP; if you never deploy, just revoke the approval.

## Adding a chain

Add an entry to `CHAINS` in `web/src/lib/chains.ts` (CoW/Safe addresses are
identical across chains; only the Safe singleton and token list differ), make sure
`TwapSafeInitializer` is deployed there, and add the chain to `web/src/lib/wagmi.ts`.

## v2 features

- **Quotes & pricing** (`/api/quote` proxy → CoW): auto-fills the limit from a live
  market quote, **slippage tolerance** (price protection), and shows the
  **TWAP-vs-sell-all-at-once** price difference. Form matches CoW's model
  (sell + parts + interval, sell/buy-per-part). Interval presets **1m / 5m / 15m / 1h**.
- **Redeem / cancel** (`RedeemPanel`): sweep remaining sell/buy tokens back to the owner
  and cancel future parts (`ComposableCoW.remove`) — via Safe `execTransaction` with the
  owner's pre-validated signature (no separate signing step).
- **Persistence**: SQLite (`better-sqlite3`, `web/.data/orders.db`) via API routes
  `POST/GET /api/orders` and `GET /api/orders/{safe}`. Every order is saved the moment its
  address is known (before you approve).
- **Order recovery** (see `PLAN.md` §D): with the allowance model nothing is ever stranded
  (revoke the approval if you don't deploy), but to *deploy* a pending order you still need its
  exact `initializer`. Three independent backups keep it recoverable:
  1. **On-chain `TwapDeploymentRegistry`** — `register()` computes the predicted address on-chain
     and emits `Registered(safe, initializer)`. Recover by reading the log for your address and
     calling `createProxyWithNonce`. Permanent & permissionless. Deployed on Gnosis at
     `0xaCa53FB27DDc026A27f039CE98a500C3D6B9091a`.
  2. **Server DB** — primary record.
  3. **Downloadable recovery file** — self-custody JSON with everything needed to redeploy.

## Relayer (auto-deploy)

`relayer/` is a Node service that removes the manual deploy step: it polls the app DB and,
the instant the owner has approved the predicted Safe (allowance ≥ required) and holds the
funds — both decoded straight from the initializer — submits `createProxyWithNonce`. The
Safe's setup then pulls the tokens via `transferFrom` in that same tx. Deployment is
permissionless and ownership is fixed by the initializer, so the relayer deploys safely on
the user's behalf; the public CoW watch-tower then posts each part.

```bash
cd relayer
RELAYER_PK=0x... node index.mjs          # continuous (polls every POLL_MS, default 15s)
RELAYER_PK=0x... node index.mjs --once   # single sweep (for testing)
WATCHTOWER=1 ...                         # optional: also post parts (off by default)
```

Proven end-to-end on Gnosis: after the user approved the predicted Safe, the relayer
auto-deployed it (pulling the tokens via `transferFrom` at deploy) and both TWAP parts then
filled with no user transaction beyond the initial approval.

## Order history

The app lists the connected owner's TWAPs (`HistoryPanel` ← `/api/orders`), with pair, size,
schedule and explorer/Safe links. Orders are recorded in the DB the moment their address is
generated. (Note: only orders created via the app are recorded; on-chain backfill of older
safes is a TODO.) Intervals under ~3 minutes are flagged — CoW rejects parts whose `validTo`
is too soon, so 1-minute parts never fill; use 5m+.

## Notes & limitations

- TWAP sells **ERC-20s only** (native ETH must be wrapped to WETH first).
- Number of parts must be ≥ 2; interval ≤ 365 days (enforced by the TWAP handler).
- Approved allowance (and wallet balance) must reach `n × partSellAmount`; the app checks exactly that before deploying.
- Cancel remaining parts post-deploy with `ComposableCoW.remove(orderHash)` from
  the owner wallet (a future UI addition).
- A relayer/back-end that auto-deploys on funding can be layered on top — deployment
  is permissionless and ownership is fixed by the address regardless of who sends it.
