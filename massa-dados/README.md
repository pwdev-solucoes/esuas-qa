# Massa de dados fictícia (HU #10994)

Município de demonstração 100% fictício ("Município Demonstração SigSUAS", base Arapiraca/AL 2700300),
criado pela API por um executor que vive neste repositório: insumos determinísticos (plano 02),
infraestrutura do executor (plano 03: preflight, trava de produção, reset, DNE, HTTP por papel), etapas
E1–E19 (planos 04–05) e relatório de evidências, verificações finais E20 e comparação de execuções
(plano 06). Não existe botão, tela nem permissão de gerar massa no produto (RN03/CA03).

Roadmap completo: `.planning/roadmap-massa-dados/` no meta-repo `esuas-all`.

## Insumos (`insumos/`)

| Arquivo | Origem | Conteúdo |
|---|---|---|
| `nomes-ficticios.json` | curado à mão | prenomes, sobrenomes fictícios e lista de bloqueio (RN07) |
| `elenco.json` | `scripts/elenco.ts` | organização, Master, equipe P0–P7, 60 famílias, 202 pessoas (9 sem CPF), 208 registros de 2026-06/07/08 |
| `unidades-ficticias.json` | `scripts/unidades.ts` | CRAS Norte, CRAS Sul, CREAS (MDS 13 dígitos, coordenada) |
| `entidades-ficticias.json` | `scripts/entidades.ts` | ENT-1 com CNEAS, ENT-2 sem CNEAS |
| `coordenadas-familias.json` | `scripts/coordenadas.ts` | um ponto por família (semente fixa), dentro de setor de Arapiraca |
| `geo/*.geojson` | `scripts/geo.ts` | cópias byte a byte de `docs/geojson/` (102 municípios, 41 bairros, 427 setores) |
| `esperado.json` | `scripts/esperado.ts` | números esperados por mês × unidade × contador + pendências da 10994b |
| `manifest.json` | `scripts/manifest.ts` | sha256 e contagem de cada insumo |

Regras: CPF na base `98xxxxxxx` em **sequência** (Master, P0–P7, pessoas na ordem do elenco) com DV do
`SyntheticDocument`; CNPJ na raiz `98000000`; e-mails `<papel>.<n>@demo.sigsuas.local`; nenhum sorteio
sem semente (PRNG mulberry32 com semente fixa só para coordenadas). Os `payload` dos registros usam
**chaves de negócio** (códigos de catálogo, `PES-…`, `P1`, `U-CN`); o executor as resolve em uuids.

## Comandos

```bash
npm install
npm run massa:insumos            # regenera todos os insumos (byte-idênticos a cada execução)
npm run massa:insumos:verificar  # testes unitários dos geradores e insumos (sem navegador/API)
```

Mudar a composição (RN02c): editar `scripts/` ou `nomes-ficticios.json`, rodar `massa:insumos`,
revisar o diff dos JSON e commitar. O `esperado.json` é recalculado sobre o elenco reproduzindo as
regras dos services de apuração; divergência na etapa E17 é achado (elenco errado ou regra mudou).

## Pontos em aberto

- F-ENC (CA09): o catálogo só tem trânsito interno CRAS↔CREAS (códigos 13/14); o encaminhamento para o
  CRAS Sul sai do CREAS pela P4 com o código 14 (confirmado na E11).
- O logradouro das unidades é resolvido a partir do DNE importado em E1b.
- Crianças com menos de 7 anos têm escolaridade `1`, para que só o integrante de F-ESCOL apareça
  como pendência de escolaridade (15.10).
- CadÚnico (`cadunico-demo.csv`) fica fora: decisão pendente (`MASSA_CADUNICO=false`).

## Antes de começar (checklist do preflight)

`npm run massa:verificar` confere tudo isto **sem escrever nada** (só leitura, `GET`/`HEAD` e
`docker info|inspect|top`) e imprime ✔/✖/⚠ com a instrução de cada falha. Qualquer ✖ encerra com
código ≠ 0 antes do aviso, do reset e do download. ⚠ não bloqueia.

