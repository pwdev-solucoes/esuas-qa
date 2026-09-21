# Escrevendo Specs E2E

Guia completo para escrever testes E2E para SigSUAS com Playwright.

## 📋 Receita: AC → Spec

### 1. Mapear o Critério de Aceite (CA)

Exemplo de user story:

```markdown
## US-42: Criar novo tenant

### Critérios de Aceite
- **CA1:** Super Admin pode criar tenant com dados obrigatórios
- **CA2:** Validação de CNPJ duplicado
- **CA3:** Email do responsável é enviado com credenciais temporárias
- **CA4:** Tenant inicia desativado até ativação manual
```

### 2. Nomear o spec

Convenção: `CA##-descricao-curta.spec.ts`

```
tests/admin/
├── CA1-criar-tenant-obrigatorios.spec.ts
├── CA2-validar-cnpj-duplicado.spec.ts
├── CA3-email-credenciais.spec.ts
└── CA4-tenant-desativado-por-padrao.spec.ts
```

### 3. Usar o molde

```typescript
import { test, expect } from '@playwright/test';
import { TenantsPage } from '../../pages/admin/TenantsPage';

/**
 * CA1 — Super Admin pode criar tenant com dados obrigatórios
 * 
 * Deps: Usuário super-admin autenticado (via global-setup)
 * Smoke: POST /api/manager/tenants (API Pest)
 */
test.describe('CA1 — Criar tenant com dados obrigatórios', () => {
  const tenantsPage = new TenantsPage(page);

  test('fluxo feliz: criar e verificar', async ({ page }) => {
    // ARRANGE: dados de teste
    const tenantData = {
      name: `Município ${Date.now()}`,
      document: '12345678000190',
      email: `contact-${Date.now()}@test.local`,
    };

    // ACT: navegação e interações
    await page.goto('/app/tenants');
    await tenantsPage.clickCreateButton();
    await tenantsPage.fillTenantForm(tenantData);
    await tenantsPage.submitForm();

    // ASSERT: verificações
    await expect(page.locator('text=Tenant criado com sucesso')).toBeVisible();
    await expect(page.locator(`text="${tenantData.name}"`)).toBeVisible();
  });

  test('validação: campos obrigatórios', async ({ page }) => {
    await page.goto('/app/tenants');
    await tenantsPage.clickCreateButton();
    await tenantsPage.submitForm();  // sem preencher

    const errors = await page.locator('[data-testid="error-message"]').all();
    expect(errors.length).toBeGreaterThan(0);
  });

  test.afterEach(async ({ request }) => {
    // CLEANUP: deletar tenants criados no teste
    // (via API ou UI, depending on fixture)
  });
});
```

## 🏗️ Anatomy de um spec

### Structure: Arrange → Act → Assert

```typescript
test('autenticação: login com CPF e senha', async ({ page, request }) => {
  // ===== ARRANGE =====
  // Setup: dados, fixtures, state inicial
  const credentials = {
    cpf: process.env.E2E_ADMIN_CPF!,
    password: process.env.E2E_ADMIN_PASSWORD!,
  };

  // ===== ACT =====
  // Ações: navegar, clicar, preencher formulário
  await page.goto('/auth/login');
  await page.fill('[data-testid="input-cpf"]', credentials.cpf);
  await page.fill('[data-testid="input-password"]', credentials.password);
  await page.click('[data-testid="btn-submit"]');
  await page.waitForURL('**/app/**');

  // ===== ASSERT =====
  // Verificações: estado, UI, comportamento
  await expect(page).toHaveURL(/\/app\/.*/);
  await expect(page.locator('[data-testid="user-name"]')).toContainText('Paulo');
  expect(localStorage.getItem('app-token')).toBeTruthy();
});
```

### Fixtures: dados reutilizáveis

