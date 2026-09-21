# qa/ — CLAUDE.md

Guia operacional para Claude Code ao trabalhar com testes QA do SigSUAS.

## O que está aqui

Repositório **Git próprio** (`pwdev-solucoes/esuas-qa`) contendo:

- **E2E com Playwright:** testes de ponta-a-ponta (admin + client)
- **Testes de aceitação:** baseados em critérios de aceite (AC)
- **Planos de teste:** matriz de cobertura, casos de teste
- **Documentação QA:** padrões, troubleshooting, convenções
- **Automação:** scripts de stack, relatórios, CI/CD

## Stack

| Ferramenta | Versão | Propósito |
|---|---|---|
| **Playwright** | ^1.45.0 | Framework E2E (Chromium, Firefox, WebKit) |
| **TypeScript** | ^5.4.0 | Type-safe tests |
| **Node.js** | ≥18 | Runtime |
| **Docker Compose** | 3.8+ | Isolamento de stack (CI) |

## Estrutura

```
qa/
├── e2e/                        # Testes E2E com Playwright
│   ├── tests/
│   │   ├── auth/               # Login, auth flows
│   │   ├── admin/              # Super Admin (tenants, lookups, rbac)
│   │   ├── client/             # Tenant (families, geo-panel, etc)
│   │   ├── shared/             # Testes compartilhados
│   │   ├── *.setup.ts          # Setup global + per-project
│   │   └── acceptance/         # Testes de aceitação (AC → spec)
│   ├── pages/                  # Page Object Model (high-level actions)
│   ├── fixtures/               # Auth, API client, test data
│   ├── helpers/                # Mailpit, CPF, upload, etc
│   ├── .auth/                  # Storage states (super-admin.json, tenant.json)
│   ├── scripts/                # start-stack.sh, stop-stack.sh, wait-for.sh
│   ├── playwright.config.ts    # Config principal (projects, reporters)
│   ├── global-setup.ts         # Global setup (E2ESeeder, seed data)
│   ├── docker-compose-e2e.yml  # Stack isolada (API + PG + Redis + Mailpit)
│   └── package.json
├── acceptance/                 # Testes de aceitação (em evolução)
│   ├── user-stories/           # Por domínio (families, social-units, etc)
│   └── matrix.md               # Matriz de cobertura AC
├── plans/                      # Planos de teste (em evolução)
│   ├── test-cases/             # Casos de teste manuais
│   └── coverage.md             # Roadmap de cobertura
├── docs/                       # Documentação QA
│   ├── writing-specs.md        # Como escrever E2E specs
│   ├── conventions.md          # Padrões de código
│   ├── troubleshooting.md      # Problemas comuns
│   └── contributing.md         # Guidelines para PRs
├── scripts/                    # Automação
│   ├── health-check.sh         # Diagnostico da stack
│   └── generate-report.sh      # Relatório de cobertura
├── reports/                    # Artefatos (gerados)
│   ├── playwright-report/      # HTML report
│   └── test-results/           # JUnit XML, traces
├── playwright.config.ts        # Config (delegado a e2e/)
├── package.json                # Dependências top-level
├── tsconfig.json               # TypeScript config
├── CLAUDE.md                   # Este arquivo
└── README.md                   # Documentação principal
```

## Rodando testes

### Pré-requisitos

```bash
npm ci
npm run install:browsers
cp .env.e2e.example .env.e2e
# Editar .env.e2e se necessário
```

### Stack de dev já rodando

```bash
# API em :8000, admin em :5173, client em :5174
npm run e2e:running
```

### Stack isolada (recomendado para CI)

```bash
npm run e2e:local      # up → test → down (tudo em um comando)

# Ou separado:
npm run stack:up
npm run test:e2e
npm run stack:down
```

### Executar specs específicas

```bash
# Apenas admin
npm run test:admin

# Apenas client
npm run test:client

# Apenas auth
npm run test:auth

# Um arquivo
npx playwright test tests/admin/tenants.spec.ts

# Com padrão
npx playwright test tests/admin --grep "tenant creation"
```

### Debug e UI

```bash
# UI interativa (inspeção visual)
npm run test:ui

# Debug no terminal
npm run test:debug tests/auth/login.spec.ts

# Headed (vê o browser)
npm run test:headed
```

## Escrevendo specs

### Receita: AC → Spec

1. Leia o critério de aceite (CA) da user story
2. Nomeie o spec como `CA##.ts` ou `CAnn-descricao-curta.spec.ts`
3. Use o molde abaixo:

```typescript
import { test, expect } from '@playwright/test';

test.describe('CA## — Descrição longa do critério', () => {
  test('cenário 1: happy path', async ({ page, request }) => {
    // Arrange (setup via fixtures/API)
    // Act (interação via page)
    // Assert (verificações)
  });

  test('cenário 2: edge case', async ({ page }) => {
    // ...
  });
});
```

### Page Object Model

```typescript
// pages/admin/TenantsPage.ts
export class TenantsPage {
  constructor(private page: Page) {}

  async createTenant(name: string, plan: string) {
    await this.page.click('[data-testid="btn-create-tenant"]');
    await this.page.fill('[data-testid="input-name"]', name);
    await this.page.selectOption('[data-testid="select-plan"]', plan);
    await this.page.click('[data-testid="btn-confirm"]');
    await this.page.waitForLoadState('networkidle');
  }

  async verifyTenantExists(name: string) {
    await expect(this.page.locator(`text="${name}"`)).toBeVisible();
  }
}
```

### Fixtures (dados de teste)

