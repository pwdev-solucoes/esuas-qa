#!/usr/bin/env bash
# Polling HTTP até o endpoint retornar 2xx ou timeout.
#
# Uso: wait-for.sh <url> [timeout_segundos]
#   wait-for.sh http://localhost:8080/up 60
set -euo pipefail

URL="${1:?Uso: wait-for.sh <url> [timeout_segundos]}"
TIMEOUT="${2:-60}"
INTERVAL=2
ELAPSED=0

echo "Aguardando ${URL} (timeout ${TIMEOUT}s)..."

while [ "${ELAPSED}" -lt "${TIMEOUT}" ]; do
  if curl -fsS --max-time 3 -o /dev/null "${URL}" 2>/dev/null; then
    echo "✓ ${URL} respondeu em ${ELAPSED}s"
    exit 0
  fi
  sleep "${INTERVAL}"
  ELAPSED=$((ELAPSED + INTERVAL))
  printf "."
done

echo ""
echo "✗ Timeout aguardando ${URL} após ${TIMEOUT}s" >&2
exit 1
