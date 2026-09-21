# Testes de Aceitação

Testes baseados em **Critérios de Aceite (CA)** de user stories, estruturados por domínio.

## 📋 Estratégia

Cada user story possui **critérios de aceite (CA)**, que são mapeados para **specs E2E** com a convenção:

```
CA## — Descrição longo do critério
├── spec: tests/[dominio]/CA##-...spec.ts
├── casos: acceptance/user-stories/[dominio]/CA##.md
└── matriz: acceptance/matrix.md
```

### Exemplo

**User Story:** US-42: Criar novo tenant

```markdown
### CA1: Super Admin pode criar tenant com dados obrigatórios
- E2E spec: tests/admin/CA1-criar-tenant-obrigatorios.spec.ts
- Casos: acceptance/user-stories/admin/CA1-tenant-obrigatorios.md
- Matriz: matrix.md (referência)
```

## 🗂️ Estrutura

```
acceptance/
├── user-stories/
│   ├── admin/              # Super Admin (tenants, lookups, rbac, geo, users)
│   │   ├── CA1.md
│   │   ├── CA2.md
│   │   └── ...
│   ├── client/             # Tenant (families, social-units, geo-panel)
│   │   ├── CA10.md
│   │   ├── CA11.md
│   │   └── ...
│   └── shared/             # Auth, common flows
│       ├── CA1-login.md
│       └── ...
├── matrix.md               # Matriz de cobertura (AC → E2E)
├── roadmap.md              # Roadmap de cobertura AC
└── README.md               # Este arquivo
```

## 📊 Matriz de Cobertura

Arquivo `acceptance/matrix.md` mapeia **todos os AC** com status de cobertura:

```markdown
| ID | User Story | Critério de Aceite | Status | Spec E2E |
|----|------------|-------------------|--------|----------|
| CA1 | US-42 | Criar tenant com dados obrigatórios | ✅ Covered | tests/admin/CA1-*.spec.ts |
| CA2 | US-42 | CNPJ duplicado é rejeitado | ⚠️ Planned | — |
| ... | ... | ... | ... | ... |
```

**Status:**
- `✅ Covered` — Spec E2E existe e passa
- `⚠️ Planned` — Spec será escrita
- `❌ Manual` — Testado manualmente (em planejamento)

## 📝 Template de CA

Arquivo: `acceptance/user-stories/[dominio]/CA##-descricao-curta.md`

```markdown
# CA## — Descrição longa do critério de aceite

**User Story:** US-## — Título

**Dado (precondições):**
- Super Admin autenticado
- Tenant X criado no sistema

**Quando (ação):**
- Super Admin navega para /app/tenants/{id}/settings
- Clica em "Ativar"
- Confirma a operação

**Então (resultado esperado):**
- Tenant está agora com status "ativo"
- Email de confirmação é enviado ao responsável
- Dashboard mostra tenant na lista de ativos

**Casos de teste:**
1. Happy path — Ativar tenant já desativado
2. Validação — Tenant já ativo não mostra botão de ativação
3. Permissão — Usuário sem acesso é negado
4. Edge case — Ativar durante janela de manutenção falha

**Spec E2E:**
- `tests/admin/CA##-ativar-tenant.spec.ts`
```

## 🔄 Fluxo de escrita

1. **Ler o CA** da user story (em `.planning/feat/` ou Linear)
2. **Criar arquivo `CA##.md`** em `acceptance/user-stories/[dominio]/`
3. **Escrever spec E2E** em `tests/[dominio]/`
4. **Atualizar matriz** (`acceptance/matrix.md`)

## 🎯 Relacionamento AC ↔ E2E

### AC precisa de spec? Nem sempre.

| Tipo de CA | Necessita E2E? | Alternativa |
|--|--|--|
| Fluxo de UI | ✅ Sim | — |
| Validação de negócio | ✅ Sim | Smoke test (Pest) |
| Segurança / LGPD | ✅ Sim | — |
| Email / notificação | ⚠️ Talvez | Pest (Mailpit) |
| Relatório / export | ⚠️ Talvez | Pest (arquivo mock) |
| Performance | ❌ Não | Load test (K6) |

### Smoke test vs. E2E

```typescript
// Pest: smoke test (rápido)
test('POST /api/manager/tenants cria com dados válidos', () => {
  $response = $this->postJson('/api/manager/tenants', [
    'name' => 'Município X',
    'document' => '12345678000190',
  ]);
  $response->assertCreated();
});

// E2E: UI completa (completo)
test('criar tenant via formulário (CA1)', async ({ page }) => {
  await page.goto('/app/tenants');
  await page.click('[data-testid="btn-create"]');
  // ... preenche, valida, aguarda resposta
});
```

## 📈 Roadmap de cobertura

Arquivo: `acceptance/roadmap.md` prioriza CA por fase

```markdown
# Roadmap de Cobertura AC → E2E

## Fase 1: Auth + Admin core (em progresso)
- [x] CA1 — Login com CPF e senha
- [x] CA2 — Reset de senha
- [x] CA3 — Criar tenant
- [ ] CA4 — Ativar/desativar tenant
- [ ] CA5 — Gerenciar perfis

## Fase 2: Client core (próximo)
- [ ] CA10 — Login multi-tenant
- [ ] CA11 — Ver prontuário
- [ ] CA12 — Importar CadÚnico

## Fase 3: Geo-panel (planejamento)
- [ ] CA20 — Ver mapa de famílias
- [ ] CA21 — Filtrar por setor censitário
```

## 🔗 Referências

- [`../e2e/README.md`](../e2e/README.md) — Testes E2E
- [`../docs/writing-specs.md`](../docs/writing-specs.md) — Como escrever specs
- `.planning/feat/` — User stories e AC (meta-repo)
- Linear / YouTrack — Sistema de tickets (fonte de verdade)

## ✅ Checklist: novo CA

- [ ] AC lido da user story
- [ ] Arquivo `CA##-descricao.md` criado em `acceptance/user-stories/[dominio]/`
- [ ] Spec E2E escrito em `tests/[dominio]/`
- [ ] Matriz atualizada (`acceptance/matrix.md`)
- [ ] Spec passa localmente (`npm run e2e:running`)
- [ ] PR linkado ao AC no Linear/YouTrack
