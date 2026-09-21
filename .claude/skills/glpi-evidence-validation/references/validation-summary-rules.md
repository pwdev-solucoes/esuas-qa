# Regras do texto de solicitação de validação

O `comment_submission` do `request_ticket_validation` segue regras estritas de formato, validadas com
o usuário nesta mesma conversa (ticket #10139).

## Regras

1. **Texto corrido, sem marcação.** Nada de HTML (`<p>`, `<strong>`, `<code>`) e nada de Markdown
   (sem `**negrito**`, sem `-` de lista, sem crases). Só prosa em parágrafo único ou poucos parágrafos.
2. **Sem referências técnicas.** Não citar caminhos de arquivo, nomes de componente/classe/função,
   nomes de branch ou de commit. O validador (normalmente um PO, não um dev) não precisa saber onde o
   código mudou — precisa saber **o que foi verificado**.
3. **Descrever a execução dos critérios de aceite em prosa**, um após o outro, na ordem do ticket:
   o que cada critério pedia e o que foi constatado ao verificar. Fechar com uma frase de resultado
   geral e o pedido de validação.
4. **Mencionar que o relatório de evidências está anexado em PDF** (sem citar o nome do arquivo),
   sempre no fim, antes do pedido de validação.
5. **Fechar pedindo a validação explicitamente** ("Solicito validação para prosseguir com..." ou
   equivalente).

## Exemplo real (ticket #10139 — Reorganização dos menus do Client)

> A reorganização dos menus do Client foi concluída e verificada em todos os cinco critérios de
> aceite. A estrutura do menu lateral foi comparada com a proposta aprovada e a ordem dos grupos, a
> ordem dos itens dentro de cada grupo e os rótulos correspondem exatamente ao que foi definido. A
> definição do menu foi extraída para um componente próprio, seguindo o mesmo padrão já usado no
> Admin, e a estrutura antiga que ficou obsoleta foi removida. Foi verificado que nenhuma rota de
> navegação ficou órfã: todo item navegável tem entrada no menu ou está declarado como
> intencionalmente fora dele. As permissões de acesso foram preservadas, de forma que um profissional
> sem permissão para um item que foi movido continua sem enxergá-lo após a reorganização. O bloco de
> código morto referente à gestão de usuário, que estava apenas comentado, foi removido. Todos os
> critérios foram evidenciados, um deles por captura de tela do menu renderizado e os demais por meio
> de testes automatizados, com resultado integralmente aprovado. O relatório de evidências está
> anexado em PDF. Solicito validação para prosseguir com o fechamento do chamado.

Note como cada frase corresponde a um CA do ticket (estrutura, extração do componente, rotas
órfãs, permissões, código morto) sem citar `sidebar-menu.ts`, `MenuGroup`, nomes de teste ou branch —
apenas o que o critério pedia e o que foi confirmado.

## Mecânica de anexar e vincular (não duplicada aqui)

A sequência de tools MCP para upload/vínculo de documento (`upload_document` → `link_document`) e a
convenção de entidade/solicitante padrão já estão documentadas em
`.claude/pwdev-glpi-context.md` §4 — consultar aquele arquivo para os detalhes operacionais (inclusive
a variante via `ITILFollowup`, para quando o usuário também quiser registrar um acompanhamento além da
validação).
