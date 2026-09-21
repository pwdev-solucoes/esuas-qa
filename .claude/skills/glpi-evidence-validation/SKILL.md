---
name: glpi-evidence-validation
description: >-
  Fecha o ciclo de evidências de uma HU no GLPI: busca o ticket, localiza (ou gera, via
  acceptance-evidence-report) o dossiê de evidências dos Critérios de Aceite, compara CA a CA com o
  conteúdo do ticket, e — se tudo estiver atendido e o usuário confirmar — anexa o PDF e abre uma
  solicitação de validação (request_ticket_validation) com um resumo em texto corrido, sem HTML e sem
  referências técnicas de arquivo/código. Use quando o usuário disser "validar o ticket X no GLPI com
  as evidências", "comparar o relatório de aceite com os critérios do ticket", "enviar a validação da
  HU pro GLPI", "fechar o ciclo de evidências do chamado #XXXX", ou "anexar o dossiê e pedir validação
  do PO". Específica do eSUAS (GLPI via plugin pwdev-glpi + dossiês em e2e/reports/).
type: workflow
---

# glpi-evidence-validation — Validação de evidências no GLPI

Fecha o ciclo de uma HU já implementada: parte de um ticket GLPI, garante que existe um dossiê de
evidências dos Critérios de Aceite, confere CA a CA se o dossiê bate com o que o ticket pede e, só
então, propõe enviar o resultado para validação do PO no próprio GLPI (documento anexado + solicitação
de validação).

> Relacionado: [acceptance-evidence-report](../acceptance-evidence-report/SKILL.md) — gera o dossiê
> quando ele ainda não existe; esta skill **invoca**, nunca duplica seu workflow. Usa também a skill
> de plugin `pwdev-glpi:glpi` (tools MCP + regras ITSM) e as convenções de
> `.claude/pwdev-glpi-context.md` (entidade padrão, solicitante típico, fluxo de 3 passos para anexar
> documento).
>
> **Não confundir com `acceptance-evidence-report`:** aquela produz o PDF a partir de uma spec; esta
> parte de um **ticket GLPI**, decide se precisa chamar aquela, e depois fecha o ciclo no GLPI.

## Entradas

| Entrada | Descrição | Default |
|---|---|---|
| `ticket_id` | Número do ticket GLPI da HU a validar. | obrigatório |
| `feature_slug` / `spec` | Se o usuário já souber a pasta/spec correspondente, informar pula a busca do Passo 2. | opcional |

## Saídas

- Tabela CA → veredito impressa na conversa (comparação ticket × dossiê).
- Se confirmado pelo usuário: documento anexado ao ticket + solicitação de validação aberta.
- Resumo final com os IDs criados e o validador escolhido.

## Pré-requisitos

- Skill `pwdev-glpi:glpi` configurada (Path A do diagnóstico dela — ver `check-setup.sh` do plugin).
- Se for preciso **gerar** um dossiê no Passo 3, valem os pré-requisitos de ambiente de
  `acceptance-evidence-report` (stack Sail no ar, worker de fila da feature).

## Workflow

1. **Buscar o ticket** — `get_ticket(id, include=["followups","tasks","validations","documents"])`.
   Extrair do `content` (HTML rico) os blocos `CA01..CAnn` (título + Gherkin de cada critério) e o
   título/número de HU citado no corpo. Se `degraded: true`, avisar quais sub-recursos falharam.
   Se o `content` não tiver nenhum bloco `CA\d+` reconhecível, avisar que este ticket não é uma HU com
   critérios estruturados e parar — este fluxo não se aplica.

   **Guardrail de idempotência**: se `validations[]` já trouxer uma entrada com status
   `waiting`/`requested`, mostrar essa validação existente ao usuário e perguntar (`AskUserQuestion`)
   se quer mesmo abrir outra antes de prosseguir — nunca abrir uma segunda solicitação silenciosamente.

2. **Localizar o dossiê de evidências** — aplicar a heurística de
   `references/ticket-report-matching.md` (busca por palavras-chave do título em
   `.planning/product/stories/`, `.planning/feat/features/` e `e2e/reports/*/manifest.json`).
   - Candidato único com `manifest.json` → ir para o Passo 4.
   - Múltiplos candidatos plausíveis → perguntar ao usuário qual é o correto (`AskUserQuestion`).
   - Nenhum candidato → ir para o Passo 3.

3. **Gerar o dossiê (só se ausente)** — invocar a skill `acceptance-evidence-report` **no main loop**
   (nunca em subagente — ela dirige o navegador e produz artefatos locais, a mesma regra que
   `feature-exec-loop` já aplica). Usar como `spec` a story encontrada em `.planning/product/stories/`
   ou, na ausência de uma, os CAs extraídos do próprio ticket (fallback descrito em
   `ticket-report-matching.md`) — neste caso, avisar explicitamente o usuário que a spec usada é ad-hoc,
   montada a partir do ticket, e não um documento oficial.

4. **Comparar relatório × ticket** — ler o `manifest.json` do dossiê localizado/gerado. Para cada CA do
   ticket, confirmar que existe entrada correspondente no manifest (por `id`/`gherkin`), ler `results[]`
   e julgar o veredito: ✅ atendido, ⚠️ parcial, ou ❌ não atendido (tratar `status:"fail"` do manifest,
   quando existir, como não atendido). Sinalizar como divergência — sem travar o fluxo — qualquer CA do
   ticket sem entrada no relatório, ou vice-versa. Produzir a tabela CA → veredito para o usuário.