| Família | O que confere | Se falhar |
|---|---|---|
| Configuração | `massa-dados/.env` com `API_BASE`, `ADMIN_URL`, `CLIENT_URL`, `MAILPIT_URL`, `E2E_ADMIN_CPF`, `E2E_ADMIN_PASSWORD`, `MASSA_RESET_CMD`, `MASSA_DOCKER_CONTAINERS`, `MASSA_DNE_URL`; binário do reset no PATH e container-alvo na lista | `cp massa-dados/.env.example massa-dados/.env` e preencha |
| Insumos | arquivos do `manifest.json` presentes, sha256, JSON/GeoJSON válidos, 102 municípios, elenco ≥ 55 famílias, CPFs base 98, 2 CRAS + 1 CREAS, pontos dentro dos setores, esperado 3 meses × 3 unidades | `npm run massa:insumos` ou restaure do git |
| DNE | `MASSA_DNE_URL` (URL http(s) ou arquivo local) responde `HEAD` 200 com tamanho, ou o arquivo local existe e não está vazio; formato do `MASSA_DNE_SHA256`; disco ≥ 3× o ZIP (⚠); cache em `.cache/dne/` | corrija a URL / libere espaço |
| Docker | daemon; containers `running`/`healthy`; **worker de fila com `queue:work`** (CA-T1); `SELECT postgis_version()`; MinIO | `docker start <container>` |
| Serviços | `GET {API_BASE}/up`; **`GET {API_BASE}/api/environment` ∈ {local, testing, staging}**; admin e client respondendo (portas Sanctum-stateful 5173/5174/5175); Mailpit `/api/v1/info` | suba a API / `npm run dev` / Mailpit |
| Ferramental | Node ≥ `.nvmrc`; `node_modules`; Playwright na faixa do `package.json` (⚠); chromium instalado (⚠) | `nvm use`, `npm ci`, `npx playwright install chromium` |

Armadilhas: o `client/.env` vence as variáveis do shell (a URL da API do front tem de bater com a
`API_BASE`); o Pest dentro do container apaga `esuas_e2e` — o `MASSA_RESET_CMD` precisa apontar para a
stack de desenvolvimento.

## Como rodar

```bash
cp massa-dados/.env.example massa-dados/.env   # preencha (nunca versione)
npm run massa:verificar                         # só o preflight (E00)
npm run massa -- --sem-evidencias --confirmar-apagamento            # processo completo, sem relatório
npm run massa -- --evidencias --confirmar-apagamento --ate=E0       # para após E0 (depuração)
npm run massa -- --evidencias --confirmar-apagamento              # processo completo COM relatório
npm run massa:comparar -- massa-dados/relatorios/<A> massa-dados/relatorios/<B>   # determinismo (CA04)
npm run massa:insumos:verificar                 # testes unitários/integração (project massa-insumos)
```

Uma execução completa leva ~25–30 min; ~16 min são a E01b (DNE nacional).

Sequência de `npm run massa` (Node puro até o reset; nenhuma fixture do Playwright roda antes):

1. **Preflight** (1ª checagem de `/api/environment`) — qualquer ✖ aborta, nada apagado.
2. **Aviso de apagamento** — com terminal, digite o nome do ambiente; sem terminal (CI) exige
   `--confirmar-apagamento`.
3. **Trava de produção, 2ª checagem** imediatamente antes do reset. `production`/`prod`, valor fora da
   allowlist, timeout, HTTP ≠ 200, JSON inválido ou chave ausente → "Geração recusada: … Nenhum
   registro foi criado." e código ≠ 0.
4. **Reset**: `MASSA_RESET_CMD` → `queue:restart` → `MASSA_CACHE_CLEAR_CMD`; código ≠ 0 aborta.
5. **DNE**: baixa para `.cache/dne/<sha>.zip`, confere `MASSA_DNE_SHA256`, reaproveita o cache. A
   competência enviada na importação (E01b) é fixa e versionada: `dne.competencia` do `elenco.json`
   (`DNE_COMPETENCIA` em `scripts/elenco.ts`, hoje `2026-06`, o mês do `qa/docs/baseceps.dat.zip`).
   Nunca o mês corrente (RN-T4). Trocou o arquivo do DNE? Atualize a constante e rode `npm run massa:insumos`.
