# pwdev-glpi — contexto

## 1. Config
Idioma: pt-BR
Instância: https://gestao.sasgp.com.br/apirest.php
PAT: Keychain (service pwdev-glpi) — local do segredo, nunca o valor
App-Token: definido em `~/.zshrc` (`GLPI_APP_TOKEN`) — não é segredo pessoal, compartilhado pela equipe

## 2. Padrões
Entidade padrão: SGQ > Gestão Operacional > MVP eSUAS (id 38)
Grupos de atendimento: nenhum — tickets desta entidade são atribuídos diretamente a um usuário (ex: Paulo Soares da Silva, id 119), não a grupo
Categorias frequentes: EXECUÇÃO > Histórias (id 606) — usada em chamados "HU - #<numero>"
Convenção urgency/impact: ambos fixados em 3 (médio) por padrão → priority resultante 3 (médio). Extraído do chamado #10147 e confirmado no #9117 (mesma entidade)
Solicitante típico: Alejandro Reyes Silva (id 103)
Tipo de requisição (requesttypes_id): 6 ("Chamado")

## 3. Observações
- Convenção de título: "HU - #<numero-da-historia> <titulo>"
- Conteúdo do chamado costuma ser HTML rico (história de usuário + critérios de aceite formatados)

## 4. Anexar documento a um acompanhamento (ITILFollowup)

O MCP (`@soarescbm/mcp-glpi` v0.2.1) **não** cobre esse fluxo — só tem `add_ticket_followup` (cria o
acompanhamento). Upload de arquivo (`POST /Document`) e vínculo (`POST /Document_Item`) precisam ser
feitos via REST cru. Referência completa: `docs/glpi/glpi-anexar-documento-acompanhamento.pdf`.

**Duas pegadinhas que a doc não cobre:**
1. Nunca inclua `items_id`/`itemtype` já no manifest de criação do `Document` — quebra silenciosamente
   (HTTP 200, corpo vazio, nada é criado). Crie o `Document` só com `name` + `_filename`, vincule depois.
2. Um `Document` novo nasce na entidade ativa da sessão (raiz, não recursiva). Se o alvo (ticket/
   acompanhamento) está em entidade diferente, o `POST /Document_Item` falha com "sem permissão".
   Corrija com `PUT /Document/{id} {"input":{"entities_id": <entidade do alvo>}}` antes de vincular.

**Fluxo correto (3 passos):**
```
1) POST /ITILFollowup  {itemtype:"Ticket", items_id:<TICKET_ID>, content:<template abaixo>}  -> FOLLOWUP_ID
2) POST /Document (multipart, manifest SEM items_id/itemtype)                                -> DOCUMENT_ID
   PUT /Document/{DOCUMENT_ID} {entities_id: <entidade do ticket>}   (se precisar corrigir entidade)
3) POST /Document_Item {documents_id:DOCUMENT_ID, itemtype:"ITILFollowup", items_id:FOLLOWUP_ID}
```
Para anexar direto no ticket em vez do acompanhamento, troque `itemtype`/`items_id` do passo 3 para
`"Ticket"` / `<TICKET_ID>`.

### Padrão de texto do acompanhamento (content, em HTML)

```html
<p><strong>{{Título curto do anexo}}</strong></p>
<p>{{1–2 frases: o que o documento contém / cobre}}</p>
<p>📎 <code>{{nome-do-arquivo.ext}}</code></p>
```

Exemplo real (ticket #10147, followup #21778):
```html
<p><strong>Dossiê de evidências — raio-atendimento-acceptance (CA15–CA18)</strong></p>
<p>Relatório de evidências dos critérios de aceite do filtro de raio de atendimento: aplicação do
filtro, desenho gráfico da área de abrangência, cruzamento cumulativo (raio + vulnerabilidades) e
limpeza do perímetro radial.</p>
<p>📎 <code>relatorio.pdf</code></p>
```
