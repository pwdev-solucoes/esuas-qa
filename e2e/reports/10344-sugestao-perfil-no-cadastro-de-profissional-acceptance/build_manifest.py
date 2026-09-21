#!/usr/bin/env python3
"""Monta o manifest.json do dossiê de evidências da HU #10344."""
import json
import pathlib

BASE = pathlib.Path(__file__).parent

CAS = [
    {
        "id": "CA01",
        "title": "Sugestão aparece pré-marcada ao informar o CBO",
        "status": "nav",
        "gherkin": (
            "Dado que o Master está cadastrando um profissional no seu tenant e o CBO 2516-05 "
            "(Assistente social) está mapeado ao perfil \"Técnico de Referência\", quando o Master "
            "informa esse CBO, então o perfil \"Técnico de Referência\" é apresentado já marcado, junto "
            "com o posto base Operacional do Tenant, e a tela indica que a marcação veio da ocupação "
            "informada."
        ),
        "steps_html": (
            "Autenticado como <b>Master</b> no Painel do Tenant, abrir <b>Profissionais → Novo</b> e "
            "selecionar a ocupação <code>2516-05 — Assistente social</code> no combobox <b>Ocupação "
            "(CBO)</b>. A seção <b>Acesso do profissional</b> carrega a proposta via "
            "<code>GET client/professionals/role-suggestion</code>."
        ),
        "results": [
            "A seção exibe \"Proposta a partir da ocupação 2516-05. Você pode desmarcar ou ajustar antes de salvar.\" — a origem da marcação fica explícita.",
            "Grupo \"Posto base\": Operador vem MARCADO.",
            "Grupo \"Perfil funcional\": Técnico de Referência (PAIF / PAEFI) vem MARCADO, com o selo \"sugerido\".",
            "Antes de escolher a ocupação a seção orienta que sem ocupação os perfis podem ser atribuídos manualmente depois.",
        ],
        "images": [
            "screenshots/00-estado-inicial-sem-ocupacao.png",
            "screenshots/ca01-ca02-proposta-premarcada.png",
        ],
    },
    {
        "id": "CA02",
        "title": "Add-on LGPD aparece sugerido e desmarcado",
        "status": "parc",
        "gherkin": (
            "Dado o mesmo cadastro do CA01, cujo perfil sugerido inclui `family_viewer` como sugestão, "
            "quando a proposta é exibida, então o add-on \"Visualização de Detalhes da Família — LGPD\" "
            "aparece visível e desmarcado; e quando o Master salva sem marcá-lo, então o profissional é "
            "criado sem acesso ao prontuário familiar completo."
        ),
        "steps_html": (
            "Parte visual: conferir o grupo <b>Acessos sensíveis (LGPD)</b> na mesma tela do CA01. "
            "Parte de salvamento: cadastro concluído com o conjunto pré-marcado, sem tocar no add-on "
            "(matrícula <code>MAT-CA02</code>)."
        ),
        "results": [
            "O add-on aparece VISÍVEL, com selo \"LGPD\" e DESMARCADO — ao contrário do posto base e do perfil funcional.",
            "A seção traz o aviso: \"Estes acessos liberam dados sensíveis de cidadãos. Vêm desmarcados de propósito.\"",
            "Após salvar sem marcá-lo: papéis efetivos = operador, pf_tecnico_referencia. Prontuário familiar: NÃO.",
            "Nenhum user_tenant_role com family_viewer foi criado no tenant ativo.",
        ],
        "images": ["screenshots/ca01-ca02-proposta-premarcada.png"],
    },
    {
        "id": "CA03",
        "title": "Confirmação afirmativa do add-on registra a origem",
        "status": "nav",
        "gherkin": (
            "Dado o mesmo cadastro, quando o Master marca `family_viewer` e salva, então o acesso ao "
            "prontuário familiar é concedido no tenant ativo e uma entrada de auditoria é registrada com "
            "usuário que concedeu, tenant, profissional beneficiado, papel concedido, indicação de que a "
            "origem foi a sugestão da ocupação e o momento da concessão."
        ),
        "steps_html": (
            "Cadastro concluído com o add-on <b>marcado</b> (matrícula <code>MAT-CA03</code>) e conferência "
            "da seção <b>Perfis de acesso</b> na tela do profissional, mais a trilha em "
            "<code>activity_log</code>."
        ),
        "results": [
            "A tela do profissional lista os três perfis, incluindo \"Visualização de Detalhes da Família — LGPD\".",
            "Papéis efetivos: family_viewer, operador, pf_tecnico_referencia. Prontuário familiar: SIM.",
            "activity_log grava event=roles_granted_from_suggestion, causer=\"E2E Master CadÚnico\", tenant_id=3, cbo_code=2516-05 e o momento.",
            "properties trazem suggested_kept com os três papéis, suggested_removed vazio e manually_added vazio — a origem é a sugestão da ocupação.",
            "A sugestão é recalculada no servidor a partir do CBO: uma lista de \"sugeridos\" forjada pelo cliente não altera o registro de origem.",
        ],
        "images": ["screenshots/ca03-perfis-concedidos.png"],
    },
    {
        "id": "CA04",
        "title": "Master recusa a sugestão",
        "status": "nav",
        "gherkin": (
            "Dado um cadastro com o perfil \"Técnico de Referência\" pré-marcado, quando o Master desmarca "
            "o perfil e salva, então o profissional é criado apenas com o posto base Operacional do "
            "Tenant, sem os módulos do perfil, e a auditoria registra que a sugestão da ocupação foi "
            "retirada pelo Master."
        ),
        "steps_html": (
            "Cadastro concluído com o perfil funcional e o add-on <b>desmarcados</b>, mantendo apenas o "
            "posto base (matrícula <code>MAT-CA04</code>)."
        ),
        "results": [
            "A tela do profissional mostra \"1 perfil\": apenas Operador.",
            "Papéis efetivos: operador. Prontuário familiar: NÃO.",
            "A auditoria registra suggested_removed = [family_viewer, pf_tecnico_referencia] e suggested_kept = [operador] — fica explícito o que o Master retirou.",
        ],
        "images": ["screenshots/ca04-sugestao-recusada.png"],
    },
    {
        "id": "CA05",
        "title": "CBO sem entrada no mapa",
        "status": "nav",
        "gherkin": (
            "Dado o CBO 5153-20 (Conselheiro tutelar), que não possui entrada no mapa, quando o Master o "
            "informa no cadastro, então nenhum perfil funcional é pré-marcado, nenhum add-on é sugerido, "
            "a tela informa que a ocupação não possui perfil sugerido, e salvar cria o profissional com o "
            "posto base Operacional do Tenant e nenhum módulo operacional."
        ),
        "steps_html": (
            "Selecionar <code>5153-20 — Conselheiro tutelar</code> — o CBO deliberadamente mantido fora do "
            "mapa pela HU #10343 (RN11 daquela HU)."
        ),
        "results": [
            "A tela informa: \"Esta ocupação não possui perfil sugerido. O profissional recebe apenas o posto base Operacional do Tenant.\"",
            "Só o grupo \"Posto base\" é renderizado, com Operador marcado.",
            "Nenhum grupo de perfil funcional e nenhum add-on é oferecido.",
            "A resposta da API é HTTP 200 com has_mapping=false — comportamento esperado, não erro.",
        ],
        "images": ["screenshots/ca05-cbo-sem-mapa.png"],
    },
    {
        "id": "CA06",
        "title": "Salvar somente add-on é recusado",
        "status": "auto",
        "gherkin": (
            "Dado um cadastro em que o Master marcou `family_viewer` e removeu o posto base Operacional do "
            "Tenant, quando ele tenta salvar, então o sistema recusa com 422, nenhum vínculo é criado, e a "
            "mensagem informa que papel add-on exige posto base."
        ),
        "steps_html": (
            "Submissão direta de <code>POST client/professionals</code> com "
            "<code>role_ids: [family_viewer]</code> — a UI mantém o posto base disponível, então o caso é "
            "provocado no contrato. A regra reusa "
            "<code>UserTenantRoleSyncService::assertResultingSetHasBasePost()</code> (GLPI #10141)."
        ),
        "results": [
            "HTTP 422 — o cadastro é recusado.",
            "Nenhum tenant_professional criado (MAT-CA06 não existe).",
            "Nenhum usuário criado para o CPF do cenário — a regra é avaliada ANTES da transação, então o rollback não deixa resíduo.",
        ],
        "images": [],
    },
    {
        "id": "CA07",
        "title": "Isolamento entre tenants",
        "status": "auto",
        "gherkin": (
            "Dado um Master do tenant A, quando ele tenta acessar por identificador o cadastro de um "
            "profissional pertencente ao tenant B, então a API responde 404."
        ),
        "steps_html": (
            "Com a sessão do Master do tenant \"E2E CadÚnico\", requisitar por uuid REAL um profissional "
            "do tenant 1."
        ),
        "results": [
            "Profissional do próprio tenant: HTTP 200.",
            "Profissional de outro tenant: HTTP 404 — nunca 403. O Global Scope de BelongsToTenant faz o registro simplesmente não existir no escopo, sem revelar que ele existe.",
            "O mesmo vale para a sub-rota .../roles: HTTP 404.",
        ],
        "images": [],
    },
    {
        "id": "CA08",
        "title": "Nenhum dado pessoal em texto livre",
        "status": "auto",
        "gherkin": (
            "Dado um cadastro de profissional contendo CPF e telefone, quando o cadastro é salvo com "
            "sucesso ou recusado por erro de validação, então nenhum registro de acompanhamento e nenhuma "
            "mensagem apresentada ao usuário contém o CPF ou o nome completo do profissional em texto livre."
        ),
        "steps_html": (
            "Varredura de todos os registros de <code>activity_log</code> com "
            "<code>log_name = tenant_professional</code>, buscando os CPFs e nomes completos usados nos "
            "cadastros deste dossiê."
        ),
        "results": [
            "15 registros varridos; 0 vazamentos de CPF ou nome completo.",
            "O CPF continua na trilha, porém MASCARADO por cpf_oculta (fail-closed): \"***.000.002-**\".",
            "⚠️ A varredura também encontrou 3 registros LEGADOS com CPF em claro, gravados antes desta HU — é o RISCO-02 da spec, confirmado com dado real. Esta HU corrige daqui para frente; sanear o histórico é decisão do encarregado de LGPD.",
        ],
        "images": [],
    },
]

