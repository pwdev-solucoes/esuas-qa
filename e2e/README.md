# eSUAS E2E

Testes end-to-end com Playwright cobrindo as jornadas críticas do frontend Super Admin (`admin/`) integrado à API (`api/`).

## Stack

- **Playwright** (Chromium por default; Firefox/WebKit habilitáveis)
- **Docker Compose** orquestrando API + PostgreSQL + Redis + Mailpit
- **Vite preview** servindo o admin buildado em produção (sem modo mock)

## Setup local

```bash
# 1) Copiar e ajustar env
cp .env.e2e.example .env.e2e
# editar credenciais se necessário (defaults batem com UserSeeder)

# 2) Instalar dependências e browsers
npm ci
npm run install:browsers

# 3) Subir stack + rodar testes + derrubar
npm run e2e:local

# Ou, separado:
npm run stack:up
npm run e2e
npm run stack:down
```

## Rodar contra a stack de dev já no ar

A stack dedicada (`start-stack.sh`) é uma **conveniência de isolamento/CI**, não um
requisito dos testes. Se você já tem a stack de dev rodando, dá para rodar a suíte direto
do terminal contra ela — o `migrate:fresh` destrutivo vive só no `start-stack.sh`, e os
specs criam/limpam os próprios dados por suíte (sufixo único via `fixtures/api-client.ts`).

### Pré-requisitos

- **API (Sail) no ar em `:8000`**, com banco semeado:
  ```bash
  cd ../api && ./vendor/bin/sail up -d && ./vendor/bin/sail artisan migrate --seed
  ```
  O `DatabaseSeeder` já cria o super-admin (`44983702016` / `senha123`), todos os lookups
  SUAS e os roles do Spatie — superconjunto do que o `E2ESeeder` cria.
- **`admin/` em `:5173` em modo NÃO-mock** (`VITE_API_URL=http://localhost:8000/api`):
  ```bash
  cd ../admin && npm run dev
  ```
- **Mailpit em `:8025`** (sobe junto com o Sail) — necessário só para o spec de reset de senha.

### Passos

```bash
cp .env.e2e.dev.example .env.e2e   # aponta para 5173/8000/8025
npm ci
npx playwright install chromium    # se ainda não instalado
npm run e2e:running                # = playwright test, contra a stack já no ar
```

### Trade-offs vs. stack dedicada

- Os testes **criam e apagam registros no banco de dev** (com sufixo único). Um teste que
  falhe no meio do cleanup pode deixar resíduo.
- O estado é **acumulativo** entre runs (sem `migrate:fresh`), ao contrário do CI.
- Usa o **dev server (HMR)**, então não há o smoke anti-mock — garanta o modo não-mock você mesmo.

### Autoria e heal com a skill `playwright-cli`

Para depurar/curar um teste interativamente contra a stack no ar, use o fluxo
`--debug=cli` + `playwright-cli attach` (a skill emite código `@playwright/test` a cada ação):

```bash
# Em background; aguarde "Debugging Instructions" e o nome da sessão tw-XXXX:
npm run e2e:debug:cli -- tests/auth/login.spec.ts
# ou direto: npx playwright test tests/auth/login.spec.ts:<linha> --debug=cli

playwright-cli attach tw-XXXX
playwright-cli resume     # roda o auth.setup + chega na página já logada
playwright-cli snapshot   # inventário dos elementos / refs
```

O `auth.setup.ts` roda como dependência e injeta o `storageState`, então a página vem
logada. Pare o run em background quando terminar.

## Estrutura

```
e2e/
├── playwright.config.ts        # config principal (projects: setup + chromium)
├── docker-compose-e2e.yml      # override do staging com Mailpit
├── scripts/                    # start-stack.sh, stop-stack.sh, wait-for.sh
├── setup/                      # auth.setup.ts gera .auth/super-admin.json
├── pages/                      # Page Object Model
├── fixtures/                   # auth, api-client, test-data
├── helpers/                    # mailpit, cpf
└── tests/                      # auth, tenants, rbac, lookups
```

## Estratégia de dados

- **Setup global** (uma vez por run): `E2ESeeder` cria super-admin determinístico + lookups SUAS + roles.
- **Por suite**: `beforeAll` cria recursos com sufixo único; `afterAll` remove.
- **Nunca** rodar `migrate:fresh` entre testes — incompatível com Playwright paralelo.

