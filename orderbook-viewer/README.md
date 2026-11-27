# dfusion order-book viewer

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

Open **http://127.0.0.1:8080/dfusion-limit-depth-live/?token=stusds**.
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

`config-book.json` defines asset choices and static metadata;
`config-catalog.json` defines stablecoins and ETH forms. `amm-catalog.json` is a
frozen pool survey. Refresh it into a new file, review the coverage and package it
as the next catalog:

```sh
python discover_amm.py --output /tmp/dfusion-amm-catalog-new.json
```

`source.py` collects public API data, `funding.py` reads canonical funding state,
`allocator.py` builds the book, and `amm.py` adds pool markers. `cache.py` publishes
complete snapshots atomically. `service.py` runs collection; `http_server.py`
serves the dedicated public site and accepts same-origin refresh requests.
