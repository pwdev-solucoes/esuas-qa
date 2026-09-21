#!/usr/bin/env bash
# Sobe o stack E2E (API + Postgres + Redis + Mailpit) e builda os DOIS frontends
# servidos em `vite preview`: o admin (Super Admin) e o client (tenant).
#
# ADAPTADO PARA qa/ STANDALONE:
#   - Clona api/, admin/, client/ para qa/repos/ (feito por ../setup.sh)
#   - Docker compose aponta para qa/docker-compose.qa.yml (não meta-repo staging)
#   - Paths relativos usam qa/ como raiz (não meta-repo)
#
# Pré-requisitos:
#   - Docker em execução
#   - Node 22 e npm disponíveis no host
#   - qa/.env.qa (copiar de .env.qa.example e ajustar)
#   - qa/repos/api, qa/repos/admin, qa/repos/client já clonados (rodar ../setup.sh)
#
# O que faz:
#   1) Carrega .env.qa (não .env.e2e)
#   2) Gera api/.env a partir das vars de E2E (com as DUAS portas stateful)
#   3) Sobe docker-compose.qa.yml (não docker-compose-staging.yml) + docker-compose-e2e.yml
#   4) Aguarda /up da API e UI do Mailpit
#   5) Roda migrate:fresh --seed --seeder=E2ESeeder
#   6) Builda admin e client com VITE_API_URL apontando para a API
#   7) Smoke check anti-mock em CADA bundle
#   8) Sobe `vite preview` nas portas 4173 (admin) e 4174 (client)
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # qa/e2e
QA_DIR="$(cd "${E2E_DIR}/.." && pwd)"                       # qa/
API_DIR="${QA_DIR}/repos/api"
ADMIN_DIR="${QA_DIR}/repos/admin"
CLIENT_DIR="${QA_DIR}/repos/client"

ADMIN_PID_FILE=/tmp/esuas-e2e-preview.pid
CLIENT_PID_FILE=/tmp/esuas-e2e-preview-client.pid

cd "${E2E_DIR}"

# Load .env.qa (QA standalone, não .env.e2e do meta-repo)
if [ ! -f "${QA_DIR}/.env.qa" ]; then
  echo "✗ qa/.env.qa não encontrado. Copie de qa/.env.qa.example e ajuste." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "${QA_DIR}/.env.qa"
set +a

: "${E2E_BASE_URL:?E2E_BASE_URL não definido em qa/.env.qa}"
: "${E2E_API_URL:?E2E_API_URL não definido em qa/.env.qa}"
: "${E2E_API_BASE_URL:?E2E_API_BASE_URL não definido em qa/.env.qa}"
: "${E2E_ADMIN_CPF:?E2E_ADMIN_CPF não definido em qa/.env.qa}"
: "${E2E_ADMIN_PASSWORD:?E2E_ADMIN_PASSWORD não definido em qa/.env.qa}"

# O client do tenant é servido numa SEGUNDA porta. `CLIENT_BASE_URL` é o nome
# que os specs de tests/client/ leem (não invente outro): sem ele todos os
# casos do client ficam `skip`.
CLIENT_BASE_URL="${CLIENT_BASE_URL:-http://localhost:4174}"

# Porta derivada da própria URL — trocar a porta no .env.qa basta.
ADMIN_PORT="${E2E_BASE_URL##*:}"
ADMIN_PORT="${ADMIN_PORT%%/*}"
CLIENT_PORT="${CLIENT_BASE_URL##*:}"
CLIENT_PORT="${CLIENT_PORT%%/*}"

# Sanctum stateful: SEM a porta do client na lista, o login do tenant devolve 419.
STATEFUL_DOMAINS="localhost:${ADMIN_PORT},127.0.0.1:${ADMIN_PORT},localhost:${CLIENT_PORT},127.0.0.1:${CLIENT_PORT}"

echo "▶ Gerando api/.env para ambiente E2E..."
cp "${API_DIR}/.env.example" "${API_DIR}/.env"
# Sobrescreve vars sensíveis para o ambiente E2E.
{
  echo ""
  echo "# ── Overrides E2E (gerado por qa/e2e/scripts/start-stack.sh) ──"
  echo "APP_ENV=${APP_ENV:-e2e}"
  echo "APP_DEBUG=${APP_DEBUG:-false}"
  echo "APP_URL=${APP_URL:-http://localhost:8090}"
  echo "FRONTEND_URL=${FRONTEND_URL:-${E2E_BASE_URL}}"
  echo "FRONTEND_URL_CLIENT=${CLIENT_BASE_URL}"
  echo "DB_HOST=postgres"
  echo "DB_PORT=5432"
  echo "DB_DATABASE=${DB_DATABASE:-esuas_e2e}"
  echo "DB_USERNAME=${DB_USERNAME:-esuas}"
  echo "DB_PASSWORD=${DB_PASSWORD:-esuas_e2e_pwd}"
  echo "SANCTUM_STATEFUL_DOMAINS=${STATEFUL_DOMAINS}"
  echo "SESSION_DOMAIN=localhost"
  echo "SESSION_SAME_SITE=lax"
  echo "SESSION_SECURE_COOKIE=false"
  echo "MAIL_MAILER=smtp"
  echo "MAIL_HOST=mailpit"
  echo "MAIL_PORT=1025"
  echo "MAIL_FROM_ADDRESS=no-reply@esuas.e2e"
  echo "MAIL_FROM_NAME=\"eSUAS E2E\""
  echo "E2E_ADMIN_CPF=${E2E_ADMIN_CPF}"
  echo "E2E_ADMIN_PASSWORD=${E2E_ADMIN_PASSWORD}"
} >> "${API_DIR}/.env"

