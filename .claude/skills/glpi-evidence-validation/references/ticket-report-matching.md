# Heurística de correspondência ticket → dossiê

Não existe, hoje, nenhum índice ou arquivo no repo que mapeie diretamente um número de ticket GLPI
para uma pasta de evidências. A correspondência é sempre feita por busca textual, na seguinte ordem.

## 1. Extrair candidatos a partir do título do ticket

Pegar 3–5 palavras-chave significativas do título do ticket (ignorar o prefixo `"HU - #<numero>"` e
palavras genéricas como "conforme", "proposta", "aprovada"). Exemplo: do título
"Reorganizar os menus do Client conforme a proposta aprovada", as palavras-chave úteis são
`reorganizar`, `menus`, `client`.

## 2. Buscar a story oficial

```bash
grep -ril "<palavra-chave>" .planning/product/stories/
```

`.planning/product/stories/README.md` é o índice `US-01..US-NN` com título de cada story — buscar ali
primeiro. Se achar uma story (`US-NN-<slug>.md`), esse `<slug>` é o candidato principal para os passos
seguintes.

## 3. A partir do slug, checar plano e dossiê

```bash
ls .planning/feat/features/<slug>/            # plan.md ou plan.done.md confirma que a feature existe
ls e2e/reports/ | grep -i "<slug>"             # variações de nome possíveis:
```

Variações de nome de pasta observadas no repo:
- `<slug>-acceptance` (ex.: `reorganizar-menus-client-acceptance`)
- `<slug>-<numero-da-hu>-acceptance` (ex.: `consultar-catalogo-9886-acceptance`)
- `<numero-da-hu>-acceptance` (ex.: `9885-acceptance`)

Se qualquer uma dessas pastas tiver um `manifest.json`, esse é o dossiê. **Confirmar sempre lendo o
`manifest.json`** (não basta a pasta existir — pode ser de uma feature homônima diferente).

## 4. Se nada bater por slug, buscar direto nos manifests

```bash
grep -ril "<palavra-chave>" e2e/reports/*/manifest.json
```

Os campos úteis para bater são `meta.rows` (linha "História") e o texto de `cas[].gherkin` — o
Gherkin de cada CA no manifest costuma ser cópia literal do CA da story/ticket, então uma frase inteira
do ticket normalmente aparece ali quase palavra por palavra.

## 5. Múltiplos candidatos ou nenhum

- **Múltiplos candidatos plausíveis** (ex.: duas features com nomes parecidos): listar todos ao usuário
  com o caminho completo e perguntar qual é o correto via `AskUserQuestion`. Nunca escolher
  silenciosamente pelo primeiro resultado do grep.
- **Nenhum candidato**: seguir para a geração do dossiê (Passo 3 do `SKILL.md`).

## Fallback: gerar dossiê sem story/spec formal

Quando a busca acima não encontra nenhuma story oficial (o ticket existe mas não tem
`.planning/product/stories/US-NN-*.md` correspondente), montar uma spec ad-hoc:

1. Extrair os blocos `CA01..CAnn` (título + Gherkin Dado/Quando/Então) do `content` HTML do próprio
   ticket — já lidos no Passo 1 do `SKILL.md`.
2. Escrever um `.md` temporário no diretório de scratchpad da sessão, na seção "§5 Critérios de Aceite"
   no mesmo formato Gherkin que `acceptance-evidence-report` espera como `spec`.
3. Avisar explicitamente o usuário: *"não encontrei spec oficial para esta HU — vou gerar o dossiê a
   partir dos critérios descritos no próprio ticket"* antes de invocar `acceptance-evidence-report`.

## Divergência textual entre ticket e story

Se uma story oficial for encontrada mas o texto de algum CA no ticket **não bater** com o texto
correspondente na story (ex.: reformulação, CA adicionado/removido), a story é a fonte-da-verdade para
efeito de geração de um dossiê novo — mas a divergência deve ser **reportada ao usuário**, nunca
silenciosamente ignorada, já que pode indicar que o ticket foi editado depois da spec ou vice-versa.

## Nota sobre numeração

O número de HU citado no corpo do ticket (ex.: "HU-10008") é frequentemente **diferente** do ID real do
ticket GLPI (ex.: #10139) — tickets podem ser renumerados ou o número no texto pode se referir a um
épico/HU pai. Nunca usar esse número embutido como chave de busca em `e2e/reports/` ou
`.planning/feat/features/`; usar sempre o texto/título.
