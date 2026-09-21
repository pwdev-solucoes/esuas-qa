---
name: acceptance-evidence-report
description: >-
  Gera um relatório de EVIDÊNCIAS dos Critérios de Aceite (CA) de uma feature do eSUAS dirigindo
  o app real com a skill playwright-cli — o Painel do Tenant (client) ou o Painel de Administração
  Global (admin), conforme a entrada `app`. Captura screenshots por CA, roda
  a suíte automatizada (Pest) para os critérios de backend, e monta um relatório HTML + PDF. Use
  sempre que o usuário pedir "relatório de evidência/aceite", "prova visual dos critérios",
  "screenshots/prints das telas dos CAs", "PDF das evidências de teste", "rodar os critérios de
  aceite com playwright e gerar relatório", ou "documentar a verificação dos critérios de aceite"
  de uma HU/feature do eSUAS. Específica do eSUAS (stack Sail + Vite + E2ESeeder).
type: workflow
---

# Relatório de evidências de Critérios de Aceite (eSUAS)

Transforma os Critérios de Aceite de uma spec do eSUAS em um **dossiê de evidências**: dirige o
**frontend client** no navegador (via `playwright-cli`), tira um print por CA, complementa com a
suíte **Pest** para os CAs que só existem no backend, e empacota tudo em **`relatorio.html`** +
**`relatorio.pdf`**. É a versão reutilizável do que foi feito para o CadÚnico (`e2e/reports/cadunico-acceptance/`).

> Detalhe operacional (comandos reais, login, gotchas): **`references/esuas-runbook.md`**.
> Formato do `manifest.json` consumido pelo gerador: **`references/manifest-schema.md`**.
>
> **Não confundir com [`e2e-testing`](../e2e-testing/SKILL.md):** aquela skill é para **escrever specs Playwright
> committed** (CI, em `e2e/`); esta dirige o app **ao vivo** para produzir o **dossiê HTML/PDF de aceite**.
>
> **Atalho quando o spec já existe:** se os CAs desta HU já viraram casos com título `CAnn — …`, rode
> `CAPTURE_EVIDENCE=1 npx playwright test <spec>` e os prints caem prontos em
> `e2e/reports/<slug>-acceptance/screenshots/`, nomeados por critério (`e2e/helpers/evidence.ts`) — sem
> condução manual do navegador. A imagem sai do caso que passou: se a asserção cai, não há print.
>
> Para fechar o ciclo no GLPI (comparar este dossiê com os CAs de um ticket e pedir validação do PO), ver
> [`glpi-evidence-validation`](../glpi-evidence-validation/SKILL.md) — ela invoca esta skill quando o
> dossiê ainda não existe.

## Entradas

| Entrada | Descrição | Default |
|---|---|---|
| `spec` | `.md` da spec eSUAS com o bloco Gherkin dos CAs (§5, CA01..CAnn). Fonte da verdade dos critérios. | obrigatório |
| `feature_slug` | Identifica a feature: nomeia o output, a **fila do worker** e a pasta de fixtures `e2e/fixtures/<slug>/`. | obrigatório |
| `automated_suite` | Comando Pest que cobre os CAs de backend (ex.: `php artisan test --filter=Cadunico`). Vira apêndice. | opcional |
| `output_dir` | Pasta de saída. | `e2e/reports/<feature_slug>-acceptance/` |
| `app` | Qual frontend dirigir: **`client`** (Painel do Tenant) ou **`admin`** (Painel de Administração Global). Muda porta, login e gates — ver §"Qual painel dirigir". | `client` |
| Ambiente eSUAS | Stack Sail **no ar** (container `api-laravel.test-1`), o frontend do `app` escolhido **não-mock**, `E2ESeeder` aplicado, **worker da fila da feature** rodando. Ver runbook. | — |

### Qual painel dirigir (`app`)

A HU diz qual é. Se a spec tem **"Ambiente: Painel de Administração Global"** ou os perfis são
`ADMIN`/`ADMIN_OPERADOR` (guard `manager`), use `app: admin`. Se são `CLIENT_ADMIN`/`CLIENT_OPERADOR`
(guard `client`), use `app: client`. Uma fase pode exigir **os dois** — nesse caso gere **um dossiê por
HU**, cada um com o seu `app`.

