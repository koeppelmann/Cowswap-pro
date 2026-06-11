# Frontend (real on-chain, Next.js / wagmi / viem)

These are the real-implementation pages/routes that wire the leverage UI to the on-chain stack on
Gnosis staging (barn). They run inside a Next.js app (the live app at twap.koeppelmann.dev/leverage);
copied here for the record on this branch.

- `app/onboard/page.tsx` — OPEN a position with one signature (carrier order → IntentBootstrap deploys
  the Safe + opens), and CLOSE via an owner-signed Safe-tx relayed (CloseHelper path).
- `app/manage/page.tsx` — INCREASE / DECREASE / partial-close / close a position with **one signature**
  per action: signs an EIP-712 `Retarget` intent over `LevManagerModule`, relays it via
  `/api/relay-execute`, submits the resulting CoW order, polls to fill. Shows live coll/debt/HF.
- `app/api/barn/route.ts` — server proxy to the barn orderbook (quote / app_data PUT / order / status).
- `app/api/relay/route.ts` — relays an owner-signed Safe tx (close via CloseHelper).
- `app/api/relay-execute/route.ts` — relays a signed `Retarget` through `LevManagerModule.execute`,
  returns the emitted uid + appData for submission.
- `lib/onboard.ts` — addresses, ABIs, and EIP-712 types.

The relay EOA key is read from `~/.relay-key/` (never committed). The barn orderbook needs no key.
