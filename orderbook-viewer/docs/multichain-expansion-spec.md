# Multichain Expansion Spec — BNB, Linea, Plasma, Ink, Solana

Status: implementation-ready. Target repo: `/home/ubuntu/code/twap/orderbook-viewer`
(Python collector + bundled-Plotly frontend). Audience: owner + implementer.

Every claim below was verified with live calls (CoW API `/version`, public RPC
`eth_chainId` / `eth_getCode` / `eth_call`, block explorers). Evidence is cited
inline per network. Where a profile's draft conflicts with a load-bearing code
invariant, the invariant wins and the conflict is called out.

---

## 1. Executive summary

CoW Protocol's order book is **live on all five** candidate networks
(`/api/v1/version` returns 200 for `bnb`, `linea`, `plasma`, `ink`, `solana`).
"Supported by CoW" and "addable to this viewer with no new code", however, are
different bars.

| Network | CoW book | Readiness | Addable now as config-only? |
|---|---|---|---|
| **Linea** (59144) | yes | drop_in_config | **Yes** — config + 1 EXPLORERS line |
| **Plasma** (9745) | yes | drop_in_config | **Yes** — config + 1 EXPLORERS line |
| **Ink** (57073) | yes | drop_in_config | **Yes** — config + 1 EXPLORERS line |
| **BNB Chain** (56) | yes | needs_code | **No** — no 6-decimal auction stable (anchor blocker) |
| **Solana** (non-EVM) | yes | needs_code | **No** — non-EVM; needs new SPL/data-path modules |

**Addable right now (pure drop-in path): 3 of 5** — Linea, Plasma, Ink. Each is a
`config/networks.json` entry + one `networks.py` `EXPLORERS` line, launching with
`amm:false` like every other non-mainnet/base chain. The TWAP overlay works on all
three with zero code because ComposableCoW and the TWAP handler are deployed at
their chain-universal addresses (verified by `eth_getCode` on each).

**BNB** is a short code task, not a drop-in: every BSC USD stable in the live
auction (USDC/USDT/BUSD/DAI, all Binance-Peg) is **18-decimal**, and the viewer's
USD anchor must be 6-decimal — `allocator.py:41` asserts
`meta[usdc]['decimals'] == 6`, and four more sites hardcode `10**6`
(`allocator.py:53`, `build.py:138`, `amm.py:177`, `twap_normalize.py:10`).
Either generalize the anchor-decimals (small, clean, benefits every chain) or
accept a low-liquidity 6-decimal anchor (axlUSDC) — an owner decision (§5).

**Solana** is a genuine new workstream (non-EVM): no `eth_call`/Multicall3, base58
case-sensitive mints, per-order fetch only (no `by_uids`), and no
ComposableCoW/AMM/funding equivalents. Ship as a **depth-chart-only MVP** behind
new non-EVM code paths — scoped in §4, framed as an owner go/no-go, not auto-shipped.

### Recommended rollout order

1. **Linea** — cleanest drop-in; 6-decimal native-Circle USDC, Etherscan-family explorer, ETH native.
2. **Ink** — drop-in; 6-decimal native USDC, OP-stack, ETH native.
3. **Plasma** — drop-in; 6-decimal native USDC; newer chain, lighter CoW flow (confirm live order volume post-deploy).
4. **BNB** — after the small anchor-decimals generalization lands (§3.4 / §5). High-value chain (USDT is the dominant BSC stable) but gated on the one code change.
5. **Solana** — separate MVP project on owner approval (§4).

Do 1–3 together in one PR (three config entries + three EXPLORERS lines + tests),
then BNB in a follow-up with the generalization, then Solana as its own effort.

---

## 2. How the add works (shared mechanics)

A non-mainnet EVM chain is config-driven. `config/networks.json` has `order`
(list, display + collection order; a key absent here is never collected) and
`networks` (per-key entries). All per-network code paths key off
`networks.get(network)` plus the generic `network != 'mainnet'` dynamic branch, so
**no change is needed** in `source.py`, `funding.py`, `twap.py`, `twap_api.py`,
`amm.py`, `build.py`, `allocator.py`, `cache.py`, `service.py`, `run.py`,
`http_server.py`, or any frontend asset for an EVM drop-in. The only `.py` edit a
drop-in needs is a `networks.EXPLORERS` entry for correct order/tx links (there is
a `('','')` / `('','https://etherscan.io')` fallback, so the book still builds
without it, but links are wrong).

