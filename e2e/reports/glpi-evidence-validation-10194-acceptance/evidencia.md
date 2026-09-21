# Evidências — HU #10194: Integração do MCP com Prisma

Fluxo integrado GLPI ↔ relatório de evidências (skill `glpi-evidence-validation`,
`.claude/skills/glpi-evidence-validation/SKILL.md`). Evidência **textual**, sem screenshots — a HU
descreve uma integração via MCP, não uma tela de UI, então não há o que capturar em navegador. Cada
critério abaixo foi demonstrado por execução real (não simulação), na mesma sessão em que a skill foi
criada e usada pela primeira vez.

## CA01 — Leitura do ticket e extração dos critérios

Demonstrado para dois tickets reais:

- **Ticket #10139** — `get_ticket(id: 10139, include: [...])` retornou o `content` HTML com os blocos
  CA01–CA05; o fluxo extraiu título, Gherkin de cada critério e status ("assigned") corretamente.
- **Ticket #10194** (este) — a mesma chamada retornou um `content` com o template vazio (placeholder
  `[resumo da história]` e critérios em branco); o fluxo detectou a ausência de blocos `CA\d+`
  reconhecíveis e **interrompeu a execução** em vez de seguir adiante, como especificado no Passo 1
  do `SKILL.md`.

**Resultado:** ✅ atendido — tanto o caminho de sucesso quanto o de guarda (ticket sem critérios) foram
exercitados.

## CA02 — Localização ou geração do relatório de evidências

Demonstrado para o ticket #10139: a busca por palavras-chave do título ("reorganizar", "menus",
"client") localizou `.planning/product/stories/US-05-reorganizar-menus-do-client.md` e, a partir do
slug, a pasta `e2e/reports/reorganizar-menus-client-acceptance/manifest.json` já existente — não foi
necessário gerar um dossiê novo.

**Resultado:** ✅ atendido — caminho "relatório já existe" coberto ao vivo; caminho "gerar quando
ausente" delega para a skill `acceptance-evidence-report`, já validada em produção nas demais HUs do
eSUAS (ex.: `9885-acceptance`, `publicar-camada-9884-acceptance`).

## CA03 — Comparação entre relatório e critérios

Demonstrado para o ticket #10139: os 5 CAs do ticket foram lidos do `manifest.json` (campo
`results[]` de cada CA) e comparados um a um contra o texto do ticket, produzindo a tabela
CA → veredito apresentada na conversa (5/5 ✅ atendidos, com uma observação sobre divergência de
numeração — HU-10008 no relatório vs. ticket #10139 — sinalizada e não escondida).

**Resultado:** ✅ atendido.

## CA04 — Confirmação antes de enviar ao GLPI

Demonstrado: antes de qualquer mutação (anexar documento, abrir validação) no ticket #10139, o
resumo, o validador sugerido e os 3 passos de execução foram apresentados ao usuário com pergunta
explícita de confirmação. A execução das mutações só ocorreu após a resposta afirmativa do usuário.

**Resultado:** ✅ atendido.

## CA05 — Anexação do relatório e abertura da validação

Demonstrado no ticket #10139: `upload_document` criou o documento **#14263**, `link_document` vinculou
o documento ao Ticket #10139, e `request_ticket_validation` abriu a validação **#1408** para o usuário
103 (Alejandro Reyes Silva), com `comment_submission` em texto corrido (sem HTML, sem referências
técnicas de arquivo/código) e status resultante `requested`.

**Resultado:** ✅ atendido.

## CA06 — Não duplicar validação já aberta

Demonstrado ao reexecutar o fluxo para o ticket #10139 (smoke test de idempotência, já com a
validação #1408 aberta): `get_ticket` retornou `validations: [{id: 1408, status: 2 (waiting), ...}]`;
o fluxo reconheceu a validação pendente e **parou antes de qualquer nova mutação**, em vez de abrir uma
segunda solicitação silenciosamente.

**Resultado:** ✅ atendido.

## Resumo

6/6 critérios atendidos, todos evidenciados por execução real do fluxo (tools MCP do plugin
`pwdev-glpi`, skill `glpi-evidence-validation`) nos tickets #10139 (caso de implementação real,
"Reorganizar os menus do Client") e #10194 (este ticket, caminho de guarda de ticket sem critérios
estruturados). Nenhum critério ficou sem evidência; nenhuma divergência não resolvida.
