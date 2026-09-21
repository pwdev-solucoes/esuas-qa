#!/usr/bin/env bash
# Derruba o stack E2E: os DOIS vite preview (admin + client) + docker compose.
#
# ADAPTADO PARA qa/ STANDALONE:
#   - Carrega qa/.env.qa (não e2e/.env.e2e)
#   - Docker compose aponta para qa/docker-compose.qa.yml (não meta-repo staging)
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # qa/e2e
QA_DIR="$(cd "${E2E_DIR}/.." && pwd)"                       # qa/

if [ -f "${QA_DIR}/.env.qa" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${QA_DIR}/.env.qa"
  set +a
fi

ADMIN_PORT="${E2E_BASE_URL:-http://localhost:4173}"
ADMIN_PORT="${ADMIN_PORT##*:}"
ADMIN_PORT="${ADMIN_PORT%%/*}"
CLIENT_PORT="${CLIENT_BASE_URL:-http://localhost:4174}"
CLIENT_PORT="${CLIENT_PORT##*:}"
CLIENT_PORT="${CLIENT_PORT%%/*}"

# Mata pelo pid registrado e, em seguida, por quem ainda estiver ESCUTANDO a
# porta: preview órfão (pid file perdido) deixaria a porta presa e o
# `stack:up` seguinte falharia no --strictPort.
stop_preview() {
  local label="$1" pid_file="$2" port="$3"

  echo "▶ Parando vite preview do ${label} (porta ${port})..."

  if [ -f "${pid_file}" ]; then
    PID=$(cat "${pid_file}")
    kill "${PID}" 2>/dev/null || true
    rm -f "${pid_file}"
  fi

  if command -v lsof >/dev/null 2>&1; then
    LEFTOVER=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "${LEFTOVER}" ]; then
      echo "${LEFTOVER}" | xargs kill 2>/dev/null || true
    fi
  fi
}

stop_preview "admin" /tmp/esuas-e2e-preview.pid "${ADMIN_PORT}"
stop_preview "client" /tmp/esuas-e2e-preview-client.pid "${CLIENT_PORT}"

echo "▶ Derrubando docker compose..."
cd "${QA_DIR}"
docker compose \
  -f docker-compose.qa.yml \
  -f e2e/docker-compose-e2e.yml \
  --env-file .env.qa \
  down --remove-orphans

echo "✓ Stack E2E parado."