The three CoW core contracts (GPv2Settlement `0x9008…ab41`, vaultRelayer
`0xC92E…0110`, Multicall3 `0xcA11…CA11`) are hardcoded module constants in
`funding.py:14-16` — same address on every CoW chain — so they are **not** in
`networks.json`. Likewise ComposableCoW `0xfdaf…13b74` and the TWAP handler
`0x6cf1…e5a5` are hardcoded in `twap.py:15-16`; the TWAP overlay runs
unconditionally on every network (`build.py` always calls
`collect_twap_schedules`, defensively wrapped), so it "just works" wherever those
two are deployed.

### Load-bearing invariant (verified)

The USD anchor (`usdc` field) **must be a 6-decimal token present in the live
auction with price > 0**:
- `allocator.py:41` → `assert meta[usdc]['decimals'] == 6 and prices[usdc] > 0`
- `allocator.py:53` → `usd = prices[usdc]*10**6`
- `allocator.py:171`, `build.py:138`, `amm.py:177`, `twap_normalize.py:10` → all hardcode `10**6`
- `build.py:73` → `assert prices.get(usdc,0)>0`

Linea / Plasma / Ink anchors are native-Circle USDC at 6 decimals (verified
on-chain). BNB has no 6-decimal auction stable — the blocker (§3.4, §5).

---

## 3. Per-network sections

### 3.1 Linea — DROP-IN (recommended first)