EXTRAS = [
    {
        "id": "RN10",
        "title": "Complementar — sugestão é MASTER-only e não vaza o mapa global",
        "status": "auto",
        "gherkin": "A sugestão é atribuição do Master; o mapa global (#10343) permanece inalcançável pelo guard client.",
        "steps_html": (
            "Testes de permissão <code>ProfessionalRoleSuggestionMasterOnlyTest</code> (apêndice)."
        ),
        "results": [
            "Master recebe professionals.role-suggestion.show; Operador do tenant NÃO recebe.",
            "Nenhum papel do guard client recebe cbo-access-profiles.* — a HU usa recurso próprio justamente para não reabrir o que a #10343 fechou.",
            "O ADMIN (guard manager) mantém a gestão do mapa.",
        ],
        "images": [],
    },
    {
        "id": "RN09",
        "title": "Complementar — a sugestão nunca contém o posto Master",
        "status": "auto",
        "gherkin": "A proposta apresentada contém sempre e apenas o posto Operacional do Tenant como base.",
        "steps_html": (
            "Teste que injeta uma entrada de mapa contendo (indevidamente) o posto Master e consulta a "
            "sugestão."
        ),
        "results": [
            "O posto Master não aparece na proposta: o serviço filtra por hierarquia (só papéis estritamente abaixo do Master).",
            "Defesa em profundidade — o mapa da #10343 já recusa o Master, mas esta camada independe daquela e protege de dado legado.",
        ],
        "images": [],
    },
    {
        "id": "RN11",
        "title": "Complementar — mudar a ocupação não reprocessa o acesso",
        "status": "auto",
        "gherkin": "Alterar a ocupação de um profissional já cadastrado não altera, revoga nem re-sugere acesso.",
        "steps_html": "Teste que altera o cbo_id de um profissional já cadastrado e confere os vínculos.",
        "results": [
            "A ocupação é gravada com o novo valor.",
            "Os user_tenant_role permanecem exatamente como estavam — nenhuma concessão ou revogação.",
            "Na UI a proposta também não é recarregada no modo edição.",
        ],
        "images": [],
    },
]