5. **Gate de decisão** — só se **todos** os CAs do ticket estiverem ✅ atendidos e sem divergência não
   resolvida, perguntar (`AskUserQuestion`) se o usuário quer enviar a validação para o GLPI. Caso
   contrário, parar e reportar o que falta — não seguir para os passos de mutação.

6. **Redigir o resumo** — seguir `references/validation-summary-rules.md` (texto corrido, sem HTML e
   sem referências técnicas de arquivo/componente/código — só a execução dos critérios em prosa).
   Mostrar o rascunho ao usuário e aguardar aprovação/ajuste antes de enviar — mutação só com
   confirmação, regra herdada da skill `glpi`.

7. **Perguntar o validador** — `AskUserQuestion` pedindo quem é o usuário responsável pela validação;
   sugerir como default o `users_id_recipient` do próprio ticket (mesmo padrão do solicitante típico em
   `.claude/pwdev-glpi-context.md`). Se o usuário responder com nome em vez de ID, resolver via
   `search_users` antes de prosseguir.

8. **Executar (só após confirmação)**:
   0. **Preparar o arquivo** — seguir `references/pdf-para-upload.md`: deixar o PDF abaixo de ~1,5 MB
      (comprimindo as capturas numa cópia temporária, sem tocar no dossiê) e enviá-lo com nome
      descritivo (`HU-<numero>-evidencias-<slug>.pdf`), nunca o `relatorio.pdf` genérico. Não há como
      remover anexo pelo MCP, então errar aqui custa limpeza manual no ticket.
   1. `upload_document` — `file_path` do PDF preparado, `name` descritivo, `entities_id` = entidade do
      ticket.
   2. `link_document` — `itemtype: "Ticket"`, `items_id: ticket_id` (vincula direto ao ticket; variante
      mais simples que a via `ITILFollowup` documentada em `.claude/pwdev-glpi-context.md` §4 — usar
      aquela apenas se o usuário também quiser registrar um acompanhamento).
   3. `request_ticket_validation` — `ticket_id`, `users_id_validate`, `comment_submission` = resumo
      aprovado no Passo 6.

9. **Resumo final** — reportar: ticket, dossiê usado (caminho), tabela de veredito por CA, IDs criados
   (documento, validação) e validador escolhido. **Nunca fechar o ticket aqui** — fechar é fluxo próprio
   da skill `glpi` (`close_ticket`), fora de escopo desta skill.

## Gotchas (aprendidos — críticos)

- **Numeração da HU no corpo ≠ ID do ticket.** O texto do ticket pode citar "HU-10008" enquanto o
  ticket GLPI real é #10139 — nunca assumir que os números batem; a correspondência com story/dossiê é
  por título/conteúdo, não pelo número embutido no texto.
- **`manifest.json` não tem campo booleano de aprovação.** O julgamento de "atendido" vem da leitura de
  `results[]` (prosa afirmativa) por CA, não de um único status — `nav`/`auto`/`parc` descrevem o TIPO
  de evidência, não se passou ou falhou.
- **Não há índice ticket → dossiê no repo.** A correspondência é sempre uma busca por palavras-chave
  (ver `references/ticket-report-matching.md`) — quando ambígua, perguntar ao usuário em vez de
  adivinhar.
- **Nunca definir `priority`** no `request_ticket_validation` nem em qualquer chamada — regra herdada
  da skill `glpi`, o GLPI calcula pela matriz urgency×impact.
- **PDF grande demais chega ao ticket sem servir — e o MCP não avisa.** O `upload_document` responde
  `status: "created"` de qualquer tamanho; foi o usuário quem reportou o anexo "com problema" no GLPI
  (dossiê de 2,44 MB, ticket #10617). O limite exato da instância **não foi confirmado** — não afirme
  um número ao usuário. Mantenha o arquivo abaixo de ~1,5 MB por precaução: reencodar as capturas em
  JPEG cortou 55% (2,44 MB → 1,07 MB) sem perda de leitura. Otimizar PNG rende pouco (−16%), porque o
  Chromium reencoda ao embutir. Receita e verificação em `references/pdf-para-upload.md`.
- **Reenviar anexo não substitui o anterior.** O MCP não expõe exclusão nem desvínculo de documento —
  cada reenvio soma um anexo, e a limpeza é manual na interface. Acerte tamanho e nome antes do
  primeiro `upload_document`, e ao reenviar avise o usuário que o anterior ficará no ticket. A
  validação já aberta continua valendo: o texto aprovado está nela, não no anexo — nunca abra uma
  segunda só porque o arquivo mudou.

## Verificação rápida

- Rodar para um ticket que já tem validação aberta (idempotência): deve avisar e perguntar antes de
  prosseguir, nunca abrir uma segunda solicitação sozinho.
- Rodar até o Passo 5 para um ticket com dossiê já existente e todos os CAs atendidos: a tabela de
  veredito e o resumo devem sair corretos mesmo se o usuário responder "não" no gate (nenhuma mutação
  deve ocorrer).
- Antes de qualquer `upload_document`: conferir que o PDF preparado está abaixo de ~1,5 MB, tem nome
  descritivo (não `relatorio.pdf`) e mantém todas as imagens do dossiê original.
