# Massa de dados fictícia (HU #10994)

Município de demonstração 100% fictício ("Município Demonstração SigSUAS", base Arapiraca/AL 2700300),
criado pela API por um executor que vive neste repositório. Esta é a **versão inicial**: só os
**insumos determinísticos** (plano 02). O executor (`npm run massa`) chega nos planos 03–06.

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

Variáveis do executor: ver `.env.example` (copiar para `massa-dados/.env`, gitignored).