manifest = {
    "meta": {
        "title": "Relatório de Critérios de Aceite — Sugestão de acesso por ocupação",
        "subtitle": "HU #10344 · US-002 (épico HU-CBO-PERFIL) · Evidências end-to-end no Painel do Tenant",
        "rows": [
            ["Gerado em", "06/08/2026"],
            ["Branch", "feature/10344-sugestao-perfil-no-cadastro-de-profissional (api + client)"],
            ["Spec", ".planning/specs/10344-sugestao-perfil-no-cadastro-de-profissional.md"],
            ["Ambiente", "API Sail/PostgreSQL :8000 · Painel do Tenant (client) Vite :5175 · guard client"],
            ["Perfil exercitado", "Master (CLIENT_ADMIN, level 20) — E2E Master CadÚnico"],
            ["Organização (tenant)", "E2E CadÚnico · uuid 00000000-0000-4000-8000-0000000000c1"],
            ["Dados", "Mapa da HU #10343 semeado — 2516-05 mapeado, 5153-20 deliberadamente fora"],
            ["Ferramenta", "playwright-cli (Chromium) + Pest"],
        ],
    },
    "summary": (
        "Os 8 critérios de aceite da HU #10344 foram verificados: 4 diretamente no navegador (CA01, CA03, "
        "CA04, CA05), 1 combinado — proposta conferida na tela e o salvamento pelo contrato (CA02) — e 3 "
        "pelo contrato da API somado à suíte automatizada (CA06, CA07, CA08). Todos atendidos. Somam-se 3 "
        "seções complementares (RN09, RN10, RN11). A captura encontrou e corrigiu um defeito real: o "
        "endpoint relacional de CBOs devolve um resource enxuto sem uuid, de modo que a chave cbo_uuid "
        "nunca era resolvida e a sugestão jamais carregava na tela — o contrato passou a aceitar cbo_id. "
        "A varredura do CA08 também confirmou, com dado real, o RISCO-02 registrado na spec. Apêndice: 19 "
        "testes Pest verdes."
    ),
    "cas": CAS + EXTRAS,
    "appendix": {
        "label": "Cobertura automatizada (Pest, --filter=ProfessionalRoleSuggestion) — 19 testes",
        "file": "pest-role-suggestion.txt",
    },
}

out = BASE / "manifest.json"
out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"manifest.json escrito com {len(manifest['cas'])} seções")
