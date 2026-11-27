#!/usr/bin/env bash
# Launch the order-book depth viewer for production, detached, on a loopback port.
# cowswap.koeppelmann.dev proxies /orderbook/* -> this port (see web/next.config.mjs:
# rewrites(); override with ORDERBOOK_UPSTREAM at the Next *build*). The viewer binds
# 127.0.0.1 only; nothing public reaches it except the Next proxy.
#
# Usage: ./run-prod.sh   (from this directory)
# Stop:  pkill -f "run.py --bind 127.0.0.1 --port ${OB_PORT:-8137}"
set -euo pipefail
cd "$(dirname "$0")"

OB_PORT="${OB_PORT:-8137}"
# Public RPC is fine here: the collector only needs ordinary getters at recent
# auction blocks (no archive state). Swap in a dedicated endpoint via RPC_ETH.
export RPC_ETH="${RPC_ETH:-https://ethereum-rpc.publicnode.com}"
# Lets the same-origin refresh POST succeed behind TLS-terminating path-proxying
# (the browser's Origin is the public https host, not our loopback Host).
export VIEWER_PUBLIC_ORIGIN="${VIEWER_PUBLIC_ORIGIN:-https://cowswap.koeppelmann.dev}"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

if ss -ltn 2>/dev/null | grep -q "127.0.0.1:${OB_PORT} "; then
  echo "port ${OB_PORT} already in use — is the viewer already running?" >&2
  exit 1
fi

LOG="${OB_LOG:-/tmp/orderbook-viewer.log}"
setsid .venv/bin/python run.py --bind 127.0.0.1 --port "${OB_PORT}" > "${LOG}" 2>&1 < /dev/null &
echo "order-book viewer launched on 127.0.0.1:${OB_PORT} (log: ${LOG})"