```typescript
// fixtures/test-data.ts
export const testTenant = {
  name: `Município ${Date.now()}`,
  document: '12345678000190',
  email: `admin-${Date.now()}@test.local`,
  responsable: 'João da Silva',
};

// No spec
import { testTenant } from '../../fixtures/test-data';

test('criar tenant', async ({ page }) => {
  const response = await page.request.post('/api/manager/tenants', {
    data: testTenant,
  });
  expect(response.ok()).toBeTruthy();
});
```

### API-first quando possível

Usar API para setup/teardown, UI para fluxo crítico:

```typescript
test('editar tenant via UI', async ({ page, request }) => {
  // ===== Setup via API =====
  const createRes = await request.post('/api/manager/tenants', {
    data: testTenant,
  });
  const tenantId = createRes.json().id;

  // ===== Fluxo crítico via UI =====
  await page.goto(`/app/tenants/${tenantId}/edit`);
  await page.fill('[data-testid="input-name"]', 'Novo Nome');
  await page.click('[data-testid="btn-save"]');
  
  // ===== Assertions =====
  await expect(page.locator('text=Salvo com sucesso')).toBeVisible();

  // ===== Cleanup via API =====
  await request.delete(`/api/manager/tenants/${tenantId}`);
});
```

## 📄 Page Object Model (POM)

### Conceito

POM encapsula **ações de alto nível** de uma página, não seletores brutos.

### Estrutura

```typescript
// pages/admin/TenantsPage.ts
import { Page, expect } from '@playwright/test';

export class TenantsPage {
  constructor(private page: Page) {}

  // ===== Ações de alto nível =====
  async navigateToList() {
    await this.page.goto('/app/tenants');
    await this.page.waitForLoadState('networkidle');
  }

  async clickCreateButton() {
    await this.page.click('[data-testid="btn-create-tenant"]');
  }

  async fillTenantForm(data: {
    name: string;
    document: string;
    email: string;
  }) {
    await this.page.fill('[data-testid="input-name"]', data.name);
    await this.page.fill('[data-testid="input-document"]', data.document);
    await this.page.fill('[data-testid="input-email"]', data.email);
  }

  async submitForm() {
    await this.page.click('[data-testid="btn-confirm"]');
    await this.page.waitForLoadState('networkidle');
  }

  // ===== Assertions de alto nível =====
  async verifyTenantExists(name: string) {
    await expect(
      this.page.locator(`[data-testid="tenant-row"]:has-text("${name}")`)
    ).toBeVisible();
  }

  async verifyErrorMessage(message: string) {
    await expect(this.page.locator(`text="${message}"`)).toBeVisible();
  }
}
```

### Uso no spec

```typescript
test('criar tenant', async ({ page }) => {
  const tenants = new TenantsPage(page);
  
  await tenants.navigateToList();
  await tenants.clickCreateButton();
  await tenants.fillTenantForm({
    name: 'Município X',
    document: '12345678000190',
    email: 'contact@test.local',
  });
  await tenants.submitForm();
  
  await tenants.verifyTenantExists('Município X');
});
```

## 🔐 Autenticação

### Super Admin (já autenticado)

O `global-setup.ts` executa uma vez:
- Faz login como super-admin
- Salva storage state em `.auth/super-admin.json`
- Todos os specs no project `chromium` herdam essa sessão

```typescript
// No spec — page vem já autenticado
test('gerenciar tenants', async ({ page }) => {
  await page.goto('/app/tenants');  // nenhum login necessário
  // localStorage['app-token'] já existe
});
```

### Tenant User (client)

Similarmente, specs em `tests/client/` herdam a sessão de `.auth/tenant.json`:

```typescript
// Já autenticado como operador
test('ver prontuário', async ({ page }) => {
  await page.goto('/app/families');  // redirects for login já tratado
});
```

### Resetar sessão (outro usuário)

Se precisa de outro perfil (master, sem lotação, etc):

