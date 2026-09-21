#!/usr/bin/env python3
"""Monta o manifest.json do dossiê de evidências da HU #10345."""
import json
import pathlib

BASE = pathlib.Path(__file__).parent

CAS = [
    {
        "id": "CA01",
        "title": "Perda derivada do mapa é revogada de imediato",
        "status": "nav",
        "gherkin": (
            "Dado um profissional com CBO \"2516-05\" e o perfil \"Técnico de Referência\" concedido pelo mapa, "
            "e que o grant desse papel tem origin = 'suggested', quando o Master altera o CBO para \"4110-10\" "
            "(Assistente administrativo), então o papel pf_tecnico_referencia é revogado no ato, sem confirmação, "
            "o user_tenant_role correspondente deixa de existir no tenant ativo, o grant recebe revoked_at "
            "preenchido (não é apagado — RN11) e uma nova requisição do profissional a person-search.index é "
            "recusada com 403."
        ),
        "steps_html": (
            "Autenticado como <b>Master</b>, abrir o profissional cadastrado com o CBO <code>2516-05</code> "
            "(3 perfis: Operador, Técnico de Referência e o add-on LGPD, todos com "
            "<code>origin = suggested</code>). Editar, trocar a ocupação para "
            "<code>4110-10 — Assistente administrativo</code>, salvar, e reabrir a tela de detalhe."
        ),
        "results": [
            "Antes: 3 perfis (Operador, Técnico de Referência, Visualização de Detalhes da Família — LGPD).",
            "Depois de salvar: 1 perfil — apenas Operador. A revogação é síncrona, na mesma transação da alteração.",
            "Em professional_role_grants, pf_tecnico_referencia e family_viewer ficam com revoked_at preenchido e revoked_reason = \"cbo_changed\" — os registros são MARCADOS, não apagados (RN11).",
            "O grant do posto base operador permanece sem revoked_at.",
            "A perda de permissão efetiva é coberta pelo teste Pest \"CA01: o profissional deixa de ter a permissao do papel revogado\".",
        ],
        "images": [
            "screenshots/ca01-antes-perfis-do-cbo-2516-05.png",
            "screenshots/ca01-edicao-novo-cbo.png",
            "screenshots/ca01-perfis-apos-revogacao.png",
        ],
    },
    {
        "id": "CA02",
        "title": "Ganho é apresentado como sugestão, não concedido",
        "status": "nav",
        "gherkin": (
            "Dado o mesmo profissional do CA01, cujo novo CBO \"4110-10\" corresponde a \"Apoio Administrativo\", "
            "quando a alteração é salva, então NENHUM papel novo é concedido (nenhum user_tenant_role criado), "
            "GET .../access-review retorna a sugestão pendente com pf_apoio_administrativo preselected=true, e o "
            "acesso só passa a existir quando o Master chamar .../access-review/confirm."
        ),
        "steps_html": (
            "Na tela de detalhe do mesmo profissional, observar o painel <b>Acesso a confirmar</b> logo após a "
            "alteração; conferir que <b>Perfis de acesso</b> ainda mostra só o Operador; então clicar "
            "<b>Confirmar acesso</b> e reconferir."
        ),
        "results": [
            "Imediatamente após a alteração o painel informa: \"A ocupação 4110-10 prevê estes acessos, que ainda não foram concedidos.\"",
            "Apoio Administrativo aparece pré-marcado (preselected vem do servidor, campo a campo) — mas o cartão Perfis de acesso continua com 1 perfil.",
            "O ganho NÃO é automático por desenho: o perfil PF-07 dá acesso ao próprio cadastro de Profissionais, onde o CBO é editado; conceder sem confirmação seria escalonamento de privilégio.",
            "Após \"Confirmar acesso\" (POST .../access-review/confirm → 200), Perfis de acesso passa a 2 perfis: Operador e Apoio Administrativo.",
            "O grant de pf_apoio_administrativo é criado com origin = suggested.",
            "O confirm confronta cada id com a sugestão recalculada no servidor — coberto pelo teste \"CA02: confirmar papel FORA da sugestao vigente e recusado\".",
        ],
        "images": [
            "screenshots/ca02-sugestao-pendente.png",
            "screenshots/ca02-apos-confirmar.png",
        ],
    },
    {
        "id": "CA03",
        "title": "Add-on LGPD que sai do mapa é revogado sem confirmação",
        "status": "parc",
        "gherkin": (
            "Dado um profissional com CBO \"2515-30\" e o add-on family_viewer concedido pelo mapa, quando o CBO é "
            "alterado para \"4221-05\" (Recepcionista), cujo perfil não sugere esse add-on, então family_viewer é "
            "revogado de imediato, o usuário deixa de ter a permissão families.view-details e uma nova tentativa "
            "de abrir o prontuário familiar completo é recusada."
        ),
        "steps_html": (
            "O caso foi exercitado na mesma transição do CA01 — o profissional tinha <code>family_viewer</code> "
            "derivado do mapa do CBO <code>2516-05</code> e passou para <code>4110-10</code>, cujo perfil (Apoio "
            "Administrativo) não prevê o add-on. Transição equivalente à do enunciado: perfil de origem com o "
            "add-on → perfil de destino sem ele. A recusa efetiva da permissão é coberta pelo teste Pest "
            "<i>\"CA03: add-on LGPD derivado do mapa e revogado de imediato\"</i>."
        ),
        "results": [
            "family_viewer deixa de constar em user_tenant_role no ato da alteração, sem qualquer confirmação.",
            "O grant fica com revoked_at = 2026-08-07 13:15:38 e revoked_reason = \"cbo_changed\".",
            "A trilha registra revoked = [\"family_viewer\", \"pf_tecnico_referencia\"].",
            "Revogar sem confirmação é seguro e reversível — a assimetria (perda imediata, ganho por sugestão) é deliberada.",
        ],
        "images": ["screenshots/ca01-perfis-apos-revogacao.png"],
    },
    {
        "id": "CA04",
        "title": "Acesso concedido manualmente é preservado e sinalizado",
        "status": "nav",
        "gherkin": (
            "Dado um profissional com CBO \"2235-05\" (Enfermeiro) e que o Master lhe concedeu MANUALMENTE o "
            "add-on family_viewer (origin = 'manual'), que o perfil \"Equipe Técnica Complementar\" não sugeria, "
            "quando o CBO é alterado para \"4110-05\" (Auxiliar de escritório), então family_viewer PERMANECE "
            "concedido e GET .../access-review lista esse papel em divergences, identificado como acesso manual "
            "não previsto para a ocupação atual."
        ),
        "steps_html": (
            "Em um profissional com CBO <code>2516-05</code> (Operador + Técnico de Referência, ambos "
            "<code>suggested</code>), abrir <b>Gerenciar</b> perfis e conceder <b>manualmente</b> o add-on "
            "<b>Visualização de Detalhes da Família — LGPD</b> (o drawer grava <code>origin = manual</code> — "
            "retrofit da DÍVIDA-01). Em seguida, editar e trocar a ocupação para "
            "<code>4110-05 — Auxiliar de escritório</code>."
        ),
        "results": [
            "O grant criado pelo drawer nasce com origin = manual, distinto dos derivados do mapa.",
            "Após a mudança de ocupação: pf_tecnico_referencia (suggested) é revogado, mas family_viewer (manual) PERMANECE em user_tenant_role.",
            "O painel \"Acessos fora do previsto para a ocupação\" lista o add-on com o selo \"concedido manualmente\" — informativo, o Master decide manter ou remover.",
            "A trilha registra preserved_manual = [\"family_viewer\"] e revoked = [\"pf_tecnico_referencia\"].",
            "A divergência é DERIVADA, não persistida: some sozinha se o novo mapa passar a prever o papel (teste \"CA04/RN06\").",
        ],
        "images": [
            "screenshots/ca04-concessao-manual-drawer.png",
            "screenshots/ca04-divergencia-manual.png",
        ],
    },
    {
        "id": "CA05",
        "title": "Autoalteração de ocupação não amplia acesso",
        "status": "auto",
        "gherkin": (
            "Dado um profissional com CBO \"2524-05\" e o perfil \"Gestão do Trabalho\" concedido pelo mapa, "
            "quando ele altera o PRÓPRIO CBO para \"2516-05\" (Assistente social), então pf_gestao_trabalho é "
            "revogado de imediato, nenhum acesso novo é concedido, family_viewer aparece apenas como sugestão "
            "com preselected = FALSE, e uma nova tentativa dele de abrir o cadastro de Profissionais é recusada."
        ),
        "steps_html": (
            "Critério que exige autenticar como o <b>próprio profissional</b> (não o Master) e observar a perda "
            "de acesso na sequência — cenário de escalonamento de privilégio, coberto pelo teste Pest "
            "<i>\"CA05: alterar a propria ocupacao revoga e NAO concede nada\"</i>, que exercita exatamente a "
            "transição 2524-05 → 2516-05 com o profissional como causer. É a razão de ser da assimetria da HU: "
            "se o ganho fosse automático, existiria o caminho \"Analista de RH altera o próprio CBO → ganha o "
            "perfil técnico → abre prontuário familiar\", sem Master nenhum no caminho."
        ),
        "results": [
            "pf_gestao_trabalho é revogado no ato, mesmo sendo o próprio profissional quem alterou.",
            "Nenhum user_tenant_role é criado — o ganho fica pendente de confirmação por quem tem professionals.access-review.confirm (Master).",
            "O add-on family_viewer aparece na sugestão com preselected = false.",
            "Os botões de confirmar/dispensar só são renderizados para quem tem a permissão — o próprio profissional não os vê.",
            "Ver apêndice: teste \"CA05: alterar a propria ocupacao revoga e NAO concede nada\" passando.",
        ],
        "images": [],
    },
    {
        "id": "CA06",
        "title": "Novo CBO sem entrada no mapa",
        "status": "nav",
        "gherkin": (
            "Dado um profissional com CBO \"2516-05\" e perfil concedido pelo mapa, quando o Master altera o CBO "
            "para \"5153-20\" (Conselheiro tutelar), sem entrada no mapa, então todos os papéis com "
            "origin = 'suggested' são revogados (exceto o posto base), nenhuma sugestão é apresentada "
            "(suggestion.roles vazio), has_mapping = false e a mensagem informa que a ocupação não possui perfil "
            "sugerido."
        ),
        "steps_html": (
            "No mesmo profissional (já com <code>pf_apoio_administrativo</code> derivado do CBO "
            "<code>4110-10</code>), trocar a ocupação para <code>5153-20 — Conselheiro tutelar</code>, que não "
            "tem entrada no mapa da HU #10343. Reabrir o detalhe e consultar "
            "<code>GET .../access-review</code>."
        ),
        "results": [
            "pf_apoio_administrativo (suggested) é revogado; sobra apenas o posto base Operador.",
            "Nenhum painel \"Acesso a confirmar\" é renderizado — não há o que sugerir.",
            "GET .../access-review responde 200 com has_mapping = false, suggestion.roles = [] e divergences = [].",
            "A trilha registra new_cbo_has_mapping = false, revoked = [\"pf_apoio_administrativo\"] e suggested = [].",
            "CBO sem mapa é caso normal, não erro — nunca 404.",
        ],
        "images": ["screenshots/ca06-cbo-sem-mapa-sem-sugestao.png"],
    },
    {
        "id": "CA07",
        "title": "Posto base sobrevive a qualquer mudança de ocupação",
        "status": "nav",
        "gherkin": (
            "Dado um profissional com qualquer CBO mapeado, quando o CBO é alterado para qualquer outro, mapeado "
            "ou não, então o papel operador PERMANECE concedido e o profissional continua acessando Início, "
            "Novidades e Documentos Legais."
        ),
        "steps_html": (
            "Verificado em <b>todas</b> as transições exercitadas neste dossiê: 2516-05 → 4110-10 (mapeado → "
            "mapeado), 4110-10 → 5153-20 (mapeado → sem mapa) e 2516-05 → 4110-05 (com papel manual no meio). Em "
            "cada uma, conferir <code>user_tenant_role</code> e o grant do posto base."
        ),
        "results": [
            "operador permanece em user_tenant_role nas três transições, inclusive quando o novo CBO não tem mapa.",
            "O grant do posto base nunca recebe revoked_at — a exceção da RN07 é explícita no reprocessamento.",
            "Sem o posto base o profissional perderia o acesso à organização inteira, e não só ao módulo.",
            "Reforçado pelo teste Pest \"CA07: o posto base NUNCA e revogado pelo reprocessamento\".",
        ],
        "images": ["screenshots/ca06-cbo-sem-mapa-sem-sugestao.png"],
    },
    {
        "id": "CA08",
        "title": "Reprocessamento fica registrado na trilha de auditoria",
        "status": "parc",
        "gherkin": (
            "Dado que o Master altera o CBO de um profissional de \"2516-05\" para \"4110-10\", quando a "
            "alteração é salva, então activity_log grava event = \"cbo_access_reprocessed\" com causer (quem "
            "alterou), tenant_id, subject (o profissional), previous_cbo_code, new_cbo_code, revoked[], "
            "suggested[], preserved_manual[] e created_at; os grants revogados permanecem consultáveis com "
            "revoked_at (não são apagados); e nenhum CPF ou nome completo aparece em texto livre."
        ),
        "steps_html": (
            "Inspeção direta de <code>activity_log</code> após cada uma das três transições, e de "
            "<code>professional_role_grants</code> para confirmar que a revogação marca em vez de apagar. "
            "Reforçado pelos testes Pest <i>\"CA08: registra o reprocessamento…\"</i> e <i>\"CA08: nenhuma PII em "
            "texto livre na trilha do reprocessamento\"</i>."
        ),
        "results": [
            "event = cbo_access_reprocessed, log_name = tenant_professional, causer = User#7 (o Master), subject = TenantProfessional#8.",
            "properties trazem tenant_id, previous_cbo_code, new_cbo_code, new_cbo_has_mapping, revoked[], suggested[], preserved_manual[] e legacy.",
            "Os grants revogados seguem consultáveis com revoked_at e revoked_reason = \"cbo_changed\".",
            "Busca literal pelo CPF e pelo nome completo do profissional nas properties: não encontrado em nenhuma das transições.",
            "A correção da DÍVIDA-02 (syncRoles gravava o CPF em CLARO no activity_log) faz parte desta entrega.",
        ],
        "images": [],
    },
]

