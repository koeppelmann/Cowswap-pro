"""Per-network configuration for the multichain viewer (see config/networks.json).

mainnet keeps its rich static book/catalog under config/mainnet/ (ETH-family
aggregation, LST conversions, AMM markers). Every other CoW network derives its
tradeable bases from the live auction + on-chain metadata; only its USD-stablecoin
set and a 6-decimal USD anchor are curated in networks.json. The CoW settlement,
vault relayer and Multicall3 contracts share one address across all chains, so they
stay in funding.py rather than here."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
_DATA = json.loads((ROOT / 'config' / 'networks.json').read_bytes())
ORDER = _DATA['order']
NETWORKS = _DATA['networks']
DEFAULT = ORDER[0]

# CoW Explorer path prefix + block-explorer base per network (order/address/tx links).
EXPLORERS = {
    'mainnet': ('', 'https://etherscan.io'),
    'gnosis': ('gc', 'https://gnosisscan.io'),
    'arbitrum': ('arb1', 'https://arbiscan.io'),
    'base': ('base', 'https://basescan.org'),
    'polygon': ('pol', 'https://polygonscan.com'),
    'avalanche': ('avax', 'https://snowtrace.io'),
    'sepolia': ('sepolia', 'https://sepolia.etherscan.io'),
}


def get(network):
    if network not in NETWORKS:
        raise ValueError('unknown_network:' + str(network))
    return NETWORKS[network]


def config_dir(network):
    return ROOT / 'config' / network


def rpc_url(network, *, archive=False):
    """Resolve the RPC endpoint: an explicit per-network env var wins (RPC_ETH,
    RPC_GNOSIS, …; archive adds the _ARCHIVE suffix), else the bundled public node
    for the primary endpoint. No archive default — pruned-state fallback is opt-in."""
    cfg = get(network)
    name = cfg['rpc_env'] + ('_ARCHIVE' if archive else '')
    value = os.environ.get(name)
    if value:
        return value
    if archive:
        raise RuntimeError('configured_rpc_unavailable:' + name)
    default = cfg.get('rpc_default')
    if default:
        return default
    raise RuntimeError('configured_rpc_unavailable:' + name)


def stable_metadata(network):
    """{address(lower): {symbol, decimals}} of the curated USD stablecoins. For
    mainnet these come from the static catalog; other chains carry them inline."""
    cfg = get(network)
    if 'stables' in cfg:
        return {a.lower(): dict(v) for a, v in cfg['stables'].items()}
    catalog = json.loads((config_dir(network) / 'catalog.json').read_bytes())
    return {a.lower(): dict(catalog['tokens'][a]) for a in catalog['stable_tokens'] if a in catalog['tokens']}
