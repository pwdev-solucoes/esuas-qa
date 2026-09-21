---
name: e2e-testing
description: >-
  Transforma os Critérios de Aceite de uma HU do eSUAS em specs Playwright committed em `e2e/` —
  parte de um número de chamado GLPI, de uma spec `.planning/specs/US-*.md` ou dos CAs colados,
  classifica cada CA entre navegador e Pest, escreve o arquivo `.spec.ts` no molde do harness (título
  `CA01 — …`, massa via API no beforeAll, sessão herdada do project) e roda até ficar verde. Use
  sempre que o usuário pedir "escreve os testes E2E do chamado #10888", "cria o spec Playwright
  desses critérios de aceite", "automatiza os CAs dessa HU no Playwright", "faz um teste E2E da
  tela X", "adiciona um page object para Y", ou "essa HU precisa de teste de ponta a ponta".
  NÃO gera dossiê HTML/PDF de aceite — isso é `acceptance-evidence-report`; NÃO escreve teste de
  regra de backend — isso é Pest no submódulo `api/`. Específica do eSUAS (harness `e2e/`,
  projects `chromium`/`chromium-tenant`, E2ESeeder).
type: workflow
---

# e2e-testing — Dos Critérios de Aceite ao spec Playwright verde

A suíte E2E vive na **raiz** `e2e/` (fora dos submódulos, TypeScript próprio) e roda no CI. Esta skill
é sobre **autoria de specs committed a partir dos CAs**: o critério que o PO escreveu vira um caso de
teste que assevera, roda amanhã de novo e — de quebra — alimenta o dossiê de aceite.

> Fatos do harness, comandos e massa: **`references/harness.md`**.
> Triagem CA→teste, convenção de título e tradução Gherkin→`test()`: **`references/ca-para-caso.md`**.
> Esqueletos completos de spec (admin e client): **`references/moldes.md`**.
>
> **Não confundir com [`acceptance-evidence-report`](../acceptance-evidence-report/SKILL.md):** aquela
> monta o dossiê HTML/PDF para o PO. Esta escreve o teste. As duas se encontram em
> `e2e/helpers/evidence.ts`: com `CAPTURE_EVIDENCE=1`, o print do dossiê sai **do caso que passou**.
> Para fechar o ciclo no GLPI: [`glpi-evidence-validation`](../glpi-evidence-validation/SKILL.md).

## Entradas

| Entrada | Descrição | Default |
|---|---|---|
| Fonte dos CAs | **(a)** número do ticket GLPI · **(b)** path de `.planning/specs/US-*.md` · **(c)** Gherkin colado na conversa | obrigatório |
| Área | `client` (Painel do Tenant) ou `admin` (Painel Global) — decide project, pasta e sessão | inferir da spec (§ "Ambiente") |
| Arquivo alvo | `e2e/tests/<área>/<assunto>.spec.ts` | derivar do assunto de tela |
| Ambiente | Stack **já no ar** (Sail + Vite). `e2e/scripts/start-stack.sh` só com confirmação explícita: ele sobrescreve `api/.env` e roda `migrate:fresh` | reusar o que existe |

## Saídas

- `e2e/tests/<área>/<assunto>.spec.ts` — committável, rodando verde.
- **Tabela de triagem** CA → (Pest | E2E | ambos) com justificativa de uma linha por CA.
- Resumo final CA → caso → status, pendências de massa e o comando de captura do dossiê.

## Fontes cruzadas (nunca adivinhar)

| O que | Fonte real |
|---|---|
| Critérios de aceite | §5 da spec (`**CAnn — título**` + bloco Gherkin) ou o corpo do ticket GLPI |
| `data-testid` | O `.vue` do componente — ex.: `client/src/modules/families/components/referral/ReferralFormSheet.vue:636`. Nunca invente |
| Rota da tela | `client/src/router/index.ts` — o prontuário é `/app/cadastros/familias/:uuid` (**não** `/app/families/…`); abas por `?tab=` |
| Endpoint e `error_code` | `api/routes/api/client.php` + a Action/Request correspondente |
| Massa, uuids e credenciais | JSDoc no topo de `api/database/seeders/E2EProntuarioSeeder.php` — é a fonte da verdade |
| Projects e sessões | `e2e/playwright.config.ts:53-79` |

## Workflow

0. **Ler** `references/harness.md` e obter os CAs da fonte informada. Ticket: `get_ticket` da skill de
   plugin `pwdev-glpi:glpi`, extraindo os blocos `CA\d+`; se o MCP estiver fora, avisar e pedir a spec
   ou o texto colado. Sem CAs reconhecíveis, pare e diga isso.
1. **Triagem** CA → (Pest | E2E | ambos), pela heurística de `references/ca-para-caso.md`. **Mostre a
   tabela ao usuário antes de escrever qualquer código** — é onde se decide o tamanho do spec.
2. **Escolher project, pasta e arquivo** (`references/harness.md` § Projects). Reusar arquivo existente
   quando o assunto de tela já tem um; criar novo só para assunto novo.
3. **Levantar os alvos reais** no código: `data-testid` no `.vue`, rota no router, endpoints e
   `error_code` na api. Alvo sem `data-testid`: ofereça ao usuário `getByRole` estável **ou** propor o
   testid no front — nunca seletor por posição, classe ou texto frágil.