```typescript
// fixtures/test-data.ts
export const testTenant = {
  name: 'Município Teste ${Date.now()}',
  document: '12345678000190',
  responsableEmail: 'admin@test.local',
};

export const testUser = {
  cpf: '44983702016',
  password: 'senha123',
  name: 'Usuário Teste',
};
```

### Autenticação

```typescript
// Super Admin — via global-setup, page já autenticado
test('gerenciar tenants', async ({ page }) => {
  await page.goto('/app/tenants');
  // Já logado como E2E_ADMIN_CPF
});

// Tenant — via chromium-tenant project
test('ver prontuário', async ({ page }) => {
  await page.goto('/app/families');
  // Já logado como E2E_CLIENT_OPERADOR_CPF
});

// Resetar sessão (outro usuário)
test('como master (sem lotação)', async ({ page, loginAsTenantUser }) => {
  await loginAsTenantUser(E2E_CLIENT_MASTER_CPF);
  // ...
});
```

## Convenções

- **Seletores:** `[data-testid="..."]` (nunca seletores CSS genéricos)
- **Nomes de teste:** descritivos, sem siglas ("Criar tenant com sucesso", não "CT-001")
- **Fixtures:** data-driven, reutilizáveis, com sufixo único (timestamp)
- **Imports:** nunca importar código do `api/`, `admin/`, `client/` — trate como cliente HTTP
- **Async/await:** sempre; evite `.then()`
- **Esperas:** `waitForLoadState('networkidle')` para navegação; `expect` para assertions

## CI/CD

Workflow `.github/workflows/e2e.yml` do meta-repo roda em PRs que tocam:
- `api/`
- `admin/`
- `client/`
- `qa/`

**Secrets necessários** (GitHub → Settings → Secrets):
- `GH_SUBMODULES_PAT` — PAT para clonar submódulos privados
- `E2E_ADMIN_CPF` — CPF do super-admin
- `E2E_ADMIN_PASSWORD` — Senha super-admin
- `E2E_CLIENT_OPERADOR_CPF` — CPF do operador do tenant
- `E2E_CLIENT_MASTER_CPF` — CPF do master do tenant

## Troubleshooting

### Stack conectando em testes

```bash
# Verificar se API está no ar
curl -s http://localhost:8000/health | jq

# Ver logs da API
cd ../api && ./vendor/bin/sail logs

# Resetar banco (destrutivo!)
cd ../api && ./vendor/bin/sail artisan migrate:fresh --seed
```

### Timeouts ou falhas de navegação

Aumentar timeout em `playwright.config.ts`:
```typescript
use: {
  navigationTimeout: 20_000,  // de 15s para 20s
  actionTimeout: 15_000,       // de 10s para 15s
}
```

### Testes passam localmente, falham no CI

Verificar:
1. `.env.e2e` tem as credenciais corretas?
2. Secrets do GitHub estão configurados?
3. Stack está rodando? (logs do workflow)
4. Browser instalado? (`npm run install:browsers`)

### Storage state expirado

```bash
rm .auth/super-admin.json .auth/tenant.json
npm run test  # recria automaticamente
```

## Skills de QA/Evidências

Este repositório `qa/` inclui um conjunto completo de skills para o ciclo de evidências de teste:

### Testes E2E

- **`e2e-testing`** — Transforma Critérios de Aceite (CA) em specs Playwright committed em `e2e/`.
  Receita completa: CA → spec (AAA pattern), Page Object Model, fixtures.
  Path: `./.claude/skills/e2e-testing/SKILL.md`

- **`playwright-cli`** — Automação de browser Playwright para debug interativo com `playwright-cli attach`.
  Path: `./.claude/skills/playwright-cli/SKILL.md`

### Geração & Validação de Evidências

- **`acceptance-evidence-report`** — Gera dossiê HTML+PDF de evidências dirigindo o app real (Playwright + Pest).
  Consome specs de `e2e-testing` via `CAPTURE_EVIDENCE=1`.
  Path: `./.claude/skills/acceptance-evidence-report/SKILL.md`

- **`glpi-evidence-validation`** — Fecha o ciclo: busca ticket no GLPI, compara dossiê × CAs, anexa PDF e pede validação do PO.
  Depende de: `acceptance-evidence-report` (gera dossiê quando ausente) + plugin `pwdev-glpi:glpi` (MCP GLPI).
  Path: `./.claude/skills/glpi-evidence-validation/SKILL.md`

### Pré-requisitos para usar `glpi-evidence-validation`

- **Plugin `pwdev-glpi:glpi`** deve estar instalado e configurado no seu ambiente Claude Code
  (fornece as tools MCP: get_ticket, upload_document, link_document, request_ticket_validation, search_users).
  
- Arquivo de contexto GLPI: `./.claude/pwdev-glpi-context.md` (convenções de IDs de entidade, mecânica de anexação).

### Índice de skills

Ver `./.claude/SKILLS.md` para o índice completo das skills deste repositório e seu fluxo de relacionamento.

## Comandos úteis

```bash
# Listar todos os testes
npx playwright test --list

# Rodar um teste específico
npx playwright test tests/auth/login.spec.ts:15

# Modo headed (vê o browser)
npm run test:headed

# Gerar HTML report
npm run test:report

# Limpar artefatos
rm -rf test-results playwright-report .auth
```

## Referências

- [Playwright Docs](https://playwright.dev)
- [E2E Testing Best Practices](./docs/conventions.md)
- [Troubleshooting Guide](./docs/troubleshooting.md)
- [`../../CLAUDE.md`](../../CLAUDE.md) — Meta-repo instructions
