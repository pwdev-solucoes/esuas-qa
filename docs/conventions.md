# Convenções QA

Padrões, naming, e boas práticas para testes QA do SigSUAS.

## 📁 Organização de arquivos

### Estrutura de pastas

```
e2e/tests/
├── auth/                   # Autenticação, login, logout, 2FA
├── admin/                  # Super Admin (tenants, lookups, rbac, geo, users)
│   ├── tenants/            # CRUD de tenants, ativação/desativação
│   ├── lookups/            # Tabelas SUAS (entity-types, statuses, etc)
│   ├── rbac/               # Roles, permissions, assignments
│   ├── geo/                # Geography, territories, geo-layers
│   └── users/              # Usuários globais, permissões
├── client/                 # Tenant (families, social-units, geo-panel, etc)
│   ├── families/           # Prontuário, busca, importação
│   ├── social-units/       # CRAS/CREAS
│   ├── geo-panel/          # Mapa, heatmap, setores
│   ├── professionals/      # Profissionais, lotações
│   └── settings/           # Config do tenant, aceite legal
├── shared/                 # Testes comuns a ambos
│   └── email-verification/ # Reset senha, confirma email
└── acceptance/             # Testes de aceitação (por domínio)
    ├── user-stories/
    └── matrix.md
```

### Naming de specs

Convenção: `<CA##|feature>-<descricao-curta>.spec.ts`

```
✅ CA1-criar-tenant-obrigatorios.spec.ts
✅ login-com-cpf-valido.spec.ts
❌ test.spec.ts
❌ spec1.spec.ts
❌ CA1.spec.ts
```

## 🏷️ Estrutura de suites (`test.describe`)

```typescript
test.describe('CA## — Descrição longa do critério de aceite', () => {
  let resource: any;

  test.beforeAll(async ({ request }) => {
    // Setup: criar dados compartilhados pela suite
    const res = await request.post('/api/...', { ... });
    resource = res.json();
  });

  test('cenário 1: happy path', async ({ page }) => {
    // Teste isolado
  });

  test('cenário 2: edge case', async ({ page }) => {
    // Teste isolado
  });

  test.afterAll(async ({ request }) => {
    // Cleanup: deletar dados criados
    await request.delete(`/api/.../${resource.id}`);
  });
});
```

## 🔤 Naming de testes

### Padrão: descritivo, em português, sem siglas

```typescript
✅ test('criar tenant com dados obrigatórios', () => { ... });
✅ test('validação: CNPJ duplicado é rejeitado', () => { ... });
✅ test('email com credenciais temporárias é enviado', () => { ... });
❌ test('CT-001', () => { ... });
❌ test('test 1', () => { ... });
❌ test('criar tenant (happy path)', () => { ... });  // padrão Playwright: use nomes simples
```

### Seção de testes comuns

Use prefixo para agrupar:

```typescript
test.describe('Validações', () => {
  test('validação: campo vazio é rejeitado', () => { ... });
  test('validação: email inválido é rejeitado', () => { ... });
  test('validação: CNPJ inválido é rejeitado', () => { ... });
});

test.describe('Permissões', () => {
  test('permissão: usuário sem acesso é negado', () => { ... });
  test('permissão: super-admin sempre tem acesso', () => { ... });
});
```

## 🔗 Seletores

### Regra: SEMPRE `data-testid`

```typescript
// ❌ NUNCA
await page.click('.btn-primary');
await page.fill('#name-input', 'João');
await page.locator('button:has-text("Confirmar")').click();

// ✅ SEMPRE
await page.click('[data-testid="btn-submit"]');
await page.fill('[data-testid="input-name"]', 'João');
await page.locator('[data-testid="btn-confirm"]').click();
```

### Verificação no `.vue`

Seletores devem estar documentados no componente:

```vue
<!-- Bom -->
<input
  data-testid="input-tenant-name"
  v-model="formData.name"
  type="text"
/>

<button data-testid="btn-save" @click="submit">
  Salvar
</button>

<!-- Ruim: data-testid genérico -->
<input data-testid="input" v-model="formData.name" />
```

### Nomes de `data-testid`

```
[data-testid="btn-{action}"]           # Botões: btn-save, btn-delete, btn-cancel
[data-testid="input-{field}"]          # Inputs: input-email, input-password
[data-testid="select-{field}"]         # Select: select-role, select-status
[data-testid="link-{destination}"]     # Links: link-home, link-logout
[data-testid="error-{field}"]          # Mensagens: error-email, error-required
[data-testid="success-message"]        # Feedback: success-message, info-banner
[data-testid="table-{entity}"]         # Tabelas: table-tenants, table-users
[data-testid="row-{entity}-{id}"]      # Linhas: row-tenant-42, row-user-7
```

## 📦 Fixtures (dados de teste)

### Localização

```
e2e/fixtures/
├── auth.ts              # Autenticação (login, logout, roles)
├── test-data.ts         # Dados padrão (tenants, users, etc)
├── api-client.ts        # Cliente HTTP reutilizável
├── tenant-auth.ts       # Autenticação de tenant
├── cadunico/            # Dados de importação CadÚnico
└── avatars/             # Imagens para upload
```

### Padrão: sufixo único

```typescript
// ✅ Sempre com timestamp ou UUID
export const testTenant = {
  name: `Município ${Date.now()}`,
  document: '12345678000190',
  email: `contact-${Date.now()}@test.local`,
};

export const testUser = {
  cpf: `${Math.random().toString().slice(2, 12)}`,  // 10 dígitos aleatórios
  email: `user-${Date.now()}@test.local`,
};

// ❌ ERRADO: dados fixos (pode colidir em testes paralelos)
export const testTenant = {
  name: 'Município Teste',
  email: 'contact@test.local',
};
```

