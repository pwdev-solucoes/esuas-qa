#!/usr/bin/env bash
# QA Repository Bootstrap Script
# Clona api/, admin/, client/ para qa/repos/, instala dependências e gera .env files
# Execução: ./setup.sh

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOS_DIR="${SCRIPT_DIR}/repos"
ENV_QA_FILE="${SCRIPT_DIR}/.env.qa"
ENV_QA_EXAMPLE="${SCRIPT_DIR}/.env.qa.example"

# Repo URLs
API_REPO="https://github.com/pwdev-solucoes/esuas-backend.git"
ADMIN_REPO="https://github.com/pwdev-solucoes/esuas-frontend-admin.git"
CLIENT_REPO="https://github.com/pwdev-solucoes/esuas-frontend-client.git"

# Functions
log_info() {
  echo -e "${GREEN}▶${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1" >&2
}

check_prerequisite() {
  local cmd=$1
  local name=$2
  if ! command -v "$cmd" &> /dev/null; then
    log_error "$name não encontrado. Instale e tente novamente."
    exit 1
  fi
}

# Validations
log_info "Validando pré-requisitos..."
check_prerequisite "git" "Git"
check_prerequisite "node" "Node.js"
check_prerequisite "npm" "npm"
check_prerequisite "composer" "Composer"
check_prerequisite "docker" "Docker"

# Check if Docker daemon is running
if ! docker info > /dev/null 2>&1; then
  log_error "Docker não está rodando. Inicie o Docker e tente novamente."
  exit 1
fi

log_info "Pré-requisitos OK ✓"

# Load or create .env.qa
if [ ! -f "$ENV_QA_FILE" ]; then
  if [ -f "$ENV_QA_EXAMPLE" ]; then
    log_info "Copiando ${ENV_QA_EXAMPLE} → ${ENV_QA_FILE}"
    cp "$ENV_QA_EXAMPLE" "$ENV_QA_FILE"
    log_warn "Edite ${ENV_QA_FILE} se necessário (credenciais, portas, etc)"
  else
    log_error "${ENV_QA_EXAMPLE} não encontrado!"
    exit 1
  fi
fi

# Load env vars
set -a
source "$ENV_QA_FILE"
set +a

# Validate required env vars
: "${REPOS_DIR:?REPOS_DIR não definido em .env.qa}"
: "${DB_HOST:?DB_HOST não definido}"
: "${DB_USERNAME:?DB_USERNAME não definido}"
: "${DB_PASSWORD:?DB_PASSWORD não definido}"
: "${E2E_ADMIN_CPF:?E2E_ADMIN_CPF não definido}"
: "${E2E_ADMIN_PASSWORD:?E2E_ADMIN_PASSWORD não definido}"

log_info "Configuração carregada de ${ENV_QA_FILE}"

# Clone repos if they don't exist
mkdir -p "$REPOS_DIR"

log_info "Clonando repositórios..."

if [ ! -d "$REPOS_DIR/api" ]; then
  log_info "Clonando api..."
  git clone --depth 1 "$API_REPO" "$REPOS_DIR/api"
else
  log_warn "Pasta api/ já existe, pulando clone"
fi

if [ ! -d "$REPOS_DIR/admin" ]; then
  log_info "Clonando admin..."
  git clone --depth 1 "$ADMIN_REPO" "$REPOS_DIR/admin"
else
  log_warn "Pasta admin/ já existe, pulando clone"
fi

if [ ! -d "$REPOS_DIR/client" ]; then
  log_info "Clonando client..."
  git clone --depth 1 "$CLIENT_REPO" "$REPOS_DIR/client"
else
  log_warn "Pasta client/ já existe, pulando clone"
fi

# Install dependencies
log_info "Instalando dependências..."

# API (Composer)
log_info "Instalando api/ (Composer)..."
cd "$REPOS_DIR/api"
composer install --no-interaction --no-scripts --prefer-dist
log_info "api/ OK"

# Admin (npm)
log_info "Instalando admin/ (npm)..."
cd "$REPOS_DIR/admin"
npm ci
log_info "admin/ OK"

# Client (npm)
log_info "Instalando client/ (npm)..."
cd "$REPOS_DIR/client"
npm ci
log_info "client/ OK"

# QA root (npm)
log_info "Instalando qa/ (npm)..."
cd "$SCRIPT_DIR"
npm ci
log_info "qa/ OK"

# Generate .env files for api/, admin/, client/
log_info "Gerando .env files..."

# api/.env
log_info "Gerando api/.env..."
cp "$REPOS_DIR/api/.env.example" "$REPOS_DIR/api/.env"
{
  echo ""
  echo "# ── QA Overrides (gerado por setup.sh) ──"
  echo "APP_ENV=e2e"
  echo "APP_DEBUG=false"
  echo "APP_URL=http://localhost:8090"
  echo "FRONTEND_URL=http://localhost:4173"
  echo "FRONTEND_URL_CLIENT=http://localhost:4174"
  echo "DB_HOST=${DB_HOST}"
  echo "DB_PORT=${DB_PORT:-5432}"
  echo "DB_DATABASE=${DB_DATABASE}"
  echo "DB_USERNAME=${DB_USERNAME}"
  echo "DB_PASSWORD=${DB_PASSWORD}"
  echo "REDIS_PASSWORD=${REDIS_PASSWORD:-null}"
  echo "SANCTUM_STATEFUL_DOMAINS=localhost:4173,127.0.0.1:4173,localhost:4174,127.0.0.1:4174"
  echo "SESSION_DOMAIN=localhost"
  echo "SESSION_SAME_SITE=lax"
  echo "SESSION_SECURE_COOKIE=false"
  echo "MAIL_MAILER=smtp"
  echo "MAIL_HOST=mailpit"
  echo "MAIL_PORT=1025"
  echo "MAIL_FROM_ADDRESS=no-reply@esuas.e2e"
  echo "MAIL_FROM_NAME=\"eSUAS QA\""
  echo "E2E_ADMIN_CPF=${E2E_ADMIN_CPF}"
  echo "E2E_ADMIN_PASSWORD=${E2E_ADMIN_PASSWORD}"
  echo "FILESYSTEM_DISK=public"
} >> "$REPOS_DIR/api/.env"

# Adjust FILESYSTEM_DISK if it was set to something else
sed -i.bak 's|^FILESYSTEM_DISK=.*|FILESYSTEM_DISK=public|' "$REPOS_DIR/api/.env"
rm -f "$REPOS_DIR/api/.env.bak"

# admin/.env
log_info "Gerando admin/.env..."
cat > "$REPOS_DIR/admin/.env" <<EOF
VITE_API_URL=http://localhost:8090/api
VITE_API_BASE_URL=http://localhost:8090
VITE_APP_NAME=eSUAS Admin QA
EOF

# client/.env
log_info "Gerando client/.env..."
cat > "$REPOS_DIR/client/.env" <<EOF
VITE_API_URL=http://localhost:8090/api
VITE_API_BASE_URL=http://localhost:8090
VITE_APP_NAME=eSUAS Client QA
EOF

# Final status
log_info "✓ Setup concluído com sucesso!"
echo ""
echo "Próximos passos:"
echo "  1. Revisar arquivos .env gerados (se necessário)"
echo "  2. Rodar './qa.sh' para executar todos os testes"
echo "     ou './e2e/scripts/start-stack.sh' para subir apenas o stack"
echo ""
echo "Diretórios criados:"
echo "  • ${REPOS_DIR}/api/"
echo "  • ${REPOS_DIR}/admin/"
echo "  • ${REPOS_DIR}/client/"
echo ""
