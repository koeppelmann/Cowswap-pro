# CoW Swap Pro order book

A standalone Ethereum limit-order depth chart and order book built from public
CoW APIs and on-chain reads. No solver credentials, wallet or signing key is
required. The browser uses bundled Plotly; no frontend build is needed.

## Run

Requires Python 3.10+ on Linux or macOS and an Ethereum mainnet HTTP RPC endpoint.
The RPC must support ordinary getters at recent auction blocks. An optional
archive RPC handles state that the primary endpoint has pruned.

```sh
cd orderbook-viewer
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
export RPC_ETH='YOUR_ETHEREUM_MAINNET_HTTP_RPC'
# Optional: export RPC_ETH_ARCHIVE='YOUR_ARCHIVE_HTTP_RPC'
python run.py
```

If your Python distribution lacks `venv`/`ensurepip`, `uv venv .venv` and
`uv pip install --python .venv/bin/python -r requirements.txt` are equivalent.

Open **http://127.0.0.1:8080/pro/?token=stusds**.
The first complete collection can take a few minutes. Later loads show cached
data immediately. Reload requests a shared refresh; the browser checks for a new
snapshot every five seconds. Concurrent requests coalesce, with a 60-second
cooldown and a five-minute periodic refresh. Upstream limits and failures retain
the last complete snapshot.

`Ctrl-C` stops both processes. Use `--bind`, `--port` and `--cache` to change the
listener or cache location. The default cache is `.cache/`. Only its `public/`
assets are served through aliases in `site/`; source responses and working files
are not exposed. RPC URLs stay in the collector's environment, never its command
arguments. Do not commit local environment files or caches.

## Reading the view

- Select an asset against all major stables or a single stable. Prices are
  USDC-equivalent; ETH forms are aggregated using pinned conversion rates.
- Funding uses same-block balances and allowances, allocated once per wallet and
  sell token within a view. This is a price-priority funding scenario, not a
  promise that every listed order can execute independently. Conditional hooks
  are excluded; unfunded orders are hidden by default.
- CoW reference prices are valuation inputs, not guaranteed executable quotes.
  In particular, vault NAV can differ from a liquidity-constrained market price.
- Gold AMM markers show a surveyed pool's mid and fee-adjusted bid/ask without
  adding AMM volume to order depth. Pool selection uses dated 24-hour discovery
  volume among supported, on-chain-verified pools. Prices and fees update at the
  book's pinned block. Curve markers use approximately $1 directional quotes and
  a geometric midpoint. Gas and transfer taxes are excluded. Survey timestamps,
  unsupported venues and fallback selection are exposed in the tooltips.
- TWAP overlays are vertical lines at their signed limit. The diamond marks
  remaining eligible scheduled volume; the crossbar marks one swap. Click the
  bar or select its schedule to see amounts, timing, funding and CoW Explorer
  links. USD heights value the quote amount at the limit, not current market
  notional; switch to asset units for token quantities. Future flow is separate
  from funded depth and has no Take action. Filled current slices, missed windows
  and cancelled parents are excluded from remaining volume.
- TWAP-only assets appear in the token selector and can default to a nonstable
  quote such as ETH. No CoW reference is invented for an unpriced asset.
- Select an order and choose **Take order** to prepare a normal opposite limit
  order in CoW Swap. It is not reserved for that seller. Both protocol-fee
  assumptions, the network allowance, buffer and extra overlap are editable;
  these allowances do not guarantee a fill. Review final fees and amounts in
  CoW Swap before signing.

The source accepts only orders whose signed app data verifies and declares the
limit class. It is a public auction snapshot, not a complete census of all orders
CoW may hold internally.

## Verify

```sh
python -m unittest discover -s tests -v
python -m unittest test_source test_funding -v
node --test take-tests/take-model.test.cjs terminal-tests/book-model.test.cjs
```

Node 18+ is needed only for the JavaScript checks. Tests use local fixtures and
mocks; they do not require an RPC endpoint or privileged API access.

## Configuration and files

`config/networks.json` defines every supported network (CoW API slug, chain id, RPC,
USD anchor and stablecoins). Mainnet additionally uses `config/mainnet/book.json`
(curated asset choices and static metadata) and `config/mainnet/catalog.json`
(stablecoins and ETH forms); other networks derive their bases from the live auction.
`amm-catalog.json` is a frozen pool survey (mainnet only). Refresh it into a new file,
review the coverage and package it as the next catalog:

```sh
python discover_amm.py --output /tmp/cowpro-amm-catalog-new.json
```

`twap.py` persists a public conditional-schedule index in `.cache/twap-index/`
and rechecks authorization, current child fills, balances and allowances at the
book's block. `twap_api.py` queries the public CoW programmatic-order index for
mainnet TWAP parents marked Active, caching the full candidate set for five minutes.
Raw parent parameters are hashed and verified before on-chain checks; API status
is not treated as proof of authorization or funding. Recent direct event discovery
also covers the latest 2,048 blocks and follows new events with a reorg overlap. Coverage is shown in the TWAP tooltip; it is not
an all-history or private-schedule census. A lag longer than 2,048 blocks is
recorded as a gap unless `TWAP_LOG_RPC` supplies matching-chain archived logs.
Use a dedicated archive/research endpoint for backfill. Merkle and custom-handler
schedules are not indexed. Zero wallet balance can still permit future or
just-in-time funding; it does not prove a schedule is cancelled.

`source.py` collects public API data, `funding.py` reads canonical funding state,
`allocator.py` builds the book, and `amm.py` adds pool markers. `cache.py` publishes
complete snapshots atomically. `service.py` runs collection; `http_server.py`
serves the dedicated public site and accepts same-origin refresh requests.

Canonical schedule and timing rules: [TWAP handler](https://github.com/cowprotocol/composable-cow/blob/2d43cabcfb8b5804d71b8e29a4a0cfbeb11f6322/src/types/twap/TWAP.sol), [child-order fields](https://github.com/cowprotocol/composable-cow/blob/2d43cabcfb8b5804d71b8e29a4a0cfbeb11f6322/src/types/twap/libraries/TWAPOrder.sol), and [window boundaries](https://github.com/cowprotocol/composable-cow/blob/2d43cabcfb8b5804d71b8e29a4a0cfbeb11f6322/src/types/twap/libraries/TWAPOrderMathLib.sol).

The token picker ranks by funded wallet value by default: buys use allocated
quote budgets normalized to USDC; sells use allocated base inventory at the CoW
reference price. This avoids treating extreme signed limits as available dollar
liquidity. TWAP counts remain separate. Search accepts token labels or addresses;
ranking can switch to order count, TWAP count or alphabetical order.

AMM coverage includes surveyed v2/v3, Curve, hookless static-fee Uniswap v4
(with directional protocol fees), and hook-free Balancer v3 weighted pools with
STANDARD tokens. V4 pool IDs must match the configured PoolKey hash. V4 inventory
is active virtual reserves, not total deposits. An unpriced base token can use
the verified pool spot for inventory valuation without inventing a CoW reference.
apyUSD quotes use same-block apxUSD/USDC pool spot normalization.

Verify all currently listed assets against a proposed catalog (configured `RPC_ETH`):

```sh
python audit_amm.py --snapshot .cache/public/orderbook.json --catalog amm-catalog.json --output /tmp/cowpro-amm-coverage.json
```

The audit writes the coverage report once, retains hashed RPC evidence, and exits
nonzero for missing markers. Candidate discovery is public; marker state and fees
are verified on our node at the snapshot block.