6. **Etapas** (`playwright test --project=massa-dados`), uma por vez; falha numa etapa marca as
   seguintes como `nao_executada`. `--ate=Exx` nunca pula preflight nem reset. O CLI marca a execução
   com `MASSA_VIA_CLI=<id da execução>`; **as etapas só rodam pelo CLI**: a moldura `etapa()` recusa,
   antes de qualquer requisição, quando a marca falta ou é de outra execução, quando a `API_BASE` difere
   da do estado ou quando o estado não tem a 2ª checagem de `/api/environment` ok. Sem `MASSA_VIA_CLI`
   (ou `MASSA_EXECUCAO_ARQUIVO`) o project `massa-dados` nem é registrado: `npm test` não coleta as etapas.

7. **E20**: verificações finais (CA03, CA09, CA11, CA12, RN02b), `snapshot.json` e prévia do índice.
8. Com `--evidencias`, o CLI gera o relatório final (também quando uma etapa falha).

Opções: `--evidencias` | `--sem-evidencias` (sem nenhuma, pergunta no terminal; sem terminal é
obrigatório), `--confirmar-apagamento`, `--ate=Exx`. O estado da execução fica em
`.cache/execucoes/<id>.json` (sem senhas, tokens ou cookies).

## Relatório de evidências (`--evidencias`, RN-T5)

Cada execução cria uma pasta **nova** `relatorios/<AAAA-MM-DD_HHmm>/` (gitignored; se o nome já existir,
sufixo `-2`, `-3`… — execuções anteriores nunca são sobrescritas):

| Arquivo | Conteúdo |
|---|---|
| `index.html` | cabeçalho (data, ambiente, versões da API/qa, elenco, flags), etapas ✔/⚠/✖/não executada com duração e link, matriz CA01–CA13 (+CA02b, CA-T1), determinismo, composição, famílias-cenário, cenários que parecem erro, pendências propositais (esperado × apurado × onde aparecem), esperado × apurado por mês × unidade (explicadas em amarelo, sem explicação em vermelho), achados A1–A8 com decisões do PO, achados RN14 da execução e decisões pendentes |
| `etapa-XX.html` | uma por etapa (`etapa-00`, `etapa-00b` = E0, `etapa-01b`, `etapa-06a`, … `etapa-20`), inclusive as não executadas: status, papel, requisições (método, URI, HTTP, chave de negócio), passos e conferências, prints com legenda, contagens, avisos e achados |
| `screens/*.png` | prints com nome e legenda estáveis (reuso no manual), tirados por `lib/evidencia.ts` com login real pela tela — não pelo screenshot automático do Playwright |
| `dados/*.json` | evidência bruta por etapa (contagens, prints, notas) |
| `snapshot.json` | organização demo por chave de negócio + apuração completa dos 3 meses (CA04) |
| `manifest.json` | execução, ambiente, commits da API e do qa, versão do elenco, sha256 do manifest dos insumos e do DNE, flags |
| `determinismo.json` | gravado por `massa:comparar` quando esta pasta é a execução B |

Com `--sem-evidencias` não há pasta de relatório: a E20 grava só `.cache/snapshots/<id>/snapshot.json`.

Etapas instrumentadas com `Evidencia` (contagens e prints): E10, E11, E17, E19 e E20 — o padrão é o mesmo
para as demais (`new Evidencia('Exx')` → `contagem()`/`print()` → `salvar()`); as outras etapas têm as
requisições e as conferências registradas no estado e renderizadas na página.

## Verificações finais (E20)

- **CA11**: CPFs das pessoas das famílias e dos usuários da demo na base 98, DV válido, iguais ao elenco;
  sem CPF = `NULL`; a listagem de profissionais pela API (CPF mascarado) bate com a sequência.
- **CA12**: cria (idempotente) a "Organização Controle SigSUAS" pelo fluxo real (Administrador → Master →
  Operacional, senha pelo Mailpit) com uma unidade, uma entidade e uma família, porque o seed só traz
  organizações com Master. P1 → dados da Controle e operador da Controle → dados da demo devem ser negados
  sem devolver dado. **Achado:** unidade e entidade respondem **403** (a família responde 404); fica como
  achado RN14 e CA12 parcial no índice.
- **CA03**: literais (sem comentários) dos routers e `sidebar-menu.ts` do admin e do client,
  `php artisan route:list --json` e a tabela `permissions` sem "massa", "seed", "gerar-dados", "demo";
  `GET /api/environment` é a rota da trava.
