# Productionization checklist

Status legend: ✅ done · 🟡 partial · ⬜ todo. Priority: **P0** blocker · **P1** important · **P2** later.

## Security & contracts
- ⬜ **P0** External audit of `TwapSafeInitializer` + `TwapDeploymentRegistry` (small surface, but they sit in the funds path).
- ⬜ **P0** Verify & publish source on Etherscan/Gnosisscan for all deployed contracts.
- 🟡 **P0** Threat review: helper is stateless/delegatecall-only (holds no funds); `setDomainVerifier` self-call; `forceApprove` is exactly `n×partSell`; deploy is permissionless + idempotent. Document griefing/edge cases.
- ⬜ **P0** Relayer key hygiene: dedicated hot key that can only *pay gas* (never touches user funds — true today), in KMS/secrets manager, balance + nonce monitoring, auto gas top-up, rotation. Move the local `.deployer/key.json` out of the repo tree.
- ⬜ **P1** Rotate the `debug.cow.fi` creds out of memory/notes; never commit secrets.

## CoW correctness
- 🟡 **P0** Real **appData document** with `appCode` (attribution) + referrer, uploaded via `PUT /app_data/{hash}` (currently `appData=0`). Needed for partner attribution/analytics and best-practice ordering.
- ✅ Enforce a sane **min interval** (UI blocks <3m; CoW rejects short `validTo`). Recommend ≥5m default.
- ⬜ **P1** Optional CoW **partner fee**/volume attribution if monetizing.

## Infrastructure
- 🟡 **P0** Replace **SQLite → Postgres** (Neon/Supabase/RDS) with migrations, backups, PITR. (DB layer is isolated in `lib/db.ts`.)
- ⬜ **P0** **Private RPCs** (Alchemy/Infura/Gnosis) — public endpoints rate-limit and will throttle the relayer/quotes.
- ⬜ **P0** Deploy web app on a host (Vercel/Fly/Railway) with HTTPS + env-based config.
- 🟡 **P0** Harden the **relayer** into a service: per-chain workers, nonce mgmt, retry/backoff, idempotent deploy (skip if code exists ✅), structured logs, alerting, supervision (systemd/docker/k8s). Today: single Node loop, DB-driven, deployer key.
- ⬜ **P1** **Auto-register on-chain** from the relayer/backend *before* revealing the Safe address, so recovery is automatic (today it's a user button).
- ⬜ **P1** API hardening: rate limiting, input validation, CORS, bot protection on `/api/*`.

## Wallet & UX
- ⬜ **P0** **WalletConnect + multiple connectors** (today: injected only) → mobile + more wallets. (RainbowKit/Web3Modal, needs WalletConnect projectId.)
- 🟡 **P1** Real **token list** with search + logos (CoW/Uniswap lists) instead of a curated handful; unverified-token warnings. (Logos ✅ via DefiLlama; list still curated.)
- ⬜ **P1** **Buy-direction** TWAP + native-ETH→WETH wrap helper (today sell-only, ERC-20 only).
- ⬜ **P1** **Recovery import** UI (paste address / drop file → deploy) and **on-chain history backfill** (scan `ConditionalOrderCreated`/registry so pre-DB safes show).
- 🟡 **P1** CoW-style **review/confirm modal**, toasts, loading/empty/error states, mobile QA, a11y. (Widget redesign ✅; confirm-modal todo.)

## Multichain
- ⬜ **P1** Add Arbitrum / Base / Optimism / Polygon: deploy helper + registry deterministically (addresses already canonical), add token lists + RPCs. Config-driven in `lib/chains.ts`.

## Reliability & observability
- ⬜ **P1** Sentry (web + relayer), metrics dashboards, uptime checks.
- ⬜ **P1** **Watch-tower fallback**: run `cowprotocol/watch-tower` (or enable our `WATCHTOWER=1` poster) as backup so part-posting doesn't depend solely on the public service.
- ⬜ **P1** CI (GitHub Actions): `forge test` (+ fork tests w/ RPC secret), `vitest`, `tsc`, `next build` on PRs.
- 🟡 E2E tests (Playwright). Unit + fork tests exist ✅.

## Product / legal
- ⬜ **P2** Terms/disclaimer; **restricted-token warning** (e.g. Monerium EURe receiver allowlists — surfaced as a known footgun).
- ⬜ **P2** Privacy-respecting analytics.
- ⬜ Git init + repo + branch protections.

## Top 5 to ship a real beta
1. Postgres + private RPCs + hosted deploy (P0 infra).
2. Audit + verify contracts (P0 security).
3. Proper appData with appCode (P0 correctness).
4. WalletConnect/multi-wallet (P0 UX).
5. Relayer hardening + auto-register + alerting (P0/P1 reliability).
