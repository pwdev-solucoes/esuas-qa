# Matriz de Cobertura: AC → E2E

Mapeamento de **todos os Critérios de Aceite** com status de cobertura por spec E2E.

**Atualizado:** 2026-09-20 | **Próxima revisão:** 2026-10-20

---

## 📊 Resumo de cobertura

| Domínio | Total AC | Covered | Planned | Manual | Taxa |
|---------|----------|---------|---------|--------|------|
| **Auth** | 5 | 3 | 2 | 0 | 60% |
| **Admin** | 18 | 8 | 7 | 3 | 44% |
| **Client** | 12 | 2 | 8 | 2 | 17% |
| **Shared** | 4 | 1 | 3 | 0 | 25% |
| **TOTAL** | **39** | **14** | **20** | **5** | **36%** |

---

## 🔐 Auth (5 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA1 | US-1 | Login com CPF e senha válidos | ✅ Covered | `tests/auth/CA1-login-cpf-valido.spec.ts` | Superadmin |
| CA2 | US-1 | Validação: CPF inválido é rejeitado | ✅ Covered | `tests/auth/CA2-validar-cpf.spec.ts` | — |
| CA3 | US-1 | Logout e limpeza de sessão | ✅ Covered | `tests/auth/CA3-logout.spec.ts` | — |
| CA4 | US-2 | Reset de senha via email | ⚠️ Planned | — | Depende de Mailpit |
| CA5 | US-2 | Link de reset expira em 24h | ⚠️ Planned | — | Smoke test preferível |

---

## 🏢 Admin — Gestão de Tenants (8 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA6 | US-3 | Criar tenant com dados obrigatórios | ✅ Covered | `tests/admin/CA6-criar-tenant.spec.ts` | — |
| CA7 | US-3 | Validação: CNPJ duplicado | ❌ Manual | — | Teste de UI simples |
| CA8 | US-3 | Email com credenciais é enviado | ⚠️ Planned | — | Mailpit |
| CA9 | US-4 | Ativar tenant | ✅ Covered | `tests/admin/CA9-ativar-tenant.spec.ts` | — |
| CA10 | US-4 | Desativar tenant | ✅ Covered | `tests/admin/CA10-desativar-tenant.spec.ts` | — |
| CA11 | US-5 | Editar nome do tenant | ⚠️ Planned | — | — |
| CA12 | US-5 | Listar tenants com paginação | ⚠️ Planned | — | — |
| CA13 | US-6 | Deletar tenant (soft delete) | ❌ Manual | — | Operação destrutiva |

---

## 🏢 Admin — Lookups SUAS (5 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA14 | US-10 | Criar lookup (entity-type) | ⚠️ Planned | — | — |
| CA15 | US-10 | Editar lookup existente | ⚠️ Planned | — | — |
| CA16 | US-10 | Validação: nome duplicado | ⚠️ Planned | — | — |
| CA17 | US-11 | Listar todas entity-types | ✅ Covered | `tests/admin/CA17-list-lookups.spec.ts` | — |
| CA18 | US-11 | Buscar lookup por nome | ⚠️ Planned | — | — |

---

## 🔐 Admin — RBAC (5 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA19 | US-20 | Atribuir role a usuário | ✅ Covered | `tests/admin/CA19-assign-role.spec.ts` | — |
| CA20 | US-20 | Revogar permission específica | ⚠️ Planned | — | — |
| CA21 | US-21 | Listar roles disponíveis | ✅ Covered | `tests/admin/CA21-list-roles.spec.ts` | — |
| CA22 | US-21 | Criar role customizada | ❌ Manual | — | Raro |
| CA23 | US-22 | Permissão negada sem acesso | ✅ Covered | `tests/admin/CA23-permission-denied.spec.ts` | — |

---

## 🗺️ Admin — Geography (3 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA24 | US-30 | Listar estados, municípios | ⚠️ Planned | — | — |
| CA25 | US-31 | Importar DNE (endereços) | ❌ Manual | — | Batch job |
| CA26 | US-32 | Criar geo-layer customizado | ⚠️ Planned | — | Geojson upload |

---

## 👥 Client — Autenticação (4 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA27 | US-40 | Login no tenant (SelectTenant) | ✅ Covered | `tests/client/CA27-tenant-login.spec.ts` | — |
| CA28 | US-40 | Usuário sem vinculo é negado | ⚠️ Planned | — | — |
| CA29 | US-41 | Aceitar termos LGPD para acessar | ⚠️ Planned | — | Gate frontend |
| CA30 | US-41 | Rejeitar termos bloqueia acesso | ⚠️ Planned | — | — |

---

## 📋 Client — Prontuário (4 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA31 | US-50 | Listar famílias do tenant | ✅ Covered | `tests/client/CA31-list-families.spec.ts` | — |
| CA32 | US-50 | Buscar família por CPF | ⚠️ Planned | — | — |
| CA33 | US-51 | Criar prontuário (intake) | ⚠️ Planned | — | Form complexo |
| CA34 | US-52 | Importar CadÚnico | ⚠️ Planned | — | Job async |

---

## 🗺️ Client — Geo-Panel (4 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA35 | US-60 | Ver mapa de famílias | ⚠️ Planned | — | Multi-engine (OpenLayers/Google) |
| CA36 | US-61 | Filtrar por setor censitário IBGE | ⚠️ Planned | — | GeoJSON rendering |
| CA37 | US-62 | Heatmap de vulnerabilidade | ⚠️ Planned | — | Performance concern |
| CA38 | US-63 | Exportar PDF/XLSX async | ❌ Manual | — | Job queue |

---

## 🔗 Shared (4 CA)

| ID | User Story | Critério | Status | Spec E2E | Notas |
|----|-----------|----------|--------|----------|-------|
| CA39 | US-70 | Enviar email de confirmação | ⚠️ Planned | — | Mailpit |
| CA40 | US-71 | Rate limit em 6 logins/min | ✅ Covered | `tests/shared/CA40-rate-limit.spec.ts` | — |
| CA41 | US-72 | Auditoria registra user_id + tenant_id | ⚠️ Planned | — | Smoke test (Pest) |
| CA42 | US-73 | Isolamento multi-tenant via Global Scope | ❌ Manual | — | Teste de segurança |

---

## 🎯 Legenda

- **✅ Covered** — Spec E2E existe, passa e é mantido
- **⚠️ Planned** — CA priorizado, spec será escrita (roadmap)
- **❌ Manual** — Testado manualmente (recurso limitado)

---

## 📈 Próximas ações

1. **Semana 1:** Cobrir CA auth (CA4, CA5) — email + tempo
2. **Semana 2:** Cobrir CA admin lookups (CA14-18)
3. **Semana 3:** Cobrir CA client families (CA31-34)
4. **Meta:** 80% de cobertura até fim de Q1 2026

---

## 🔗 Referências

- **User Stories:** `.planning/feat/` ou Linear
- **Specs E2E:** `tests/`
- **Acceptance docs:** `acceptance/user-stories/`