| | `client` — Painel do Tenant | `admin` — Painel Global |
|---|---|---|
| Porta | **descubra** (frequentemente `:5175`) | **descubra** (frequentemente `:5174`) |
| Login | `/auth/login` | `/auth/login` (mesma rota Vue) |
| Endpoint de auth | `client/auth/login` | `manager/auth/login` |
| Credenciais (LocalDevSeeder) | master `52998224725` · operador `11144477735` | Administrador **`62017490555`** · Operacional Global **`73128501629`** |
| Senha | `senha123` | `senha123` |
| Gate de tenant | **sim** — `/auth/select-tenant` quando o usuário tem vários vínculos | **não existe** — o Super Admin não tem tenant |
| Gate LGPD | `/legal-acceptance` | `/legal-acceptance` (escopo `global_admin`) |
| Perfil "restrito" a evidenciar | operador sem add-on ⇒ `/403` ou módulo ausente | Operacional Global ⇒ ação de escrita ausente |

⚠️ **O gate `/auth/select-tenant` NÃO aparece no `admin`.** Esperar por ele trava o dossiê do Painel
Global — o fluxo vai direto do login para `/app`, eventualmente passando pelo aceite legal.

### ⚠️ DESCUBRA a porta — nunca a assuma

**`:5174` não é sempre o client, e `:5173` não é sempre o admin.** O Vite pega a primeira porta livre
a partir de `:5173`, e o container do Sail (OrbStack) costuma ocupar a `:5173` — o que empurra o
admin para `:5174` e o client para `:5175`. Navegar na porta errada leva você a **fotografar o painel
errado** e só perceber no fim.

Antes de abrir o navegador, descubra quem é quem pelo **diretório do processo**, não pelo número:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':517[0-9]' | awk '{print $1, $2}' | sort -u
# para cada PID node:
lsof -a -p <PID> -d cwd -Fn | grep '^n' | sed 's/^n//'   # → .../admin ou .../client
```

Confirme ainda pelo `<title>` da página: **`SigSuas · Sistema Integrado de Gestão do SUAS`** = admin;
**`eSUAS · Tenant`** = client.

**Se o frontend já estiver no ar, USE-O e não o derrube no teardown** — ele não é seu. Só suba um
(`cd admin && npm run dev` / `cd client && npm run dev`) se nada estiver rodando, e aí sim encerre-o
no fim.

⚠️ Quando o Vite sobe **fora** da faixa `:5173`–`:5175`, o Sanctum stateful devolve **200 no login e
401 na chamada seguinte** — o sintoma engana, e a causa é a porta.

⚠️ **HU de domínio fechado** (cadastro sem criar/editar/excluir): a evidência do CA é a **ausência** da
ação. Capture a tela mostrando que o botão não existe — e diga isso na legenda do print, porque um
screenshot de tabela sem botão, sem legenda, não prova nada a quem lê.

## Saídas

- `<output_dir>/screenshots/<caNN>-<slug>.png` — um ou mais prints por CA dirigido no navegador.
- `<output_dir>/relatorio.html` — capa + tabela-resumo (CA → status) + 1 seção por CA (Gherkin, passos,
  prints, resultado) + apêndice da suíte automatizada.
- `<output_dir>/relatorio.pdf` — A4, `printBackground`, imagens embutidas.
- `<output_dir>/<suite>.txt` — saída crua da suíte Pest (apêndice), quando houver.

## Pré-requisito de ambiente (eSUAS)

1. **Reuse a stack que já estiver no ar.** O eSUAS roda via Sail (`docker ps` mostra `api-laravel.test-1`
   servindo a API em `http://localhost` e o client em `:5174`). **Não suba outra stack nem edite `.env`**
   se ela já existe — apenas use. Só configure do zero se nada estiver rodando (ver runbook).
2. **Migrations + dados**: `docker exec api-laravel.test-1 php artisan migrate --force` (aditivo) e
   `… db:seed --class='Database\Seeders\E2ESeeder' --force` + `… permissions:sync`. O `E2ESeeder` cria
   tenant Ativo + **master** (`52998224725`/`senha123`) + **operador** (`11144477735`/`senha123`) +
   município. Idempotente.
3. **Worker da fila da feature**: o worker padrão do eSUAS cobre `high,default,low,dne` — jobs em filas
   próprias (ex.: `cadunico`) **não** processam. Suba um em background:
   `docker exec api-laravel.test-1 php artisan queue:work --queue=<feature_slug> --tries=1 --timeout=600`
   e **encerre-o no teardown** (`pkill -f "queue:work --queue=<slug>"`).

## Workflow

0. **Leia** `references/esuas-runbook.md` e a `spec`. Liste os CAs (CA01..CAnn). Decida, por CA, se a
   evidência é **navegador** (UI observável), **automatizado** (lógica de backend — RN02/isolamento/etc.)
   ou **parcial** (ambos). Prepare o ambiente (acima) e as fixtures em `e2e/fixtures/<slug>/`.