- **CA09**: P2 abre F-ENC e o desfecho continua vazio (API e banco).
- **RN02b**: nome/CNPJ da organização e e-mails `@demo.sigsuas.local`.

## Determinismo (CA04)

```bash
npm run massa -- --evidencias --confirmar-apagamento     # execução A
npm run massa -- --evidencias --confirmar-apagamento     # execução B (novo reset)
npm run massa:comparar -- massa-dados/relatorios/<A> massa-dados/relatorios/<B>
```

O comparador normaliza os dois `snapshot.json` (remove `id`, `uuid`, `*_id`, `*_uuid`, `created_at`,
`updated_at`, `deleted_at` e `meta`; ordena por `chave`), compara por chave de negócio — tabelas,
apuração `mês|unidade|contador` e pendências — e sai **0** ("idênticas") ou **1** com a lista
`caminho · chave: A=… · B=…` (2 = uso/arquivo inválido). Aceita a pasta da execução ou o `snapshot.json`.
Quando B é uma pasta de relatório, grava `determinismo.json` e atualiza a seção Determinismo do índice de B.

## Segurança

- **Traces, vídeos e screenshots automáticos do Playwright são PROIBIDOS no project `massa-dados`**
  (`trace: 'off'`, `video: 'off'`, `screenshot: 'off'`). O trace grava todo `APIRequestContext` do teste
  — corpo do login (CPF e senha), tokens de redefinição, cookie e XSRF — em texto puro, sem passar pelo
  `sanitizar()`. Os passos sanitizados ficam no estado e no relatório. Há teste (`lib/infra.test.ts`)
  que falha se alguém religar.
- Nomes de container (`MASSA_DOCKER_CONTAINERS`) e o binário/container de `MASSA_RESET_CMD` e
  `MASSA_CACHE_CLEAR_CMD` precisam casar com `^[\w./-]+$`; o preflight dá ✖ antes de qualquer shell.
  Interpolação em `/bin/sh -c` só com aspas simples (`aspasShell`).
- 429 no meio da execução passa por `limparRateLimit` (`lib/reset.ts`): cache clear com código conferido
  e worker da fila religado (o `cache:clear` pode mudar a chave de restart do `queue:work`).

- Relatórios, snapshot e estado passam por `sanitizar()` (senha, token, cookie, XSRF, Bearer, segredos
  registrados) e `verificarSemSegredos()` antes de ir para o disco; nenhum `.env` é lido pelos relatórios.
- Nomes e CPFs são fictícios (RN01) e podem aparecer; relatórios servem para compartilhamento interno.
- A remessa gerada na E18 **não** é enviada ao TCE-AL (RN-T8).

Bibliotecas (`lib/`): `config` (carga do `.env` + `sanitizar()`), `preflight`, `ambiente` (trava),
`reset`, `dne`, `http` (um `APIRequestContext` por papel, Sanctum cookie + XSRF + `Origin`, retry
após cache clear em 429), `mailpit` (link de redefinição + `definirSenha`), `execucao` (estado por
etapa e mapa chave de negócio → uuid).

Variáveis do executor: ver `.env.example` (copiar para `massa-dados/.env`, gitignored).

### Retomada em desenvolvimento (`--a-partir-de`)

`npm run massa -- --sem-evidencias --a-partir-de=E10 --ate=E19` retoma a execução salva mais recente
(`.cache/execucoes/`) a partir da etapa indicada, **sem reset e sem DNE**. Só é aceita quando a execução
salva tem todas as etapas anteriores `ok`, a mesma `API_BASE` e a organização ainda existe no banco; o
preflight e a trava de produção continuam. As etapas E10–E16 pulam registros já criados (`REG_<chave>` no
estado). Serve só para iterar: a prova é sempre a execução completa a partir do reset. Com `--evidencias`
a retomada também cria uma pasta nova de relatório (o índice mostra `a-partir-de` nas flags).
`--ate` anterior a `--a-partir-de` é recusado (código 2) antes de qualquer etapa.

As asserções pós-etapas `etapas/e01-e09.check.spec.ts` (só leitura) rodam apontando o estado:
`MASSA_EXECUCAO_ARQUIVO=massa-dados/.cache/execucoes/<id>.json npx playwright test --project=massa-dados e01-e09.check`.