## 🔐 Autenticação

### Super Admin (project `chromium`)

```typescript
// ✅ Page vem já autenticado
test('gerenciar tenants', async ({ page }) => {
  await page.goto('/app/tenants');
  // Sem necessidade de login
});

// ✅ localStorage tem token
expect(localStorage.getItem('app-token')).toBeTruthy();
```

### Tenant User (project `chromium-tenant`)

```typescript
// ✅ Specs já autenticados como operador
test('ver prontuário', async ({ page }) => {
  await page.goto('/app/families');
  // Sem necessidade de login
});

// ✅ Para outro usuário, resetar
import { loginAsTenantUser } from '../../fixtures/tenant-auth';

test('como master', async ({ page }) => {
  await loginAsTenantUser(page, E2E_CLIENT_MASTER_CPF);
  // ...
});
```

## 📊 API-first vs UI-centric

### API para setup/teardown

```typescript
test.beforeAll(async ({ request }) => {
  // Setup: criar via API (rápido, confiável)
  const res = await request.post('/api/manager/tenants', {
    data: testTenant,
  });
  tenantId = res.json().id;
});

test.afterAll(async ({ request }) => {
  // Cleanup: deletar via API
  await request.delete(`/api/manager/tenants/${tenantId}`);
});
```

### UI para fluxo crítico

```typescript
test('criar tenant via UI', async ({ page }) => {
  // O fluxo que o usuário vê
  await page.goto('/app/tenants');
  await page.click('[data-testid="btn-create"]');
  await page.fill('[data-testid="input-name"]', testTenant.name);
  // ...
});
```

## 🧹 Cleanup

### Rigoroso

```typescript
// ❌ Cleanup condicional (pode deixar resíduo)
test.afterEach(async ({ request }) => {
  if (success) {
    await request.delete(`/api/.../${id}`);
  }
});

// ✅ Sempre limpar, mesmo se teste falhar
test.afterEach(async ({ request }) => {
  try {
    await request.delete(`/api/.../${id}`);
  } catch {
    // Cleanup falhou, mas não interrompe
  }
});

// ✅ Melhor: usar finally
test.afterEach(async ({ request }) => {
  try {
    // Assertions, etc
  } finally {
    // Sempre executado
    await request.delete(`/api/.../${id}`);
  }
});
```

## ⏱️ Esperas

### Nunca sleep absoluto

```typescript
// ❌
await new Promise(r => setTimeout(r, 1000));

// ✅ Esperar por elemento
await expect(page.locator('[data-testid="success-message"]')).toBeVisible();

// ✅ Esperar por navegação
await page.waitForURL('**/app/**');

// ✅ Esperar por rede
await page.waitForLoadState('networkidle');

// ✅ Esperar por estado
await expect(page.locator('[data-testid="loading"]')).toBeHidden();
```

## 📝 Page Object Model

### Ações de alto nível

```typescript
// ❌ Misturar seletores com testes
test('criar tenant', async ({ page }) => {
  await page.click('[data-testid="btn-create"]');
  await page.fill('[data-testid="input-name"]', 'Município X');
  // ...
});

// ✅ Encapsular em POM
class TenantsPage {
  async createTenant(name: string) {
    await this.page.click('[data-testid="btn-create"]');
    await this.page.fill('[data-testid="input-name"]', name);
  }
}

test('criar tenant', async ({ page }) => {
  const tenants = new TenantsPage(page);
  await tenants.createTenant('Município X');
});
```

### Assertions reutilizáveis

```typescript
class TenantsPage {
  async verifyTenantVisible(name: string) {
    await expect(
      this.page.locator(`[data-testid="row-tenant"]:has-text("${name}")`)
    ).toBeVisible();
  }

  async verifyErrorMessage(text: string) {
    await expect(this.page.locator(`[data-testid="error"]`)).toContainText(
      text
    );
  }
}
```

## 🎯 Specs vs. Smoke tests

### Spec (E2E)

- Fluxo completo de usuário
- Testa UI + API + banco de dados
- Lento, mas descobre regressões reais

### Smoke test (Pest/API)

- Teste rápido de endpoint
- Testa API + banco sem UI
- Mais rápido, descobrir bugs de contrato

**Estratégia:**

```typescript
// Pest: smoke test
test('POST /api/manager/tenants cria com dados válidos', () => {
  // ...
});

// E2E: UI criando via formulário
test('CA1 — criar tenant via formulário', async ({ page }) => {
  // ...
});
```

## 🚀 Checklist de qualidade

- [ ] Spec nomeado corretamente (`CA##-...spec.ts`)
- [ ] Estrutura AAA (Arrange, Act, Assert)
- [ ] Seletores via `data-testid` (verificados no Vue)
- [ ] Fixtures com sufixo único (timestamp)
- [ ] Cleanup no `afterAll` ou `afterEach`
- [ ] Nenhuma sleep absoluta
- [ ] Page Object Model para ações comuns
- [ ] Assertions específicas (não genéricas)
- [ ] Testes isolados (sem dependências entre specs)
- [ ] Rodado localmente antes de PR

## 🔗 Referências

- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Testing Library Principles](https://testing-library.com/docs/guiding-principles)
- [Page Object Model](https://playwright.dev/docs/pom)
