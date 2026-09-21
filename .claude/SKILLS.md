# SKILLS.md

Skills disponíveis neste repositório standalone de QA, cobrindo o ciclo de evidências de teste: escrever specs E2E → gerar dossiê → validar no GLPI.

## Testes & Evidências

1. **e2e-testing** — Transforma Critérios de Aceite (CA) em specs Playwright committed em `e2e/`.
   - Path: `./.claude/skills/e2e-testing/SKILL.md`

2. **acceptance-evidence-report** — Gera dossiê HTML+PDF de evidências dirigindo o app real via `playwright-cli` + Pest.
   - Path: `./.claude/skills/acceptance-evidence-report/SKILL.md`
   - Depende de: `playwright-cli` (incluída aqui)

3. **glpi-evidence-validation** — Fecha o ciclo: busca ticket no GLPI, compara dossiê × CAs, anexa PDF e pede validação do PO.
   - Path: `./.claude/skills/glpi-evidence-validation/SKILL.md`
   - Depende de: `acceptance-evidence-report`

4. **playwright-cli** — Automação de browser Playwright para testes E2E, auditoria e debug interativo.
   - Path: `./.claude/skills/playwright-cli/SKILL.md`

## Dependências externas (não incluídas neste repo)

- **Plugin `pwdev-glpi:glpi`** — fornece as tools MCP para `glpi-evidence-validation` (get_ticket, upload_document, link_document, request_ticket_validation, search_users).
  Precisa estar instalado/configurado no ambiente Claude Code de quem for usar essa skill.
  
- **`.planning/product/stories/`** — histórias de usuário com artefatos oficiais de negócio (HUs, RNs, CAs).
  Só existe no meta-repo `esuas-meta-qa`. Rodando `qa/` isolado, `glpi-evidence-validation` cai automaticamente no fallback: monta um spec ad-hoc a partir dos CAs do próprio ticket GLPI quando não encontra a HU oficial (ver `references/ticket-report-matching.md`).

## Relações entre skills

```
e2e-testing
    ↓ (produz specs Playwright)
acceptance-evidence-report
    ├─ (consome specs via CAPTURE_EVIDENCE=1)
    └─ (produz dossiê HTML+PDF)
        ↓ (consumido por)
glpi-evidence-validation
    ↓ (valida no GLPI)
Ticket GLPI validado
```

## Convenções & contexto

- **`.claude/pwdev-glpi-context.md`** — arquivo de config/convenções GLPI (IDs de entidade, mecânica de anexação de documento). Referenciado por `glpi-evidence-validation` e `acceptance-evidence-report`.