# Substitui valores que vieram do .env.example e que precisam mudar em E2E.
# (Append acima não sobrescreve linhas pré-existentes lidas antes pelo Laravel.)
sed -i.bak 's|^FILESYSTEM_DISK=.*|FILESYSTEM_DISK=public|' "${API_DIR}/.env"
rm -f "${API_DIR}/.env.bak"

cd "${QA_DIR}"

echo "▶ Subindo docker compose (qa + e2e override)..."
SANCTUM_STATEFUL_DOMAINS="${STATEFUL_DOMAINS}" \
FRONTEND_URL_CLIENT="${CLIENT_BASE_URL}" \
docker compose \
  -f docker-compose.qa.yml \
  -f e2e/docker-compose-e2e.yml \
  --env-file .env.qa \
  up -d --build

echo "▶ Aguardando API (${E2E_API_BASE_URL}/up)..."
"${E2E_DIR}/scripts/wait-for.sh" "${E2E_API_BASE_URL}/up" 120

echo "▶ Aguardando Mailpit (${E2E_MAILPIT_URL:-http://localhost:8025})..."
"${E2E_DIR}/scripts/wait-for.sh" "${E2E_MAILPIT_URL:-http://localhost:8025}" 30

echo "▶ Gerando APP_KEY (se necessário)..."
docker compose -f docker-compose.qa.yml exec -T app php artisan key:generate --force || true

echo "▶ Rodando migrate:fresh --seed --seeder=E2ESeeder..."
docker compose -f docker-compose.qa.yml exec -T app \
  php artisan migrate:fresh --seed --seeder=Database\\Seeders\\E2ESeeder --force

# ─────────────────────────────────────────────────────────────────────────────
# Build dos frontends
#
# ⚠️ O smoke anti-mock é a razão de este passo existir como função: com
# VITE_API_URL vazio os DOIS frontends ligam o modo mock e passam a autenticar
# qualquer CPF com qualquer senha. O E2E continuaria "verde" testando uma
# mentira. Duas provas, uma negativa e uma positiva:
#   - o bundle não pode referenciar o módulo de usuários mock;
#   - a URL da API precisa estar LITERALMENTE no bundle (o Vite substitui
#     `import.meta.env.VITE_API_URL` em tempo de build).
# ─────────────────────────────────────────────────────────────────────────────
build_frontend() {
  local dir="$1" label="$2" app_name="$3"

  echo "▶ Buildando ${label} (VITE_API_URL=${E2E_API_URL})..."
  (
    cd "${dir}"
    export HUSKY=0
    export VITE_API_URL="${E2E_API_URL}"
    export VITE_API_BASE_URL="${E2E_API_BASE_URL}"
    export VITE_APP_NAME="${app_name}"
    npm ci
    npm run build
  )

  echo "▶ Smoke check anti-mock do ${label}..."
  if grep -rq "from './data/mock-users'" "${dir}/dist" 2>/dev/null; then
    echo "✗ Build do ${label} contém referência a mock-users. VITE_API_URL provavelmente vazio." >&2
    exit 1
  fi

  if ! grep -rqF "${E2E_API_URL}" "${dir}/dist" 2>/dev/null; then
    echo "✗ Build do ${label} NÃO contém a URL da API (${E2E_API_URL}) — modo mock ligado." >&2
    exit 1
  fi
}

# Sobe um `vite preview` em background a partir do diretório do frontend.
start_preview() {
  local dir="$1" label="$2" port="$3" url="$4" pid_file="$5" log_file="$6"

  echo "▶ Subindo vite preview do ${label} em ${url}..."

  if [ -f "${pid_file}" ]; then
    OLD_PID=$(cat "${pid_file}")
    kill "${OLD_PID}" 2>/dev/null || true
    rm -f "${pid_file}"
  fi

  (
    cd "${dir}"
    nohup npx vite preview --port "${port}" --host 0.0.0.0 --strictPort > "${log_file}" 2>&1 &
    echo $! > "${pid_file}"
  )

  "${E2E_DIR}/scripts/wait-for.sh" "${url}" 30
}

build_frontend "${ADMIN_DIR}" "admin" "eSUAS Admin E2E"
build_frontend "${CLIENT_DIR}" "client" "eSUAS Client E2E"

start_preview "${ADMIN_DIR}" "admin" "${ADMIN_PORT}" "${E2E_BASE_URL}" \
  "${ADMIN_PID_FILE}" /tmp/esuas-e2e-preview.log
start_preview "${CLIENT_DIR}" "client" "${CLIENT_PORT}" "${CLIENT_BASE_URL}" \
  "${CLIENT_PID_FILE}" /tmp/esuas-e2e-preview-client.log

echo ""
echo "✓ Stack E2E pronto:"
echo "  - Frontend admin:  ${E2E_BASE_URL}"
echo "  - Frontend client: ${CLIENT_BASE_URL}"
echo "  - API:             ${E2E_API_BASE_URL}"
echo "  - Mailpit UI:      ${E2E_MAILPIT_URL:-http://localhost:8025}"
echo ""
echo "Para rodar os testes: cd qa/e2e && npx playwright test"
echo "Só o client:          cd qa/e2e && npx playwright test tests/client"
echo "Para derrubar:        cd qa/e2e && ./scripts/stop-stack.sh"
echo ""
