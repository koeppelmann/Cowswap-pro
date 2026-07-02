#!/bin/bash
# Supervisor: keep the sDAI finalizer running, restarting it on any exit.
# Requires FINALIZER_PK in env (0x-private key of a funded Gnosis keeper).
#   FINALIZER_PK=0x... bash scripts/sdai-finalizer-run.sh
cd "$(dirname "$0")/.."
: "${FINALIZER_PK:?set FINALIZER_PK}"
export GNOSIS_RPC="${GNOSIS_RPC:-https://rpc.gnosischain.com}"
export APP_URL="${APP_URL:-http://localhost:3100}"
export POLL_MS="${POLL_MS:-30000}"
while true; do
  echo "[$(date -u +%FT%TZ)] starting finalizer"
  node scripts/sdai-finalizer.mjs
  echo "[$(date -u +%FT%TZ)] finalizer exited ($?); restarting in 5s"
  sleep 5
done
