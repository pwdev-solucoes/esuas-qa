# `manifest.json` — schema consumido por `scripts/generate_report.py`

O gerador lê um único JSON e emite `relatorio.html`. **Caminhos de `images` e `appendix.file` são
relativos ao `--out` (output_dir)** — geralmente `screenshots/<arquivo>.png` e `<suite>.txt`.

## Estrutura

```jsonc
{
  "meta": {
    "title": "Relatório de Critérios de Aceite — <Feature>",
    "subtitle": "Sprint X · HU.. · Evidências end-to-end no client",
    "rows": [                          // grade de metadados da capa (label, valor)
      ["Gerado em", "27/06/2026 19:00"],
      ["Branch", "sprint8-cadunico"],
      ["Spec", ".planning/specs/.../arquivo.md"],
      ["Ambiente", "API Sail/PostgreSQL · fila cadunico · client :5174"],
      ["Organização (tenant)", "E2E CadÚnico · IBGE 2304400"],
      ["Ferramenta", "playwright-cli (Chromium) + Pest"]
    ]
  },
  "summary": "Parágrafo curto: quantos CAs, quantos por navegador/automatizado, resultado geral.",
  "cas": [
    {
      "id": "CA01",
      "title": "Sucesso na validação inicial (HU01)",
      "status": "nav",               // nav | auto | parc | fail
      "gherkin": "Dado que... quando... então...",   // copiar da spec §5
      "steps_html": "Texto dos passos. Pode conter HTML simples, ex.: <code>cadunico-valido.csv</code>.",
      "results": [                    // bullets do resultado observado
        "O sistema exibe 'Arquivo validado' e habilita 'Confirmar importação'."
      ],
      "images": ["screenshots/ca01-validado.png"]   // [] quando status=auto
    }
  ],
  "appendix": {                       // opcional — saída da suíte automatizada
    "label": "Cobertura automatizada (Pest, --filter=Cadunico)",
    "file": "pest-cadunico.txt"
  }
}
```

## Campos

- **meta.rows**: lista de pares `[label, valor]` renderizados na capa.
- **cas[].status**: `nav` (verde, navegador), `auto` (azul, automatizado), `parc` (âmbar, ambos),
  `fail` (vermelho, não atendido).
- **cas[].steps_html**: aceita HTML inline (escapar não é aplicado aqui — use só tags simples como
  `<code>`, `<b>`). O resto (`title`, `gherkin`, `results`) é escapado automaticamente.
- **cas[].images**: 0..n PNGs. Vários prints num CA viram várias `<figure>`.
- **appendix.file**: lido relativo ao `--out`; embutido como `<pre>`.

## Exemplo mínimo

```json
{
  "meta": { "title": "Relatório — Feature X", "subtitle": "", "rows": [["Branch","main"]] },
  "summary": "1 critério, navegador.",
  "cas": [
    { "id":"CA01","title":"Faz X","status":"nav","gherkin":"Dado... então...",
      "steps_html":"Abrir tela e clicar Salvar.","results":["Mensagem de sucesso."],
      "images":["screenshots/ca01.png"] }
  ]
}
```

## Dica

Para gerar o manifest, é prático montar a lista de CAs em Python/JS (copiando o Gherkin da spec §5) e
escrever o JSON — depois chamar `generate_report.py`. O do CadÚnico fica em
`e2e/reports/cadunico-acceptance/` como referência (se preservado).

## `notes` (opcional)

Observações, ressalvas e achados que não pertencem a nenhum CA específico —
decisões de negócio provisórias, achados de ambiente, defeitos encontrados
durante a captura, limitações da massa de evidência.

```json
"notes": [
  { "title": "Título curto da ressalva", "html": "<p>Corpo em HTML.</p>" }
]
```

Renderizadas sob o título **“Observações e ressalvas”**, entre as seções dos CAs
e o anexo da suíte automatizada. Use para tudo que o PO precisa saber ao ler o
dossiê mas que não é o resultado de um critério.
