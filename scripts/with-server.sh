#!/usr/bin/env bash
# 启动服务器 → 等 /healthz → 执行传入命令 → 退出时关掉服务器。
set -euo pipefail
cd "$(dirname "$0")/.."
ADDR="${ADDR:-127.0.0.1:18080}"
mkdir -p .tmp
./bin/relay -addr "$ADDR" -log warn > .tmp/server.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do
  if curl -sf "http://$ADDR/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
RELAY_URL="${RELAY_URL:-http://$ADDR}" "$@"
