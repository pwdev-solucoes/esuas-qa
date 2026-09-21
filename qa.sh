#!/usr/bin/env bash
# QA Orchestration Script
# Roda Pest (api) + Vitest (admin, client) + Playwright E2E
# Execução: ./qa.sh [--no-e2e] [--no-unit] [--no-cleanup]

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOS_DIR="${SCRIPT_DIR}/repos"
RESULTS_DIR="${SCRIPT_DIR}/qa-results"
ENV_QA_FILE="${SCRIPT_DIR}/.env.qa"

# Options
RUN_UNIT=true
RUN_E2E=true
CLEANUP=true

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-e2e) RUN_E2E=false; shift ;;
    --no-unit) RUN_UNIT=false; shift ;;
    --no-cleanup) CLEANUP=false; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Functions
log_phase() {
  echo ""
  echo -e "${BLUE}════════════════════════════════════════${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}════════════════════════════════════════${NC}"
  echo ""
}

log_info() {
  echo -e "${GREEN}▶${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1"
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

# Check prerequisites
if [ ! -d "$REPOS_DIR" ]; then
  log_error "Pasta $REPOS_DIR não encontrada. Execute './setup.sh' primeiro."
  exit 1
fi

if [ ! -f "$ENV_QA_FILE" ]; then
  log_error "Arquivo $ENV_QA_FILE não encontrado. Execute './setup.sh' primeiro."
  exit 1
fi

# Load env
set -a
source "$ENV_QA_FILE"
set +a

# Create results directory
mkdir -p "$RESULTS_DIR"

# Track exit code
EXIT_CODE=0

# Phase 1: Unit Tests
if [ "$RUN_UNIT" = true ]; then
  log_phase "FASE 1: Testes Unitários (Pest + Vitest)"

  # Pest (API)
  log_info "Rodando Pest (api)..."
  cd "$REPOS_DIR/api"
  if composer test > "$RESULTS_DIR/pest-report.txt" 2>&1; then
    log_success "Pest passou"
  else
    log_error "Pest falhou"
    EXIT_CODE=1
  fi

  # Vitest (Admin)
  log_info "Rodando Vitest (admin)..."
  cd "$REPOS_DIR/admin"
  if npm run test:coverage > "$RESULTS_DIR/vitest-admin.txt" 2>&1; then
    log_success "Vitest (admin) passou"
    if [ -d "coverage" ]; then
      cp -r coverage "$RESULTS_DIR/vitest-admin-coverage"
    fi
  else
    log_error "Vitest (admin) falhou"
    EXIT_CODE=1
  fi

  # Vitest (Client)
  log_info "Rodando Vitest (client)..."
  cd "$REPOS_DIR/client"
  if npm run test:coverage > "$RESULTS_DIR/vitest-client.txt" 2>&1; then
    log_success "Vitest (client) passou"
    if [ -d "coverage" ]; then
      cp -r coverage "$RESULTS_DIR/vitest-client-coverage"
    fi
  else
    log_error "Vitest (client) falhou"
    EXIT_CODE=1
  fi

  echo ""
fi

# Phase 2: E2E Stack & Tests
if [ "$RUN_E2E" = true ]; then
  log_phase "FASE 2: Stack E2E + Testes Playwright"

  E2E_DIR="${SCRIPT_DIR}/e2e"

  if [ ! -d "$E2E_DIR" ]; then
    log_error "Pasta $E2E_DIR não encontrada"
    EXIT_CODE=1
  else
    cd "$E2E_DIR"

    # Start stack
    log_info "Subindo stack E2E..."
    if bash scripts/start-stack.sh > "$RESULTS_DIR/stack-startup.log" 2>&1; then
      log_success "Stack iniciado"

      # Run Playwright
      log_info "Rodando Playwright..."
      if npx playwright test --reporter=html,junit > "$RESULTS_DIR/playwright.log" 2>&1; then
        log_success "Playwright passou"
        if [ -d "playwright-report" ]; then
          cp -r playwright-report "$RESULTS_DIR/"
        fi
        if [ -d "test-results" ]; then
          cp -r test-results "$RESULTS_DIR/"
        fi
      else
        log_error "Playwright falhou"
        EXIT_CODE=1
      fi

      # Stop stack (always, mesmo se testes falharem)
      log_info "Limpando stack..."
      if bash scripts/stop-stack.sh >> "$RESULTS_DIR/stack-shutdown.log" 2>&1; then
        log_success "Stack parado"
      else
        log_warn "Erro ao parar stack (pode estar em estado inconsistente)"
      fi
    else
      log_error "Stack não foi iniciado"
      EXIT_CODE=1
    fi
  fi

  echo ""
fi

# Phase 3: Report Aggregation
log_phase "FASE 3: Relatórios"

log_info "Consolidando relatórios em $RESULTS_DIR"

# Create summary
cat > "$RESULTS_DIR/SUMMARY.md" <<EOF
# QA Test Results

Generated: $(date)

## Unit Tests

### Pest (api)
\`\`\`
$(tail -20 "$RESULTS_DIR/pest-report.txt" 2>/dev/null || echo "N/A")
\`\`\`

### Vitest (admin)
\`\`\`
$(tail -10 "$RESULTS_DIR/vitest-admin.txt" 2>/dev/null || echo "N/A")
\`\`\`

### Vitest (client)
\`\`\`
$(tail -10 "$RESULTS_DIR/vitest-client.txt" 2>/dev/null || echo "N/A")
\`\`\`

## E2E Tests (Playwright)

See \`playwright-report/index.html\` for full HTML report.

## Coverage

- Admin: \`vitest-admin-coverage/\`
- Client: \`vitest-client-coverage/\`

## Artifacts

- \`pest-report.txt\` — Pest output
- \`vitest-*.txt\` — Vitest output
- \`playwright-report/\` — HTML report
- \`test-results/\` — JUnit XML results
- \`vitest-*-coverage/\` — Coverage reports
- \`stack-*.log\` — Stack startup/shutdown logs
EOF

log_success "Relatório consolidado em $RESULTS_DIR/SUMMARY.md"

# Final status
echo ""
log_phase "RESULTADO FINAL"

if [ $EXIT_CODE -eq 0 ]; then
  log_success "✓ Todos os testes passaram!"
else
  log_error "✗ Alguns testes falharam (exit code: $EXIT_CODE)"
fi

echo ""
echo "Resultados completos: $RESULTS_DIR"
echo "  • SUMMARY.md — resumo executivo"
echo "  • playwright-report/ — relatório HTML E2E"
echo "  • vitest-*-coverage/ — cobertura de código"
echo ""

exit $EXIT_CODE
