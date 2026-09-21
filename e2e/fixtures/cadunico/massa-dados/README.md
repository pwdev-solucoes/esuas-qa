# Massa de dados — Importação CadÚnico (HU #9748 + fluxo completo)

Conjunto de fixtures **sintéticas** para os **testes manuais/de aceite** da importação do CadÚnico.
Cobre a validação prévia (HU #9748: CA01–CA03) e, encadeando as duas remessas, o ciclo de
sincronização (criação / atualização por data / ignorado / desvínculo / erros).

> **LGPD (RN09):** todos os CPF/NIS são **fictícios mas com dígito verificador válido**; nomes são
> inventados. **Nenhum dado real de cidadão.** Não use em produção. Regenere com `gerar-massa.py`.
>
> **Diferença para as fixtures automatizadas** (`e2e/fixtures/cadunico/*.csv`): aquelas são mínimas
> (header reduzido, 1 família) e são consumidas pelos specs Playwright/Pest — **não as altere**.
> Esta pasta usa o **layout oficial completo** (colunas `d.*` família + `p.*` pessoa) para exercer
> o snapshot socioeconômico na Etapa 2 durante o teste manual.

## Ambiente esperado

- Tenant com **endereço oficial em Fortaleza/CE — IBGE `2304400`** (a guarda `assertSameMunicipality`
  exige que o município do arquivo case com o do tenant). É o município do `E2ESeeder`.
- Layout: **1 linha por membro**; as colunas de família (`d.*`) repetem nas linhas do mesmo bloco; o
  ingest deduplica a família por `cod_familiar_fam`. Delimitador `;`, UTF-8.

## Arquivos

| Arquivo | Cenário | CA / RN |
|---|---|---|
| `massa-cadunico-remessa1.csv` | **1ª remessa** — 11 famílias inéditas + 2 blocos com erro (ver abaixo) | CA01/CA04/CA08 · RN01/RN03/RN06/RN07 |
| `massa-cadunico-remessa2.csv` | **2ª remessa** (rodar **após** sincronizar a remessa1) — atualização/ignorado/alt-key + 1 inédita | CA05/CA06/CA04 · RN02/RN03 |
| `massa-cadunico-municipio-divergente.csv` | header válido, `cd_ibge` de São Paulo (`3550308`) → rejeitado na prévia | CA02 · RN01 |
| `massa-cadunico-cabecalho-invalido.csv` | colunas fora do layout oficial → rejeitado na prévia | CA02 · RN01/RN06 |
| `massa-cadunico-formato-invalido.pdf` | arquivo **não-CSV** → rejeitado na prévia | CA02 · RN01 |
| `gerar-massa.py` | gerador determinístico (CPF/NIS com DV válido) — `python3 gerar-massa.py` | — |

### Blocos da remessa1

| Cód. familiar | Bloco | Resultado esperado na sync |
|---|---|---|
| `1600000001` | RF + cônjuge + 2 filhos (PBF, parda) | criada (CA04) |
| `1600000002` | unipessoal idoso c/ deficiência | criada |
| `1600000003` | família **indígena** rural | criada |
| `1600000004` | **quilombola**, RF em situação de rua | criada |
| `1600000005`–`1600000008` | RF unipessoal (variações raça/cor, grau) | criadas |
| `1600000009` | RF + 2 filhos (IGOR, BRUNO) | criada — **alvo de update na remessa2** |
| `1600000010` | RF unipessoal | criada — **alvo de ignorado na remessa2** |
| `1600000011` | RF unipessoal (NIS do RF reusado na remessa2) | criada — **alvo de alt-key na remessa2** |
| _(vazio)_ | bloco **sem Código Familiar** | **erro** `missing_family_code` (CA08/RN07) |
| `1600000012` | `dat_atual_fam` inválida (`XX/XX/XXXX`) | **erro** `invalid_date` (CA08/RN07) |

### Blocos da remessa2 (sobre a base já importada)

| Cód. familiar | Mudança | Resultado esperado |
|---|---|---|
| `1600000009` | `dat_atual_fam` **maior** (2026-06-15); **BRUNO ausente** | **atualizada** (CA05); BRUNO **desvinculado** (`status=unlinked`), nunca excluído (RN02) |
| `1600000010` | `dat_atual_fam` **menor** (2026-01-10) | **ignorada** por sincronização (CA06) |
| `1600099911` | **código novo**, mas **mesmo NIS do RF** da `…011`, data maior | casada por **NIS** (RN03) e **atualizada** |
| `1600000013` | família nova | **criada** (CA04) |

## Roteiro do teste manual

1. Configure/confirme o tenant em **Fortaleza/2304400** e logue como **Master** (ou Operador com a
   permissão `cadunico-imports.*`).
2. **CA01:** importe `massa-cadunico-remessa1.csv` → a prévia valida e o botão **"Confirmar"** habilita.
3. **CA02:** tente `massa-cadunico-cabecalho-invalido.csv`, `…-municipio-divergente.csv` e
   `…-formato-invalido.pdf` → cada um é **rejeitado** com mensagem clara (sem criar lote).
4. **CA03:** logue como Operador **sem** a permissão → o módulo "Importações do CadÚnico" não aparece.
5. Confirme a remessa1, **sincronize** e confira os contadores: **11 criadas, 2 linhas com erro**.
6. Importe e sincronize `massa-cadunico-remessa2.csv` → confira **1 atualizada** (`…009`),
   **1 ignorada** (`…010`), **1 atualizada por NIS** (`…011`→`…99911`), **1 criada** (`…013`), e o
   membro **BRUNO desvinculado** (não excluído) na família `…009`.

> **`gerar-massa.py` cobre o ciclo de sincronização** (criação/atualização/ignorado/desvínculo/alt-key)
> de **um** município. É independente da massa geo abaixo.

---

## Massa GEO — Maceió (2704302) + Arapiraca (2700300) para o Painel de Georreferenciamento

Trilha separada, **gerada por comandos artisan no `api/`** (não pelo `gerar-massa.py`), para exercitar
**todas as buscas** do módulo `/georreferenciamento` do `client` com **12 famílias por cidade** e
**endereços reais** vindos da base DNE.

### Por que não basta importar o CSV

A importação do CadÚnico grava o endereço só como **texto** — **não geocodifica** (docblock
`AddressLocalizationChecker`: *"geocodificação deferida"*). O painel só plota famílias com um ponto
ativo em `addresses_geometries`, e a **busca por setor** exige `census_sectors` do município. Por isso a
trilha tem uma etapa de **ponte geo** após o import.

### Pré-requisitos

1. **Base DNE de AL importada + sincronizada** em `/dne-imports` (popula `postal_codes` com os CEPs
   reais de Maceió/Arapiraca). Sem isso o gerador aborta com mensagem clara.
2. **Setores + geometrias municipais** e **dois tenants** (um por município), via seeder:
   ```bash
   cd api && php artisan db:seed --class=Database\\Seeders\\CadunicoGeoMassSeeder
   ```
   Cria `city_geometries` (Maceió+Arapiraca), `census_sectors` de **Maceió** (GeoJSON CD2022 real —
   Arapiraca cobre só vulnerabilidade/heatmap/atualização, sem busca por setor) e os tenants
   `Master <cidade>` (papel `master` + `geo_panel_viewer`).

### Passos

```bash
cd api
# 1. Gera os 2 CSVs (12 famílias/cidade) + massa-geo-coords.json
php artisan cadunico:massa-geo:gerar          # saída: storage/app/cadunico-massa-geo/
# 2. No client (/cadunico-imports): logue como Master de MACEIÓ, importe
#    massa-cadunico-maceio.csv (validar → confirmar → SINCRONIZAR → 12 criadas).
#    Repita como Master de ARAPIRACA com massa-cadunico-arapiraca.csv.
# 3. Geocodifica as famílias sincronizadas (grava addresses_geometries)
php artisan cadunico:massa-geo:habilitar
```

> `assertSameMunicipality` exige que o **IBGE do arquivo == IBGE do tenant** — por isso são dois CSVs e
> dois tenants; cada CSV só entra no tenant do seu município.

### Matriz das 12 famílias (por cidade) × buscas do painel

| Filtro do painel | Famílias que batem |
|---|---|
| `extreme_poverty` (renda ≤ R$218) | F01, F03, F04, F05, F08, F11 |
| `single_person` | F02, F04, F05, F07, F11, F12 |
| `receives_pbf` | F01, F03, F04, F06, F08 |
| `child_labor` | F03, F08 |
| `homeless_situation` | F04, F10 |
| `has_disability` | F02, F08 |
| `indigenous_quilombola` | F03, F04, F11 |
| `gpte` (grupo tradicional) | F05 (cigana), F09 (agricultores) |
| `update_status = expired` (>24m) | F02, F06, F10 |
| `update_status = expiring` (19–24m) | F03, F07, F11 |
| **Busca por setor** (só Maceió) | 1 família por setor (12 setores distintos) |
| Contador RN07 (endereço inconsistente) | F12 (CEP `99999999`) |

Combinações para o AND estrito (RN18): p.ex. `extreme_poverty` + `receives_pbf` (F01, F08);
`single_person` + `expiring` (F07, F11); `indigenous` + `child_labor` + `extreme_poverty` (F03).

### Validação no painel

Logue como Master/`geo_panel_viewer` de **Maceió** em `/georreferenciamento`: o mapa centraliza em
Maceió, a camada de setores aparece, a **busca por setor** devolve a família daquele setor, cada
**filtro de vulnerabilidade** e **status de atualização** retorna ≥1 família, o heatmap/legenda renderiza
e o contador de endereço inconsistente mostra a F12. Repita no tenant **Arapiraca** (sem busca por
setor). Testes automatizados: `cd api && php artisan test --filter=CadunicoGeoMass`.

---

## Massa GEO extra — Arapiraca 32 pessoas (F13–F24)

Massa **estática adicional** só para Arapiraca (fixtures neste diretório, sem comando artisan):
`massa-cadunico-arapiraca-32.csv` (12 famílias **F13–F24**, `cod_familiar_fam`
`270030000013..24`, **32 pessoas**) + `massa-geo-coords-arapiraca-32.json`. **Convive** com a
massa original: códigos de família, CPFs (base `120000101+`) e NIS (base `1620000101+`) em faixas
novas — importar as duas no mesmo tenant soma **24 famílias / 53 pessoas**. Endereços reais do DNE
(CEPs de rua do Centro de Arapiraca); coordenadas em grade 4×3 deslocada +0.006° da grade original.

### Uso

```bash
# 1. No client (/cadunico-imports), como Master de ARAPIRACA:
#    importe e2e/fixtures/cadunico/massa-dados/massa-cadunico-arapiraca-32.csv
#    (validar → confirmar → SINCRONIZAR → 12 criadas / 32 analisadas).
# 2. Geocodifica as 12 famílias novas:
cd api
cp ../e2e/fixtures/cadunico/massa-dados/massa-geo-coords-arapiraca-32.json storage/app/cadunico-massa-geo/
php artisan cadunico:massa-geo:habilitar --coords=storage/app/cadunico-massa-geo/massa-geo-coords-arapiraca-32.json
```

### Matriz das 12 famílias (Σ 32 pessoas) × buscas do painel

| Filtro do painel | Famílias que batem |
|---|---|
| `extreme_poverty` (per capita ≤ R$218) | F13 (4p), F14 (1p), F22 (4p) |
| `single_person` | F14, F21 |
| `receives_pbf` | F18 (4p), F22 |
| `child_labor` | F15 (3p), F22 |
| `homeless_situation` | F16 (2p) |
| `has_disability` | F17 (3p), F21 |
| `indigenous_quilombola` | F19 (quilombola, 2p), F20 (indígena, 3p) |
| `update_status = expired` (>24m) | F14, F18, F21 |
| `update_status = expiring` (19–24m) | F15, F20 |
| Sem vulnerabilidade (controle) | F23 (3p, renda média) |
| Contador RN07 (endereço inconsistente) | F24 (2p, CEP `99999999`) |