MANIFEST = {
    "meta": {
        "title": "Relatório de Critérios de Aceite — HU #10345",
        "subtitle": "Reprocessar o acesso quando a ocupação muda · Fecha o épico HU-CBO-PERFIL (US-003)",
        "rows": [
            ["Gerado em", "07/08/2026"],
            ["Branch", "feature/10345-reprocessar-acesso-em-mudanca-de-cbo"],
            ["Commits", "api 44a827c · client 12808a2"],
            ["Spec", ".planning/specs/10345-reprocessar-acesso-em-mudanca-de-cbo.md"],
            ["Ambiente", "API Laravel/Sail :8000 · PostgreSQL · client Vite :5174 (não-mock)"],
            ["Organização (tenant)", "E2E CadÚnico · uuid 00000000-0000-4000-8000-0000000000c1"],
            ["Perfil usado", "Master do tenant (guard client) — CPF 529.982.247-25"],
            ["Ferramenta", "playwright-cli (Chromium headless) + Pest 4"],
        ],
    },
    "summary": (
        "8 critérios de aceite, todos atendidos: 5 evidenciados dirigindo o frontend do tenant no navegador "
        "(CA01, CA02, CA04, CA06, CA07), 2 combinando navegador e suíte automatizada (CA03 e CA08) e 1 "
        "exclusivamente automatizado (CA05, que exige autenticar como o próprio profissional). A suíte Pest da "
        "feature roda 19 testes com 87 asserções, todos passando. O reprocessamento assimétrico foi confirmado "
        "ponta a ponta: a perda é aplicada no ato da alteração, o ganho só existe depois que o Master confirma. "
        "Um achado de usabilidade fora do escopo dos CAs — a tela de edição não exibe a ocupação atual do "
        "profissional, por falta de eager load de 'cbo' no show — está documentado em "
        "achado-ocupacao-nao-exibida-na-edicao.txt e não reprova nenhum critério."
    ),
    "cas": CAS,
    "appendix": {
        "label": "Cobertura automatizada (Pest — CboAccessReprocessingTest + ProfessionalAccessReviewMasterOnlyTest)",
        "file": "pest-cbo-reprocessing.txt",
    },
}

(BASE / "manifest.json").write_text(
    json.dumps(MANIFEST, ensure_ascii=False, indent=2), encoding="utf-8"
)
print("manifest.json escrito com", len(CAS), "CAs")
