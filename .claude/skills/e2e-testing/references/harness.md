# Harness E2E do eSUAS — fatos, massa e comandos

Tudo conferido no código em 2026-09-15. Cite `arquivo:linha` ao justificar uma escolha.

## Projects e sessões (`e2e/playwright.config.ts`)

| Project | Onde roda | baseURL | Sessão | Observação |
|---|---|---|---|---|
| `setup` | `*.setup.ts` | — | — | Roda `auth.setup.ts` **e** `tenant-auth.setup.ts` |
| `chromium` | tudo fora de `tests/client/` | `E2E_BASE_URL` (`:4173`) | `.auth/super-admin.json` | Painel Global (guard `manager`) |
| `chromium-tenant` | `tests/client/` | `CLIENT_BASE_URL` (`:4174`) | `.auth/tenant.json` | Painel do Tenant (guard `client`), operador já logado |

`fullyParallel: false`; workers 2 no CI; `timeout` 60s; `expect.timeout` 5s. `globalSetup`
(`e2e/global-setup.ts`) limpa o cache do rate-limiter — as rotas de auth têm `throttle:6,1`.

> ⚠️ O client **não é mais opt-in**. O project `chromium-tenant` existe desde `990da00` (2026-09-02).
> Comentários de specs antigos e trechos do `e2e/README.md` ainda dizem o contrário — não os copie.

## Sessão, fixtures e helpers

| Recurso | Assinatura / uso |
|---|---|
| `e2e/fixtures/auth.ts` | `import { test, expect } from '../../fixtures/auth'` — injeta a fixture `apiClient` (admin) |
| `e2e/fixtures/api-client.ts` | `ApiClient.get/post/delete`, prefixa `/api`, injeta `X-XSRF-TOKEN` |
| `e2e/fixtures/tenant-auth.ts:106` | `createTenantApiClient(tenantUuid?)` — cliente de API do tenant, já com `X-Tenant-UUID` |
| `e2e/fixtures/tenant-auth.ts` | `loginAsTenantUser(page, cpf, senha, { tenantUuid })` — outro perfil; zera a sessão herdada antes |
| `e2e/helpers/platform-updates.ts` | `dismissPlatformUpdates(page)` — **obrigatório após cada `goto`** |
| `e2e/helpers/evidence.ts` | `captureFinalEvidence(page, testInfo, EVIDENCE_SLUG)` no `afterEach` e `captureEvidence(…, 'sufixo')` no instante que importa; inertes sem `CAPTURE_EVIDENCE=1`. **`EVIDENCE_SLUG` em minúsculas**, igual ao nome da pasta do dossiê em `e2e/reports/`: em macOS o sistema de arquivos ignora maiúsculas, então um slug capitalizado cai na mesma pasta e duplica os arquivos do mesmo critério |
| `e2e/helpers/cpf.ts` | `generateCpf()` (CPF válido, sem máscara) e `maskCpf()` |
| `e2e/helpers/mailpit.ts` | `MailpitClient` — só para fluxos de e-mail |
| `e2e/helpers/upload.ts` | `avatarFixturePath()`, `fakeImageBuffer()`, `oversizeImageBuffer()` |

**Page Object é opcional, não obrigatório.** Vive no admin (`e2e/pages/lookups/ReferenceLookupCrudPage.ts`
é o melhor exemplar, com ações de alto nível). Os specs novos de `tests/client/` usam **funções locais**
no topo do arquivo (`openIntakeTab`, `chooseForm`, `waitForList`). Regra prática: POM quando a mesma tela
é exercitada por vários specs; função local quando o fluxo é de um spec só.

## Massa do E2ESeeder

Fonte da verdade: JSDoc no topo de `api/database/seeders/E2EProntuarioSeeder.php`.

| Item | Valor |
|---|---|
| Tenant | `00000000-0000-4000-8000-0000000000c1` |
| Unidades | `…0e0001` E2E CRAS Centro · `…0e0002` E2E CREAS · `…0e0003` E2E CRAS Sem MDS |
| Famílias | `…0f0001` na unidade · `…0f0002` em outra unidade · `…0f0003` sem unidade · `…0f0004`–`…0f0012` cenários de ingresso/especificidade · `…0f0013` encaminhamento legado |
| Super Admin | `44983702016` |
| Master do tenant | `52998224725` |
| Operacional (add-on LGPD + lotação vigente) | `11144477735` |
| Operacional com lotação encerrada | `15350946056` |
| Operacional sem o add-on | `48761649082` |

Senha de todos: `senha123`. É massa sintética de teste — nunca use dado real.

Os uuids acima chegam ao spec por variável de ambiente (`E2E_CLIENT_FAMILY_IN_UNIT_UUID`,
`E2E_CLIENT_UNIT_UUID`, …) com alternativa fixa no próprio arquivo. **Uuid gerado pelo seeder**
(serviços, razões, códigos) **nunca se fixa**: resolva por `code` numa chamada de API no `beforeAll`.

## Comandos

```bash
cd e2e
npx playwright test tests/client/<assunto>.spec.ts      # um spec
npx playwright test tests/client/<assunto>.spec.ts:291  # um caso, pela linha
npx playwright test -g "CA01"                           # por título
npx playwright test tests/client                        # só o project chromium-tenant
npx playwright test --headed                            # ver acontecendo
npx playwright test --debug=cli                         # inspecionar passo a passo
npm run e2e:running                                     # suíte contra a stack já no ar
CAPTURE_EVIDENCE=1 npx playwright test tests/<...>      # gera os prints do dossiê
```

**Destrutivos, só com confirmação explícita do usuário:** `npm run e2e:local` e
`e2e/scripts/start-stack.sh` — sobrescrevem `api/.env` (`cp .env.example .env` + overrides) e rodam
`migrate:fresh --seed`, apagando o banco de desenvolvimento.

## Ambiente: como saber onde rodar

O harness lê `e2e/.env.e2e` (não tente lê-lo: hook de segredos bloqueia). Dois modos documentados em
`e2e/README.md`: `.env.e2e.example` (stack dedicada, portas 4173/4174/8090) e `.env.e2e.dev.example`
(stack de dev já no ar). Para descobrir o que está de pé sem tocar em `.env`:

```bash
docker ps --format '{{.Names}}' | grep api-laravel      # stack Sail
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/up          # API de dev
lsof -iTCP -sTCP:LISTEN -P | grep -E ':(5173|5174|5175|4173|4174)'    # fronts servidos
```

Confirme também que o front aponta para a API real: em modo mock (`VITE_API_URL` vazio) qualquer CPF
autentica e a suíte fica verde testando mentira.