## Storage / Upload

Os specs em `tests/users/user-photo-upload.spec.ts` validam o fluxo completo de upload de foto contra o **disk default do container** (`public` em E2E — definido por `start-stack.sh`).

- A fixture binária está em `e2e/fixtures/avatar-1x1.png` (PNG transparente, ~68 bytes).
- Buffers gerados em memória (`oversizeImageBuffer`, `fakeImageBuffer` em `helpers/upload.ts`) cobrem os caminhos de rejeição por size/MIME sem versionar arquivos grandes.
- **MinIO/S3** não é exercitado nesta suíte. Para validar o caminho S3 real:
  1. Adicionar o serviço MinIO ao `docker-compose-e2e.yml` (seguindo o padrão do `compose.yaml` do `api/` — ver feature `minio-s3-support`).
  2. Setar `FILESYSTEM_DISK=s3` no override de env do `start-stack.sh`.
  3. O Pest do `api/` já cobre `Storage::fake('s3')` em `UserControllerTest`, então o smoke E2E só verifica HTTP — a divergência de tipos S3↔local é detectada lá.

## CI

Workflow em `.github/workflows/e2e.yml` do meta-repo roda em PRs que tocam `api/`, `admin/` ou `e2e/`. Artifacts (HTML report + traces) ficam disponíveis por 14 dias.

### Secrets necessários (GitHub → Settings → Secrets and variables → Actions)

| Secret | Para que serve | Como gerar |
|---|---|---|
| `GH_SUBMODULES_PAT` | Clonar os submódulos `api/` e `admin/` (repos privados). O `GITHUB_TOKEN` padrão não tem acesso. | GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Read-only nos 3 repos (`esuas-all`, `esuas-backend`, `esuas-frontend-admin`). Renovação anual. |
| `E2E_ADMIN_CPF` | CPF do super-admin usado pelos specs. | Pode bater com o do `UserSeeder` (`44983702016`) ou criar um dedicado. Sem máscara, só dígitos. |
| `E2E_ADMIN_PASSWORD` | Senha do super-admin. | Idem. |

### Branch protection sugerida (develop e main)

Em `Settings → Branches → Add rule` para `develop` e `main`:

- ✅ Require status checks to pass before merging:
  - `api / Pest`
  - `admin / ESLint`, `admin / Typecheck + Build`, `admin / Vitest`
  - `playwright` (deste workflow E2E)
- ✅ Require branches to be up to date before merging
- ✅ Require pull request reviews (≥1 aprovação)
- ✅ Dismiss stale pull request approvals when new commits are pushed
- ✅ Restrict force pushes

## Convenções

- POMs expõem **ações de alto nível** (`login()`), não seletores crus.
- Página em 1 teste só = inline direto, sem POM.
- Selectors via `data-testid`, lidos do `.vue` do componente — nunca inventados.
- Nunca importar código do `admin/` ou `api/` — E2E é um cliente HTTP externo.

## Specs do client (project `chromium-tenant`)

Os specs de `tests/client/` exercitam o frontend do **tenant** (`client/`), servido pelo
`start-stack.sh` em `:4174` junto com o admin em `:4173`. Eles rodam no project
**`chromium-tenant`**, que entrega `page` já autenticado como o `E2E_CLIENT_OPERADOR_*`
(ver `tests/tenant-auth.setup.ts`) — **não faça login caso a caso**: as rotas `/auth/*`
têm `throttle:6,1` e o 7º login do minuto recebe 429. Para outro perfil (Master, sem
lotação, sem add-on), use `loginAsTenantUser()` de `fixtures/tenant-auth.ts`.

```bash
npx playwright test tests/client                       # só o project do tenant
npx playwright test tests/client/family-intake.spec.ts # um spec
```

> Histórico: até `990da00` (2026-09-02) o client não era servido pela stack e esses specs
> eram opt-in com `skip`. Comentários nesse sentido ainda sobrevivem em specs antigos.

## Escrever um spec novo a partir dos Critérios de Aceite

A receita — triagem CA→(Pest|E2E), convenção de título `CAnn — …`, moldes de spec e os gotchas
do harness — está na skill `.claude/skills/e2e-testing/SKILL.md`.