- **Verdict:** drop_in_config. Confidence: high.
- **Chain:** EVM, chainId 59144 (`eth_chainId` → `0xe708` on both `rpc.linea.build` and `linea-rpc.publicnode.com`). Native ETH.
- **CoW slug:** `linea` (`GET https://api.cow.fi/linea/api/v1/version` → 200, body v2.389.4; `linea-mainnet`/`linea_mainnet` → 404).
- **TWAP overlay:** feasible, zero code. `eth_getCode` on ComposableCoW `0xfdaf…13b74` → real bytecode (`0x6080…595001b2…`); TWAP handler `0x6cf1…e5a5` → real bytecode (`0x6080…01ffc9a7…`); GPv2Settlement + Multicall3 bytecode present.
- **AMM markers:** technically feasible but **not** part of the drop-in → `amm:false`. Dominant Linea liquidity (Lynex, Nile) is Algebra-based concentrated liquidity exposing `globalState()` not Uniswap-v2 `getReserves()`; PancakeSwap v3 / iZiSwap are v3 `slot0()`. Enabling needs a curated catalog **and** Algebra `globalState()` support in `amm.py` — a design task, deferred.
- **RPC:** default `https://linea-rpc.publicnode.com`. Gotchas: official `rpc.linea.build` rate-limits bursts (429) and historically caps `eth_getLogs` ranges + prunes archive; ~2s blocks (fast head). The core book uses `eth_call`@pinned-block + Multicall3 (no heavy getLogs), so pruning is low-risk; if ComposableCoW ConditionalOrderCreated `getLogs` scans hit a block-range cap, point `RPC_LINEA` at a keyed (Infura/Alchemy) endpoint and/or lower `batch_size`. Multicall3 at standard address.
- **Token anchors (on-chain `symbol()`/`decimals()`):** USDC `0x176211869ca2b568f2a7d4ee941e073a821ee1ff` → USDC/**6** (anchor, re-verified live this session); USDT `0xa219439258ca9da29e9cc4ce5596924745e12b93` → USDT/6; DAI `0x4af15ec2a0bd43db75dd04e62faa3b8ef36b00d5` → DAI/18; WETH `0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f` → WETH/18. CoW `native_price`: WETH=1.0, USDC/USDT/DAI finite → all in the live book.
- **EXPLORERS line (`networks.py`):** `'linea': ('linea', 'https://lineascan.build'),` — CoW explorer prefix `linea` inferred from SDK naming (direct probe 429'd; verify once in a browser before relying on order links).

**Exact `config/networks.json` entry** (also append `"linea"` to `order`, e.g. after `"avalanche"`, before `"sepolia"`):

```json
    "linea": {
      "label": "Linea",
      "slug": "linea",
      "chain_id": 59144,
      "rpc_env": "RPC_LINEA",
      "rpc_default": "https://linea-rpc.publicnode.com",
      "native_symbol": "ETH",
      "usdc": "0x176211869ca2b568f2a7d4ee941e073a821ee1ff",
      "weth": "0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f",
      "eth_family": false,
      "amm": false,
      "stables": {
        "0x176211869ca2b568f2a7d4ee941e073a821ee1ff": { "symbol": "USDC", "decimals": 6 },
        "0xa219439258ca9da29e9cc4ce5596924745e12b93": { "symbol": "USDT", "decimals": 6 },
        "0x4af15ec2a0bd43db75dd04e62faa3b8ef36b00d5": { "symbol": "DAI",  "decimals": 18 }
      }
    }
```

**discover_amm.py (only if later enabling `amm:true`):** after a first snapshot exists,
build a minimal book from `.cache/public/linea/orderbook.json` then
`python discover_amm.py --book /tmp/linea-book.json --output /tmp/linea-amm.json --chain linea --rpc https://linea-rpc.publicnode.com`
— but note the Algebra caveat above; v2/v3-only coverage will miss Lynex/Nile depth.

---

### 3.2 Ink — DROP-IN (recommended second)

- **Verdict:** drop_in_config. Confidence: high.
- **Chain:** EVM, chainId 57073 (`eth_chainId` → `0xdef1` on `rpc-gel`/`rpc-qnd`/`ink.drpc.org`). OP-Stack L2 (Kraken/Optimism Superchain). Native ETH.
- **CoW slug:** `ink` (`/ink/api/v1/version` → 200, v2.389.4; `ink_mainnet`/`inkchain` → 404).
- **TWAP overlay:** feasible, zero code. `eth_getCode`: ComposableCoW → 16958 bytes; TWAP handler → 9068 bytes; GPv2Settlement → 32332; vaultRelayer → 9182; Multicall3 → 7618; WETH `0x42…06` → 5732. All deployed.
- **AMM markers:** feasible in part → `amm:false`. Largest venue by TVL is **Uniswap V4** (singleton PoolManager, ~$6.3M) which exposes neither `getReserves()` nor `slot0()`, so a v2/v3 marker layer would miss the deepest pool. Uniswap V3 (~$5.2M, slot0), Velodrome/Slipstream (~$3.2M, slot0), InkySwap (Uni-v2 getReserves, ~$0.9M) are coverable. Ship `amm:false`.
- **RPC:** default `https://rpc-gel.inkonchain.com` (Gelato, official docs default). Gotchas: the bare `rpc.inkonchain.com` host does **not** respond — use `-gel`/`-qnd` subdomains or `ink.drpc.org`. Viewer uses `eth_call`+Multicall3@latest (no heavy getLogs), so pruning is a non-issue; set `RPC_INK_ARCHIVE` only if a per-network archive is ever needed. No special User-Agent required.
- **Token anchors (on-chain):** USDC `0x2d270e6886d130d724215a266106e6832161eaed` → USDC/**6** (native Circle, anchor); USDC.e `0xf1815bd50389c46847f0bda824ec8da914045d14` → USDC.e/6 (Stargate); USD₮0 `0x0200c29006150606b650577bbe7b6248f58470c1` → USD₮0/6; WETH `0x4200000000000000000000000000000000000006` → WETH/18. CoW `native_price`: WETH=1.0, all three stables priced ~$1.
- **EXPLORERS line:** `'ink': ('ink', 'https://explorer.inkonchain.com'),` — prefix `ink` inferred (explorer.cow.fi probes 429'd; verify once).

**Exact `config/networks.json` entry** (also append `"ink"` to `order`):

```json
    "ink": {
      "label": "Ink",
      "slug": "ink",
      "chain_id": 57073,
      "rpc_env": "RPC_INK",
      "rpc_default": "https://rpc-gel.inkonchain.com",
      "native_symbol": "ETH",
      "usdc": "0x2d270e6886d130d724215a266106e6832161eaed",
      "weth": "0x4200000000000000000000000000000000000006",
      "eth_family": false,
      "amm": false,
      "stables": {
        "0x2d270e6886d130d724215a266106e6832161eaed": { "symbol": "USDC",  "decimals": 6 },
        "0xf1815bd50389c46847f0bda824ec8da914045d14": { "symbol": "USDC.e", "decimals": 6 },
        "0x0200c29006150606b650577bbe7b6248f58470c1": { "symbol": "USD₮0",  "decimals": 6 }
      }
    }
```

**discover_amm.py (if later `amm:true`):** `python discover_amm.py --book /tmp/ink-book.json --output /tmp/ink-amm.json --chain ink --rpc https://rpc-gel.inkonchain.com` (confirm DexScreener's Ink slug; Uni-V4 depth stays uncovered).

---

### 3.3 Plasma — DROP-IN (recommended third)

- **Verdict:** drop_in_config. Confidence: high.
- **Chain:** EVM, chainId 9745 (`eth_chainId` → `0x2611` on `rpc.plasma.to`). Native **XPL**.
- **CoW slug:** `plasma` (`/plasma/api/v1/version` → 200, v2.389.4).
- **TWAP overlay:** feasible, zero code. `eth_getCode` on `rpc.plasma.to`: ComposableCoW, TWAP handler, GPv2Settlement, Multicall3 all return real bytecode.
- **AMM markers:** feasible later → `amm:false`. Uniswap V3 factory `0xcb2436774C3e191c85056d248EF4260ce5f27A9D` deployed (49072 bytes) → v3 `slot0()`; Curve live. Needs a curated `config/plasma/amm-catalog.json`, so not a drop-in boolean.
- **RPC:** default `https://rpc.plasma.to` — answered `eth_chainId`/`eth_call`/`eth_getCode` with no special headers; Multicall3 present. getLogs caps/archive depth not stress-tested (low-risk: `eth_call`@latest path). CoW `/plasma/api/v1/auction` → 403, but that is **global CoW gating** (mainnet `/auction` also 403), not Plasma-specific; the collector-critical `native_price` endpoint returns 200.
- **Token anchors (on-chain):** USDC `0x2d661c89d812261039af9764eceaaee884f5f67f` → USDC/**6** (native Circle, anchor); USDT0 `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` → USDT0/6; USDe `0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34` → USDe/18; WXPL `0x6100e367285b01f48d07953803a2d8dca5d19873` → WXPL/18 (wrapped-native, goes in `weth` per the non-ETH-chain convention — gnosis uses WXDAI, polygon WMATIC). CoW `native_price` for USDC returns 200.
- **EXPLORERS line:** `'plasma': ('plasma', 'https://plasmascan.to'),` — prefix `plasma` inferred (explorer probe 429'd; verify once).
- **Watch item:** confirm CoW has meaningful solver/order flow on Plasma post-deploy (`solver_competition/latest` returned 404/empty at check time) — affects how many dynamic base pairs the auction yields.

**Exact `config/networks.json` entry** (also append `"plasma"` to `order`):

```json
    "plasma": {
      "label": "Plasma",
      "slug": "plasma",
      "chain_id": 9745,
      "rpc_env": "RPC_PLASMA",
      "rpc_default": "https://rpc.plasma.to",
      "native_symbol": "XPL",
      "usdc": "0x2d661c89d812261039af9764eceaaee884f5f67f",
      "weth": "0x6100e367285b01f48d07953803a2d8dca5d19873",
      "eth_family": false,
      "amm": false,
      "stables": {
        "0x2d661c89d812261039af9764eceaaee884f5f67f": { "symbol": "USDC",  "decimals": 6 },
        "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": { "symbol": "USDT0", "decimals": 6 },
        "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": { "symbol": "USDe",  "decimals": 18 }
      }
    }
```

**discover_amm.py (if later `amm:true`):** `python discover_amm.py --book /tmp/plasma-book.json --output /tmp/plasma-amm.json --chain plasma --rpc https://rpc.plasma.to` (Uni-V3 slot0 + Curve; confirm DexScreener Plasma slug).

---

### 3.4 BNB Chain — NEEDS CODE (anchor-decimals blocker)

- **Verdict:** needs_code. Confidence: high. CoW book is live; the add is blocked on **one** invariant, not on CoW support.
- **Chain:** EVM, chainId 56 (`eth_chainId` → `0x38` on `bsc-rpc.publicnode.com` + `bsc-dataseed.bnbchain.org`). Native BNB.
- **CoW slug:** `bnb` (`/bnb/api/v1/version` → 200, v2.389.4; `binance`/`bsc` → 404).
- **TWAP overlay:** feasible, zero code. `eth_getCode`: ComposableCoW → `0x6080…595001b2…`; TWAP handler → `0x6080…01ffc9a7…`; GPv2Settlement + Multicall3 bytecode present.
- **AMM markers:** feasible (PancakeSwap v2 `getReserves` on `0x16b9…0daE` and v3 `slot0` on `0x172f…f849` both probed live) → still recommend `amm:false` for the initial add to match other chains.
- **RPC:** default `https://bsc-rpc.publicnode.com` (fallback `https://bsc-dataseed.bnbchain.org`), both chainId `0x38`. `bsc.drpc.org` rate-limits; `binance.llamarpc.com` returned empty. Default `batch_size` 180 is workable; drop to ~60–80 if the node rejects large pinned-block multicall payloads. Note: `api.cow.fi/bnb/api/v1/auction` returned **403 from this collector host's IP** (bot filter) even with a browser UA — confirm the production collector host is not similarly blocked (version + token endpoints were fine); add Accept/UA headers if needed.

**THE BLOCKER — no 6-decimal auction stable.** Every BSC USD stable in the live
book is **18-decimal** Binance-Peg: USDC `0x8ac76a51…cd580d` → decimals `0x12` (18,
re-verified live this session), USDT `0x55d398…197955` → 18, BUSD
`0xe9e7cea3…087d56` → 18, DAI `0x1af3f329…b1dbc3` → 18. The anchor must be
6-decimal (`allocator.py:41` assert + four `10**6` hardcodes). So BNB **cannot**
be added as a config drop-in — the draft entry below would fail the build the first
time `allocator.build_depth` runs.

**Two resolutions (owner decision, §5):**

1. **(Recommended) Generalize the anchor-decimals** — small, clean, benefits every
   future chain. Replace the hardcoded `10**6` with `10**meta[usdc]['decimals']`
   (or a per-config `usdc_decimals`) in the five sites: `allocator.py:41` (change
   the assert to read decimals, not require 6), `allocator.py:53`, `allocator.py:171`,
   `build.py:138`, `amm.py:177`, `twap_normalize.py:10`. Then BNB's 18-decimal USDC
   is a valid anchor and BNB becomes a normal drop-in. Add a regression test that an
   18-decimal anchor normalizes correctly. ~Half a day incl. tests.
2. **6-decimal anchor workaround** — point `usdc` at a genuine 6-decimal BSC stable
   (e.g. axlUSDC `0x4268B8F0B87b6Eae5d897996E6b845ddbD99Adf3`). Rejected as primary:
   low liquidity, may not be reliably priced in every auction → `build.py:73`
   `prices[usdc]>0` assert risk. No code change but fragile.

**Draft entry (valid ONLY after resolution 1; not paste-ready today):** append
`"bnb"` to `order`; USDC is the intended anchor but requires the generalization.

```json
    "bnb": {
      "label": "BNB Chain",
      "slug": "bnb",
      "chain_id": 56,
      "rpc_env": "RPC_BNB",
      "rpc_default": "https://bsc-rpc.publicnode.com",
      "native_symbol": "BNB",
      "usdc": "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      "weth": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      "eth_family": false,
      "amm": false,
      "stables": {
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { "symbol": "USDC", "decimals": 18 },
        "0x55d398326f99059ff775485246999027b3197955": { "symbol": "USDT", "decimals": 18 },
        "0xe9e7cea3dedca5984780bafc599bd69add087d56": { "symbol": "BUSD", "decimals": 18 },
        "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3": { "symbol": "DAI",  "decimals": 18 }
      }
    }
```

> USDT `0x55d3…` is the dominant BSC stable; USDC is Binance-Peg; BUSD is deprecated but still on-chain and priced. Anchor stays USDC for the 1:1 USD reference; USDT/BUSD/DAI are the quote-side stable set.

- **EXPLORERS line:** `'bnb': ('bnb', 'https://bscscan.com'),` — prefix `bnb` inferred (explorer probe 429'd; verify once).
- **discover_amm.py (if later `amm:true`):** `python discover_amm.py --book /tmp/bnb-book.json --output /tmp/bnb-amm.json --chain bsc --rpc https://bsc-rpc.publicnode.com` (DexScreener slug is `bsc`; Pancake v2 getReserves + v3 slot0).

---

## 4. Solana — NEEDS CODE (non-EVM). Depth-only MVP, owner go/no-go

Solana's CoW order book is live (`/solana/api/v1/version` → 200, v2.389.3;
candidate slugs `solana-mainnet`/`svm`/`sol` → 404 — only `solana`). But Solana is
**non-EVM**: no `eth_call`/`eth_getCode`/`eth_getLogs`/Multicall3; chain identity is
a genesis hash, not an integer chainId (so `chain_id: null`). This is a new
workstream, framed here as a decision for the owner — **not** auto-shipped.

### MVP scope: depth chart only

A depth-only Solana book is feasible because the reference price it needs is already
in the data: `GET /solana/api/v2/solver_competition/latest` → 200 with
`auction.prices` as a dict keyed by base58 mint (native-denominated, e.g.
`So111…112` → 1000000000; native-SOL sentinel `1111…1111`). Orders carry full
metadata: `GET /solana/api/v1/orders/{uid}` → flat object with base58
`sellToken`/`buyToken` SPL mints, atomic `sellAmount`/`buyAmount`, `kind`,
`partiallyFillable`, `fullAppData` + `orderClass` (the earlier "Solana orders lack
class/fullAppData" premise is **outdated** — appData shipped, cowswap PR #8467).

### New module(s) / code paths required

1. **`solana_meta.py` (new):** SPL symbol/decimals via Solana RPC — `getTokenSupply`
   (decimals; verified: USDC→6, wSOL→9, BONK→6) and DAS `getAsset` (name+symbol+decimals
   in one call; verified USDC → "USD Coin"/USDC/6). Public `api.mainnet-beta.solana.com`
   answered but is heavily rate-limited; prefer a keyed provider (Alchemy Solana —
   `ALCHEMY_API_KEY` is present this session — or Helius), with `getTokenSupply` as the
   minimal decimals-only fallback.
2. **`networks.py` — stop lowercasing base58.** Base58 is **case-sensitive**; the
   viewer's pervasive `address.lower()` (`source.py` member()/project(),
   `networks.stable_metadata` keys) would corrupt Solana mints. Gate on an
   `address_case_sensitive`/`evm:false` flag; also skip the `rpc_url`/`eth_getCode`
   EVM assumptions for this entry.
3. **`source.py` — Solana fetch path.** Use `v2/solver_competition/latest` only (v1
   is 404 on Solana) and fetch orders one-by-one via `GET /api/v1/orders/{uid}` —
   `by_uids` is unavailable (`POST /orders/by_uids` → 405, `GET` → 400). The viewer's
   128-uid batching becomes N single GETs under the shared 1-req/sec pacing; a ~50-order
   auction then dominates refresh latency → needs a dedicated higher-throughput
   strategy or a Solana-specific pacing lane.
4. **`networks.EXPLORERS` — a Solana (non-prefix) entry.** CoW explorer path prefix
   for Solana order links was not verified; confirm before wiring.

### Explicitly OUT OF SCOPE for the MVP

- **TWAP overlay** — impossible. ComposableCoW / TWAP handler are EVM contracts; no
  `eth_getCode` on Solana, no equivalent program discoverable by this machinery.
  `twap.py`/`twap_api.py`/`twap_normalize.py` must be disabled for this network
  (`twap:false`). A Solana-native recurring-order program, if CoW ever ships one, is
  separate PDA-based discovery — out of scope.
- **AMM markers** — EVM `amm.py` (Uniswap/Curve math, Multicall3 pool reads) cannot
  apply. `amm:false`. Future marker work (Raydium, Orca Whirlpools, Meteora DLMM) is
  net-new per-program account-layout code, not a toggle.
- **Funding model** — `funding.py` is eth_call + Multicall3 allowance/balance reads;
  no Solana equivalent. `funding:false` (depth from order amounts + auction prices only).

### Effort & shape

Medium — one new module (`solana_meta.py`) + a non-EVM branch in `source.py`/
`networks.py` + an EXPLORERS entry + the case-sensitivity bypass. No reuse of
funding/twap/amm. Call it a few days of focused work plus a keyed Solana RPC. Draft
entry carries `evm:false`, `chain_id:null`, `twap:false`, `funding:false`,
`amm:false`, `address_case_sensitive:true`, `competition_api_version:"v2"`.

### Solana open questions (owner)

- CoW explorer path prefix for Solana order links (unverified — needed for clickable links).
- Confirm no bulk/`by_uids` endpoint exists → N single GETs is the only path → dedicated pacing.
- Require a keyed provider (Alchemy/Helius) for DAS `getAsset`? Free public RPC is rate-limited.
- barn vs prod: `barn.api.cow.fi/solana` exists — confirm which the production viewer reads.
- Is `auction.prices` a sufficient anchor on illiquid SPL pairs, or add Jupiter/Pyth reference?

---

## 5. Implementation checklist (EVM drop-ins: Linea, Ink, Plasma)

Do all three in one PR. Per network:

1. **`config/networks.json`** — add the entry under `networks` (§3.1/3.2/3.3,
   paste-ready) **and** append the key to the top-level `order` array (e.g. after
   `"avalanche"`). This alone makes `service.Collectors` spawn a per-network
   `SnapshotCache`, `source.collect` hit `api.cow.fi/<slug>`, funding/twap resolve
   the RPC via `rpc_env`/`rpc_default`, and the manifest list it.
2. **`networks.py` EXPLORERS** — add one line:
   - `'linea':  ('linea',  'https://lineascan.build'),`
   - `'ink':    ('ink',    'https://explorer.inkonchain.com'),`
   - `'plasma': ('plasma', 'https://plasmascan.to'),`
   (Fallback builds the book without it but produces wrong links.)
3. **`config/<key>/amm-catalog.json`** — **skip** (all three launch `amm:false`;
   pairs show "AMM survey not configured", `build.py:159`). Add later via
   `discover_amm.py` (commands in each §3).
4. **Tests (optional but recommended — nothing in the suite iterates `ORDER`, so a
   new entry breaks nothing; these positively assert the new chains):**
   - `tests/test_multichain_state.py` — parametrize/duplicate the base-keyed cases
     (`test_empty_limit_population_reads_anchor_metadata` asserts anchor decimals==6;
     `test_base_twap_only_wrapped_and_native_assets_are_independent`;
     `test_snapshot_can_start_with_only_twap_markets`) for the new keys. These double
     as the guard that each anchor is genuinely 6-decimal.
   - `tests/test_multichain_service.py` —
     `test_books_and_refresh_requests_are_isolated_per_network`: extend the
     `Collectors(enabled=[…])` list + `(net,chain)` assertions to include the new keys.
   - `tests/test_network_ui.cjs` — add the chainIds (59144 / 57073 / 9745) to confirm
     `buildCowUrl` deep-link + network-switch races. Run: `node --test tests/test_network_ui.cjs`.
   - Full gate: `python -m unittest discover -s tests -v` plus
     `python -m unittest test_source test_funding -v` and the node `--test` JS checks.
5. **Deploy** — restart the collector (`networks.json` + `EXPLORERS` are read once at
   import): `./run-prod.sh` (detached, binds `127.0.0.1:${OB_PORT:-8137}`, logs to
   `/tmp/orderbook-viewer.log`; stop by killing the launcher PID it prints). Public
   reach via `cowswap.koeppelmann.dev` which proxies `/orderbook/*` → this port
   (`web/next.config.mjs`). First collection per network is staggered `index*8`s and
   takes a few minutes. Set `RPC_LINEA`/`RPC_INK`/`RPC_PLASMA` in the launcher env to
   override the bundled public default (add `RPC_<NET>_ARCHIVE` only if pruned-state
   fallback is wanted).
6. **Verify per network after deploy** — hit `<port>/<key>/orderbook.json` (or
   `.cache/public/<key>/orderbook.json`): confirm schema `cowpro_live_depth_v1`,
   matching `chain_id`, nonzero `pairs`. Confirm the key appears in
   `public/networks.json` manifest and the frontend network switcher. Open one CoW
   explorer order link in a browser to confirm the inferred path prefix.

**BNB** is the same checklist **after** the anchor-decimals generalization (§3.4
resolution 1) lands and its regression test passes.

---

## 6. Risks, open questions, owner decisions

**Owner decisions (blocking):**
- **BNB anchor-decimals:** approve the 6-decimal → configurable-decimals
  generalization (recommended, ~half a day, benefits all future chains) vs. the
  low-liquidity axlUSDC 6-decimal anchor workaround (fragile) vs. defer BNB. §3.4.
- **Solana go/no-go:** greenlight the depth-only MVP as a separate effort (new
  `solana_meta.py` + non-EVM branches, days of work, keyed Solana RPC), or defer. §4.

**Risks / open questions (non-blocking, verify at/after deploy):**
- **CoW explorer path prefixes** for `linea`/`ink`/`plasma`/`bnb`/solana are
  **inferred** from the API slug + SDK naming — every direct `explorer.cow.fi` probe
  returned HTTP 429 (rate-limited from this host). Open one order link per chain in a
  browser before relying on the EXPLORERS prefix. Fallback links still build.
- **BNB `/auction` 403** from this collector host's IP (bot filter) despite browser
  UA — confirm the production collector host is not similarly blocked; version + token
  endpoints were fine. Plasma `/auction` 403 is **global CoW gating** (mainnet also
  403), not chain-specific — safe to ignore, `native_price` works.
- **Linea getLogs caps:** if ComposableCoW ConditionalOrderCreated scans hit a
  block-range cap on the public RPC, set `RPC_LINEA` to a keyed endpoint and/or lower
  `batch_size`. Not load-tested against this repo's scanner.
- **Plasma order volume:** `solver_competition/latest` was 404/empty at check time —
  confirm CoW has live solver flow on Plasma so the dynamic auction-derived catalog
  yields real pairs; otherwise the book may render thin.
- **Public RPC batch limits:** if any node rejects large pinned-block multicalls, set
  `batch_size` (~60–80) in that network's entry (`funding.py:149` hook; no network
  overrides it today).
- **AMM markers deferred everywhere:** all new EVM chains launch `amm:false` and show
  "AMM survey not configured". Enabling needs curated catalogs; Linea (Algebra
  `globalState()`) and Ink (Uniswap V4 singleton) would need `amm.py` extensions
  beyond v2 `getReserves()`/v3 `slot0()`, so those two give only partial coverage even
  with a catalog — treat as a later design task, not part of this rollout.

---

## 7. Evidence index (commands run)

- CoW support: `curl -s -o /dev/null -w '%{http_code}' https://api.cow.fi/<slug>/api/v1/version` → 200 for bnb/linea/plasma/ink/solana (bodies v2.389.x).
- Chain id: `eth_chainId` → linea `0xe708`(59144), ink `0xdef1`(57073), plasma `0x2611`(9745), bnb `0x38`(56); solana has no integer chainId (genesis hash).
- TWAP deploy: `eth_getCode 0xfdafc9d1902f4e0b84f65f49f244b32b31013b74` (ComposableCoW) + `0x6cf1e9ca41f7611def408122793c358a3d11e5a5` (TWAP handler) → real bytecode on bnb/linea/plasma/ink (ink: 16958/9068 bytes). GPv2Settlement + Multicall3 bytecode present on each.
- Anchor decimals (live, this session): Linea USDC `0x1762…E1ff` `decimals()` → `0x06`; BNB USDC `0x8ac7…d580d` `decimals()` → `0x12` (18) — the BNB blocker. Ink/Plasma USDC verified 6 in profiles.
- Code invariant (this session): `allocator.py:41` `assert meta[usdc]['decimals'] == 6`; `10**6` at `allocator.py:53`, `allocator.py:171`, `build.py:138`, `amm.py:177`, `twap_normalize.py:10`; `build.py:73` `assert prices.get(usdc,0)>0`.
- Repo shape (this session): `config/networks.json` has `order`+`networks`; `networks.EXPLORERS` dict at `networks.py:20-28` with the 7 existing chains; only `config/base/` carries an amm-catalog among non-mainnet chains.
```
