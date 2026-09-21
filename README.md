# SigSUAS QA Repository

Repositório centralizado de **Quality Assurance** para SigSUAS — testes E2E, testes de aceitação, planos de teste e automação QA.

## 📋 O que está aqui

| Pasta | Propósito |
|---|---|
| **`e2e/`** | Testes de ponta-a-ponta com Playwright (admin, client, auth, rbac, etc) |
| **`acceptance/`** | Testes de aceitação baseados em critérios de aceite (user stories) |
| **`plans/`** | Planos de teste, matriz de cobertura, casos de teste manuais |
| **`docs/`** | Documentação QA — padrões, convenções, troubleshooting |
| **`scripts/`** | Automação — levantamento/teardown da stack, relatórios |
| **`reports/`** | Artefatos de teste (HTML reports, traces, videos) |

## 🚀 Quick Start

### Pré-requisitos

- Node.js ≥ 18
- Docker & Docker Compose (para stack de testes isolada)
- Git

### Setup

```bash
# Instalar dependências
npm ci

# Instalar browsers do Playwright
npm run install:browsers

# Copiar .env.e2e
cp .env.e2e.example .env.e2e
```

### Rodar testes

```bash
# Contra stack já no ar (dev local)
npm run e2e:running

# Stack isolada (CI-like)
npm run e2e:local

# Apenas admin
npm run test:admin

# Apenas client
npm run test:client

# UI interativa
npm run test:ui

# Debug mode
npm run test:debug
```

## 🧠 Skills de Claude Code

Este repositório inclui **skills de Claude Code** para o ciclo completo de evidências:

- **`e2e-testing`** — Transforma Critérios de Aceite em specs Playwright
- **`acceptance-evidence-report`** — Gera dossiê HTML+PDF de evidências (consome specs E2E)
- **`glpi-evidence-validation`** — Valida evidências no GLPI e pede validação do PO (depende de `acceptance-evidence-report`)
- **`playwright-cli`** — Debug interativo e testes de browser

Ver `./.claude/SKILLS.md` para o índice completo, fluxo e dependências.

## 📚 Estrutura de testes E2E

### E2E — Admin (Super Admin)

Testes da aplicação Super Admin (`admin/`), acessada em `:4173`:

```
e2e/tests/
├── auth/              # Login, logout, token refresh
├── admin/             # Gestão de tenants, lookups SUAS, usuários globais
├── rbac/              # Roles e permissions (Spatie)
├── lookups/           # Tabelas de referência
├── geo/               # Geography, territories, geo-layers
└── shared/            # Testes compartilhados entre admin e client
```

**Rodando apenas admin:**
```bash
npm run test:admin
# Ou específico: npx playwright test tests/admin/tenants.spec.ts
```

### E2E — Client (Tenant)

Testes da aplicação Tenant (`client/`), acessada em `:4174`:

```
e2e/tests/client/
├── auth/              # Login multi-tenant, select-tenant
├── families/          # Prontuário, importação CadÚnico
├── social-units/      # CRAS/CREAS
├── geo-panel/         # Painel georreferenciado
└── settings/          # Configurações do tenant
```

**Rodando apenas client:**
```bash
npm run test:client
# Ou: npx playwright test tests/client/families/family-intake.spec.ts
```

## 🏗️ Arquitetura de dados

### Setup global

Executado uma vez por run, antes de todos os specs:

- **`global-setup.ts`** → executa `E2ESeeder` via API Pest
- Cria super-admin determinístico + tenant de teste + usuario operador
- Popula lookups SUAS, roles, locations, etc
- Salva credenciais em `fixtures/env.ts`

### Por spec

Fixtures são recicladas por spec:

```typescript
// Criar dados únicos no beforeAll
test.describe('Tenant management', () => {
  let tenantId: number;
  
  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/manager/tenants', {
      data: { name: `Tenant ${Date.now()}` }
    });
    tenantId = res.json().id;
  });
  
  test('criar tenant com sucesso', async ({ page }) => {
    // ...
  });
  
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/manager/tenants/${tenantId}`);
  });
});
```

## 🔐 Autenticação

### Super Admin (project `chromium`)

Autenticação automática via `global-setup.ts`:

- Acesso via `page` já logado
- Storage state em `.auth/super-admin.json`
- CPF/senha em variáveis de ambiente (`E2E_ADMIN_CPF`, `E2E_ADMIN_PASSWORD`)

### Tenant User (project `chromium-tenant`)

Autenticação como operador do tenant:

```typescript
// Apenas leitura — page vem já logada como E2E_CLIENT_OPERADOR_CPF
test('ver prontuário', async ({ page }) => {
  await page.goto('/app/families');
  // ...
});

