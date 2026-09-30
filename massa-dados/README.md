# Massa de dados fictícia (HU #10994)

Município de demonstração 100% fictício ("Município Demonstração SigSUAS", base Arapiraca/AL 2700300),
criado pela API por um executor que vive neste repositório. Já existem os **insumos determinísticos**
(plano 02) e a **infraestrutura do executor** (plano 03: preflight, trava de produção, reset, DNE,
HTTP por papel). As etapas de negócio E1–E20 chegam nos planos 04–06.

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

- `TODO(E11)`: o catálogo só tem trânsito interno CRAS↔CREAS (códigos 13/14). O encaminhamento de
  F-ENC para o CRAS Sul (CA09) sai do CREAS pela P4 com o código 14; confirmar no ambiente.
- `TODO(E4)`: o logradouro das unidades é resolvido a partir do DNE importado em E1b.
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
npm run massa:insumos:verificar                 # testes unitários/integração (project massa-insumos)
```

Sequência de `npm run massa` (Node puro até o reset; nenhuma fixture do Playwright roda antes):

1. **Preflight** (1ª checagem de `/api/environment`) — qualquer ✖ aborta, nada apagado.
2. **Aviso de apagamento** — com terminal, digite o nome do ambiente; sem terminal (CI) exige
   `--confirmar-apagamento`.
3. **Trava de produção, 2ª checagem** imediatamente antes do reset. `production`/`prod`, valor fora da
   allowlist, timeout, HTTP ≠ 200, JSON inválido ou chave ausente → "Geração recusada: … Nenhum
   registro foi criado." e código ≠ 0.
4. **Reset**: `MASSA_RESET_CMD` → `queue:restart` → `MASSA_CACHE_CLEAR_CMD`; código ≠ 0 aborta.
5. **DNE**: baixa para `.cache/dne/<sha>.zip`, confere `MASSA_DNE_SHA256`, reaproveita o cache.
6. **Etapas** (`playwright test --project=massa-dados`), uma por vez; falha numa etapa marca as
   seguintes como `nao_executada`. `--ate=Exx` nunca pula preflight nem reset.

Opções: `--evidencias` | `--sem-evidencias` (sem nenhuma, pergunta no terminal; sem terminal é
obrigatório), `--confirmar-apagamento`, `--ate=Exx`. O estado da execução fica em
`.cache/execucoes/<id>.json` (sem senhas, tokens ou cookies).

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
estado). Serve só para iterar: a prova é sempre a execução completa a partir do reset.