4. **Planejar a massa**: o que o seeder já garante × o que o `beforeAll` cria via API, idempotente
   (`expect([201, 409]).toContain(status)`). Dado que só o seeder cria e não existe: `test.skip` com o
   comando exato (molde `SEED_HINT`) ou asserção que falha com a dica (molde `seedHint(slug)`).
   **Nunca** edite `E2ESeeder`/`E2EProntuarioSeeder` — é massa compartilhada.
5. **Escrever o spec** pelo molde (`references/moldes.md`): JSDoc dizendo *o que este spec prova e que
   nenhum teste de backend prova*, blocos `⚠️ HARNESS` e `⚠️ ESTADO`, `test.use({ locale: 'pt-BR' })`,
   serial quando o estado persiste, `dismissPlatformUpdates` após cada `goto`, asserção dupla (tela + API).
6. **Rodar e iterar até verde**: `cd e2e && npx playwright test tests/<área>/<assunto>.spec.ts`. Isolar
   com `-g "CA01"`; investigar com `--headed` ou `--debug=cli`. Corrigir e repetir — entregar spec
   vermelho não é entrega.
7. **Rodar a vizinhança**: `npx playwright test tests/<pasta>` para provar que o spec novo não quebrou
   os irmãos por massa compartilhada.
8. **Entregar**: tabela CA→caso→status, o que ficou para o Pest, pendências declaradas e o comando do
   dossiê (`CAPTURE_EVIDENCE=1 npx playwright test …`). **Não** commitar, **não** gerar o dossiê.

## Gotchas (aprendidos — críticos)

- **Throttle de 6 logins/min** (`api/routes/api/auth-client.php:19`): o project já entrega `page`
  autenticado — **nunca** logue por caso. Outro perfil: `loginAsTenantUser` (`e2e/fixtures/tenant-auth.ts:106`).
- **Modal "Novidades da versão"** abre segundos após a navegação e põe `aria-hidden` no fundo, cegando
  todo `getByRole` (`e2e/helpers/platform-updates.ts:3`). Chame `dismissPlatformUpdates(page)` após cada
  `goto` — specs que passam sem isso passam **por corrida**.
- **`locale: 'pt-BR'` não é cosmético**: as mensagens 409/422 que a tela exibe vêm do backend por
  `Accept-Language`. Sem isso o toast sai em inglês e a regex falha.
- **Nunca fixe uuid gerado pelo seeder** — o estável é o `code`; resolva o uuid por API no `beforeAll`.
- **Ausência se assevera com `toHaveCount(0)`**, nunca com "não encontrei".
- **Espere rede com `waitForResponse` encadeado ANTES da ação**, nunca `waitForTimeout`.
- **Ordem de preenchimento importa**: em formulários encadeados (data → unidade → código → destino),
  inverter a ordem esvazia o select seguinte e o teste passa a medir outra coisa.
- **Massa compartilhada**: leia o baseline pela API e assevere **deltas** (molde `capacitation-tallies`).
  Não ponha massa nova numa família que outro spec usa — em 2026-09 isso quebrou o cenário de
  desligamento da US-ACOMP-03.
- **Modo mock** (`VITE_API_URL` vazio) autentica qualquer CPF: a suíte ficaria verde testando mentira.
  Confirme que o front aponta para a API real antes de confiar no verde.

## Verificação rápida

```bash
cd e2e
npx playwright test tests/<área>/<assunto>.spec.ts     # o spec novo passa
npx playwright test tests/<área>/<assunto>.spec.ts -g "CA01"   # caso isolado
npx playwright test tests/<pasta>                      # vizinhança intacta
npx playwright test --list | grep "<assunto>"          # entrou na suíte
```

- [ ] Um `test()` por CA triado como E2E, titulado `CA01 — …` (ou `CA02/CA03 — …`).
- [ ] Tabela de triagem entregue, com os CAs de backend nomeando o teste Pest correspondente.
- [ ] Massa via API idempotente; nenhum seeder tocado.
- [ ] `dismissPlatformUpdates` após cada `goto`; `locale: 'pt-BR'` no describe.
- [ ] Nenhum `waitForTimeout`; nenhum uuid de seeder fixado no arquivo.
- [ ] Spec verde e vizinhança verde, com o número de testes no relato.

## Proibições

- **Nunca** editar `E2ESeeder`/`E2EProntuarioSeeder` nem qualquer arquivo dos submódulos para fazer o
  teste passar — declare a pendência.
- **Nunca** rodar `e2e/scripts/start-stack.sh` ou `npm run e2e:local` sem confirmação explícita: eles
  sobrescrevem `api/.env` e destroem o banco de desenvolvimento.
- **Nunca** ler ou listar `.env*` (bloqueado por hook de segredos) — use os `.example` documentados.
- **Nunca** importar código de `api/`, `admin/` ou `client/`: o E2E é cliente HTTP externo.
- **Nunca** commitar, pushar ou gerar o dossiê — o dossiê é da `acceptance-evidence-report`.
- **Nunca** marcar como verde um spec que não rodou.

## Como invocar

- "Escreve os testes E2E do chamado #10888."
- "Cria o spec Playwright dos critérios de aceite da US-ACOMP-06."
- "Automatiza no Playwright os CAs que dá para provar pela tela dessa HU."