// Para outro usuário, resetar sessão
test('como master (sem lotação)', async ({ page, loginAsTenantUser }) => {
  await loginAsTenantUser(E2E_CLIENT_MASTER_CPF);
  // ...
});
```

## 📝 Page Object Model (POM)

Pages expõem ações de alto nível, não seletores brutos:

```typescript
// pages/admin/TenantsPage.ts
export class TenantsPage {
  async createTenant(name: string) {
    await this.page.click('[data-testid="btn-create-tenant"]');
    await this.page.fill('[data-testid="input-tenant-name"]', name);
    await this.page.click('[data-testid="btn-submit"]');
  }
}

// Uso no spec
test('criar tenant', async ({ page }) => {
  const tenants = new TenantsPage(page);
  await tenants.createTenant('Município X');
});
```

**Convenção:** Seletores via `data-testid` (lidos do `.vue`), nunca inventados.

## 🎬 Screenshot, Video, Trace

Artifacts do Playwright:

| Artefato | Quando | Local |
|---|---|---|
| Screenshot | Falha | `test-results/` |
| Video | Falha | `test-results/` |
| Trace | Falha | `playwright-report/` |

Visualizar:
```bash
npm run test:report
```

## 🐛 Troubleshooting

### Testes caindo vs stack de dev

Se a stack já está rodando e testes falham:

1. Verifique se o banco foi resetado:
   ```bash
   cd ../api && ./vendor/bin/sail artisan migrate:fresh --seed
   ```

2. Mailpit necessário para reset de senha:
   ```bash
   curl http://localhost:8025  # deve retornar página do Mailpit
   ```

3. Admin/Client rodando em `:5173`/`:5174` (modo dev, não preview):
   ```bash
   # Em 5173
   cd ../admin && npm run dev
   # Em 5174
   cd ../client && npm run dev
   ```

### Testes paralelos ou race conditions

Desative paralelismo se encontrar condições de corrida (já é `fullyParallel: false`). Se specs dependem um do outro, use:

```typescript
test.describe.configure({ mode: 'serial' });
```

### Debug interativo

```bash
npm run test:debug -- tests/auth/login.spec.ts
# Abre dev tools do Playwright — pause, step, inspect
```

## ✍️ Escrever um novo spec

Ver [`docs/writing-specs.md`](./docs/writing-specs.md) para:

- Receita CA → spec
- Convenção de título
- Moldes de spec
- Gotchas do harness

## 🔄 CI/CD

Workflow em `.github/workflows/e2e.yml` do meta-repo roda em PRs que tocam `api/`, `admin/`, `client/` ou `qa/`.

**Secrets necessários** (GitHub → Settings → Secrets):

| Secret | Para | Como gerar |
|---|---|---|
| `GH_SUBMODULES_PAT` | Clonar submódulos | GitHub → Developer settings → Personal access tokens (read-only) |
| `E2E_ADMIN_CPF` | Super-admin do tests | Sem máscara, só dígitos |
| `E2E_ADMIN_PASSWORD` | Senha super-admin | Idem |
| `E2E_CLIENT_OPERADOR_CPF` | Operador do tenant | Idem |
| `E2E_CLIENT_MASTER_CPF` | Master do tenant (sem lotação) | Idem |

## 📖 Documentação

- [`docs/writing-specs.md`](./docs/writing-specs.md) — Como escrever specs
- [`docs/conventions.md`](./docs/conventions.md) — Padrões e convenções
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) — Problemas comuns
- [`CLAUDE.md`](./CLAUDE.md) — Instruções para Claude Code

## 🤝 Contribuindo

1. Sempre escrever spec para nova feature/bug fix
2. Rodar localmente: `npm run e2e:running`
3. Specs devem passar no CI antes de merge
4. Ver [`docs/contributing.md`](./docs/contributing.md)

## 📄 Licença

LGPL-3.0-or-later