```typescript
import { loginAsTenantUser } from '../../fixtures/tenant-auth';

test('como master sem lotação', async ({ page }) => {
  await loginAsTenantUser(page, E2E_CLIENT_MASTER_CPF);
  // page está agora logada como master
});
```

## 📊 Dados de teste (fixtures)

### Estratégia

- **Setup global:** E2ESeeder (rodado uma vez)
- **Por suite:** criar dados com sufixo único, limpar depois
- **Nunca:** confiar em estado compartilhado entre testes

### Exemplo

```typescript
test.describe('Tenant RBAC', () => {
  let tenantId: number;

  test.beforeAll(async ({ request }) => {
    // Criar tenant único para esta suite
    const res = await request.post('/api/manager/tenants', {
      data: {
        name: `Tenant ${Date.now()}`,
        document: '12345678000190',
      },
    });
    tenantId = res.json().id;
  });

  test('atribuir role a usuário', async ({ page }) => {
    // Usar tenantId
    await page.goto(`/app/tenants/${tenantId}/users`);
    // ...
  });

  test.afterAll(async ({ request }) => {
    // Cleanup
    await request.delete(`/api/manager/tenants/${tenantId}`);
  });
});
```

## 🎯 Seletores

### Convenção: `data-testid`

**Sempre** usar `data-testid` — nunca seletores CSS genéricos:

```typescript
// ❌ ERRADO
await page.click('.btn.primary');  // pode quebrar com CSS

// ✅ CORRETO
await page.click('[data-testid="btn-submit"]');
```

### Verificar no `.vue`

Seletores devem estar definidos no componente:

```vue
<!-- admin/src/components/TenantForm.vue -->
<template>
  <form>
    <input data-testid="input-name" v-model="form.name" />
    <button data-testid="btn-submit">Confirmar</button>
  </form>
</template>
```

## ⚡ Boas práticas

### 1. Nomes descritivos

```typescript
// ❌
test('test 1', () => { ... });

// ✅
test('criar tenant com dados obrigatórios e verificar sucesso', () => { ... });
```

### 2. Waiters explícitos

```typescript
// ❌
await page.click('button');
// eslint-disable-next-line
await new Promise(r => setTimeout(r, 1000));  // magic sleep

// ✅
await page.click('button');
await page.waitForLoadState('networkidle');
// Ou: await expect(page.locator('text=Success')).toBeVisible();
```

### 3. Assertions específicas

```typescript
// ❌
expect(page).toBeTruthy();

// ✅
await expect(page.locator('[data-testid="success-message"]')).toContainText(
  'Tenant criado com sucesso'
);
```

### 4. Cleanup rigoroso

```typescript
test.afterEach(async ({ request }) => {
  // Sempre limpar, mesmo se teste falhar
  // Use try/finally se necessário
});
```

### 5. Evitar sleep absoluto

```typescript
// ❌
await new Promise(r => setTimeout(r, 2000));

// ✅
await page.waitForSelector('[data-testid="loading-complete"]', {
  state: 'hidden',
});
```

## 🚀 Checklist para novo spec

- [ ] Nomeado como `CA##-descricao-curta.spec.ts`
- [ ] Estrutura AAA (Arrange, Act, Assert)
- [ ] Page Object Model para ações comuns
- [ ] Fixtures com sufixo único (timestamp)
- [ ] Cleanup no `afterAll` ou `afterEach`
- [ ] Seletores via `data-testid` (verificados no Vue)
- [ ] Nenhuma sleep absoluta
- [ ] Nenhuma importação de código `admin/`, `api/`, `client/`
- [ ] Rodar localmente antes de PR: `npm run e2e:running`

## 🔗 Referências

- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Testing Library (principles)](https://testing-library.com/docs/guiding-principles)
- [Page Object Model](https://playwright.dev/docs/pom)
- [E2E Testing Strategies](https://www.cypress.io/blog/2019/01/03/stop-using-page-objects-and-start-using-app-actions/)