1. **Invoque a skill `playwright-cli`** e abra o navegador na porta do `app` (§"Qual painel dirigir"):
   `playwright-cli open http://localhost:5174/auth/login` (client) ou
   `playwright-cli open http://localhost:5173/auth/login` (admin).
2. **Login**: `playwright-cli snapshot` → `fill` CPF/senha → clicar "Acessar Sistema". Trate os
   **gates** conforme o `app`:
   - `client` — `/auth/select-tenant` (escolher a organização) **e** `/legal-acceptance`;
   - `admin` — **só** `/legal-acceptance`; **não espere pelo select-tenant, ele não existe aqui**.

   Em ambos: `/legal-acceptance` = marcar checkbox + "Aceitar e continuar"/"Aceitar e entrar" +
   "Entrar no SigSuas". Detalhes/refs no runbook.
3. **Por CA**: `playwright-cli snapshot` (refs frescos) → agir (clicar por **role/texto**; upload via
   `run-code` `setInputFiles`) → esperar o texto-resultado → `playwright-cli screenshot --filename=<output_dir>/screenshots/<caNN>-<slug>.png`.
   Para CAs de permissão, repita o login como **operador** e evidencie a ausência do módulo / o `/403`.
4. **CAs de backend**: rode `automated_suite` salvando a saída (sem ANSI) em `<output_dir>/<suite>.txt`.
5. **Monte o `manifest.json`** (`references/manifest-schema.md`): meta (título, feature, branch, data,
   ambiente, ferramenta), `summary`, `cas[]` (id, title, status, gherkin da spec, steps_html, results[],
   images[]), e `appendix` apontando o `<suite>.txt`.
6. **Gere o HTML**: `python3 .claude/skills/acceptance-evidence-report/scripts/generate_report.py --manifest <manifest.json> --out <output_dir>`.
7. **Gere o PDF**: `node .claude/skills/acceptance-evidence-report/scripts/html_to_pdf.mjs <output_dir>/relatorio.html <output_dir>/relatorio.pdf`.
8. **Teardown**: `playwright-cli close`; pare o worker que você subiu; **não** commite nem pushe; informe
   ao usuário os caminhos dos artefatos.

## Gotchas (aprendidos — críticos)

- **Upload de arquivo**: `playwright-cli upload` exige um file-chooser aberto e falha aqui. Use
  `playwright-cli run-code "async page => { await page.locator('input[type=file]').first().setInputFiles('<abs.csv>'); }"`.
- **PDF de HTML local**: `playwright-cli goto/open file://…` retorna `about:blank`. Use o script
  `html_to_pdf.mjs` (faz `page.goto('file://…')` real + `page.pdf()`). Nunca rode `playwright-cli pdf`
  numa página que não seja o relatório — o PDF sairia da tela errada.
- **Snapshot-first**: os `refs` (e15, e30…) mudam a cada tela/reload. Sempre `snapshot` antes de agir e
  prefira **`getByRole(...)` / `getByText(...)`** (estáveis) aos refs.
- **Sheet com estado defasado**: o detalhe do lote pode mostrar contadores zerados logo após o sync.
  **Reload** + reabrir o detalhe antes do print (os dados no banco já estão corretos — confirme com
  `docker exec … tinker`).
- **Fila assíncrona**: confirme que o worker da fila da feature está processando, senão os lotes ficam
  `pending`/`Processando` e os contadores não aparecem.
- **Concorrência (RN11)**: para evidenciar "importação em andamento", injete um registro `status=processing`
  via `tinker` antes de abrir a tela; remova-o depois.

## Taxonomia de status

- **nav** (✅ navegador) — evidência por print da UI.
- **auto** (⚙️ automatizado) — coberto pela suíte Pest (apêndice); use quando o critério é regra de
  backend (RN02 criar/atualizar/ignorar, isolamento 404, gating por papel) e não há UI dedicada.
- **parc** (◑) — combinação (parte na UI, parte na suíte).

## Verificação rápida

- `generate_report.py --manifest e2e/reports/<slug>-acceptance/manifest.json --out <output_dir>` produz
  `relatorio.html` com todas as `<img>`.
- `html_to_pdf.mjs` reporta `imagens N/N` carregadas e gera um PDF > algumas centenas de KB (se < ~50 KB,
  as imagens não entraram — verifique caminhos relativos a `<output_dir>`).
