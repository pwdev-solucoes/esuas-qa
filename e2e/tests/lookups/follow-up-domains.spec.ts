import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/auth';
import type { ApiClient } from '../../fixtures/api-client';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence, captureFinalEvidence } from '../../helpers/evidence';

/**
 * US-ACOMP-01 (épico HU-PRONT-ACOMP) — os dois domínios FECHADOS do bloco 24 do
 * instrumento Prontuário SUAS no Painel de Administração Global (`admin/`,
 * guard `manager`): os serviços de acompanhamento (PAIF/PAEFI) e as razões de
 * desligamento ('1'..'4').
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que a TELA não oferece o que a regra proíbe, e que a regra que mora no DADO
 * chega até os olhos do Administrador. O Pest já garante que a API não publica
 * `store` e que o `DELETE` sempre responde 422 com `error_code`; o que só o
 * navegador mostra é (a) se a interface, mesmo assim, exibe uma porta de
 * criação — afordância que promete o que o sistema recusa — e (b) se a recusa
 * chega ao usuário com a orientação de INATIVAR, em vez de morrer num toast
 * genérico. Por isso a asserção da porta de criação é NEGATIVA
 * (`toHaveCount(0)`) e a recusa é verificada nos dois planos ao mesmo tempo: o
 * status HTTP do `DELETE` (422 + `error_code`) e o texto que a tela mostra em
 * cima dele.
 *
 * E prova o ponto central da HU (D02/RN03): o vínculo serviço ↔ tipo de unidade
 * é DADO do item (`social_unit_type`), visível na LISTAGEM e no DETALHE — não é
 * um `if` "PAIF é do CRAS" escondido em algum arquivo. Trocar esse vínculo é o
 * evento mais sensível da HU e aparece na trilha com autor e data (CA07).
 *
 * ## Massa (pré-condição)
 *
 * As duas listas são FECHADAS (D03/RN01/RN02): o backend **não expõe `store`**,
 * então este spec **não tem como criar a própria massa**. Os dois serviços e as
 * quatro razões vêm do `FollowUpServiceSeeder` / `FollowUpExitReasonSeeder`,
 * que passaram a ser chamados pelo `E2ESeeder` (usado por
 * `scripts/start-stack.sh`) no mesmo lote deste arquivo.
 *
 * Massa ausente aqui **não vira `skip`**: depois daquele commit, tabela vazia
 * significa harness quebrado, e um caso pulado em silêncio contaria a história
 * errada. A asserção falha dizendo o comando que reconstrói a base.
 *
 * ## Estado
 *
 * Nada é criado nem apagado. Os dois casos que escrevem (troca de vínculo do
 * PAIF, inativação da razão '4') **revertem no próprio caso**, para não deixar
 * resíduo na base de e2e nem contaminar a suíte irmã.
 *
 * ## Fora do escopo deste spec
 *
 * **CA04** (o Painel do Tenant não mantém as listas — 401 nas rotas de escrita
 * pelo guard `client`) é contrato de API pura, já coberto por Pest em
 * `api/tests/Feature/Manager/FollowUp*Test.php`. Não existe tela de manutenção
 * no `client/` para dirigir, e criar um project `chromium-tenant` só para
 * confirmar um 401 não acrescentaria prova nenhuma.
 */
const SERVICES = 'follow-up-services';
const REASONS = 'follow-up-exit-reasons';

/**
 * Dossiê de aceite alimentado por ESTE spec (skill `acceptance-evidence-report`).
 * Os prints saem em `e2e/reports/<slug>-acceptance/screenshots/` e só quando
 * `CAPTURE_EVIDENCE=1` — ver `helpers/evidence.ts`.
 */
const EVIDENCE_SLUG = 'US-ACOMP-01-dominios-acompanhamento';

/**
 * RN01 — os dois serviços do MDS, com o nome por extenso e o tipo de unidade
 * que oferta cada um. A `sigla` é a do `social_unit_types` (CRAS/CREAS), que é
 * exatamente o que a célula do vínculo renderiza.
 *
 * ⚠️ A listagem vem ordenada por `code` (`defaultSorts('code')` no controller),
 * e `'PAEFI' < 'PAIF'`: a ordem na tela é PAEFI, PAIF. Por isso o caso do CA01
 * assevera o CONJUNTO, não a sequência — a ordem estável que a HU exige é a das
 * razões (CA03), onde o código é o do instrumento.
 */
const SERVICOS = [
  {
    code: 'PAIF',
    name: 'Serviço de Proteção e Atendimento Integral à Família',
    unitType: 'CRAS',
  },
  {
    code: 'PAEFI',
    name: 'Serviço de Proteção e Atendimento Especializado a Famílias e Indivíduos',
    unitType: 'CREAS',
  },
] as const;

/**
 * RN02/CA03 — os quatro códigos LITERAIS do instrumento, na ordem do `code`.
 * `conflicts` é a regra do D09/RN10 como dado do item: `true` só no '2'.
 */
const RAZOES = [
  { code: '1', name: 'Avaliação técnica', conflicts: false },
  { code: '2', name: 'Evasão ou recusa da Família', conflicts: true },
  { code: '3', name: 'Mudança de município', conflicts: false },
  { code: '4', name: 'Outros', conflicts: false },
] as const;

/** Serviço usado no vai-e-volta do vínculo (CA07) — o outro fica intocado. */
const SERVICE_UNDER_EDIT = 'PAIF';
/** Serviço usado na tentativa de exclusão (CA05), para não colidir com o CA07. */
const SERVICE_UNDER_DELETE = 'PAEFI';
/** Razão usada no vai-e-volta de inativação (CA06): 'Outros', a menos citada. */
const REASON_UNDER_TOGGLE = '4';
/** Razão usada na tentativa de exclusão (CA05). */
const REASON_UNDER_DELETE = '1';

function seedHint(slug: string): string {
  return (
    `A massa de "${slug}" não está na base. O E2ESeeder chama ` +
    `FollowUpServiceSeeder e FollowUpExitReasonSeeder desde o Lote 5 da ` +
    `US-ACOMP-01: reconstrua a stack com "bash e2e/scripts/start-stack.sh" ou ` +
    `rode "php artisan db:seed --class=Database\\Seeders\\FollowUpServiceSeeder" ` +
    `e o irmão FollowUpExitReasonSeeder dentro do container da API.`
  );
}

/** Promessa do próximo GET da listagem — encadeie ANTES da ação que dispara. */
function waitForList(page: Page, slug: string) {
  return page.waitForResponse(
    (res) => res.url().includes(`/api/${slug}`) && res.request().method() === 'GET',
    { timeout: 15_000 },
  );
}

/**
 * Promessa da próxima escrita no item. O `ResourceHttp` do `admin/` usa
 * **PATCH** (o `apiResource` registra PUT e PATCH para `update`, e todos os
 * campos do Form Request são `sometimes`) — aceitar os dois verbos evita que a
 * prova dependa de um detalhe do cliente HTTP.
 */
function waitForUpdate(page: Page, slug: string) {
  return page.waitForResponse(
    (res) =>
      res.url().includes(`/api/${slug}/`) &&
      ['PATCH', 'PUT'].includes(res.request().method()),
    { timeout: 15_000 },
  );
}

function waitForDelete(page: Page, slug: string) {
  return page.waitForResponse(
    (res) => res.url().includes(`/api/${slug}/`) && res.request().method() === 'DELETE',
    { timeout: 15_000 },
  );
}

function rows(page: Page): Locator {
  return page.locator('table tbody tr');
}

/**
 * A linha do serviço pelo `code`. A tabela de serviços não carrega `data-code`
 * na `<tr>`; a célula do código é a única com o texto EXATO 'PAIF'/'PAEFI' (a
 * célula do nome traz nome + sigla juntos), então a árvore de acessibilidade
 * basta e não é preciso tocar no `admin/` só para testar.
 */
function serviceRow(page: Page, code: string): Locator {
  return rows(page).filter({ has: page.getByRole('cell', { name: code, exact: true }) });
}

/** A linha da razão pelo `code` — aqui a célula tem `data-testid` próprio. */
function reasonRow(page: Page, code: string): Locator {
  return rows(page).filter({
    has: page.getByTestId('fuer-code-cell').filter({ hasText: new RegExp(`^${code}$`) }),
  });
}

async function openRowMenu(row: Locator): Promise<void> {
  await row.getByRole('button', { name: /mais ações/i }).click();
}

/**
 * Pré-condição de massa, lida pela API (não pela tela): devolve os `code`
 * semeados. Diferente do molde `capacitation-action-types.spec.ts`, a falha
 * aqui é ASSERÇÃO, não `skip` — ver o docblock do arquivo.
 */
async function seededCodes(apiClient: ApiClient, slug: string): Promise<string[]> {
  try {
    const res = await apiClient.get<{ data: Array<{ code: string }> }>(
      `/${slug}?per_page=100&sort=code`,
    );

    return (res.data ?? []).map((item) => item.code);
  } catch {
    return [];
  }
}

async function expectSeeded(apiClient: ApiClient, slug: string, expected: string[]): Promise<void> {
  const codes = await seededCodes(apiClient, slug);
  expect([...codes].sort(), seedHint(slug)).toEqual([...expected].sort());
}

async function goToList(page: Page, slug: string): Promise<void> {
  const listRequest = waitForList(page, slug);
  await page.goto(`/app/${slug}`);
  await dismissPlatformUpdates(page);
  const response = await listRequest;
  expect(response.status(), `GET /api/${slug} retornou ${response.status()}`).toBe(200);
  await expect(page.getByRole('main')).toBeVisible();
}

/**
 * D03/RN01 — nenhuma das duas telas oferece porta de criação, porque a API não
 * publica `store`. Escopado ao `main`: o que se prova é a ausência no CONTEÚDO,
 * não no menu lateral.
 */
async function expectNoCreateAffordance(page: Page): Promise<void> {
  await expect(
    page.getByRole('main').getByRole('button', { name: /^(nov[oa]|criar|adicionar)\b/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('main').getByRole('link', { name: /^(nov[oa]|criar|adicionar)\b/i }),
  ).toHaveCount(0);
}

test.describe('US-ACOMP-01 · Domínios do acompanhamento familiar (admin)', () => {
  // Evidência do estado FINAL de cada caso aprovado. Sem `CAPTURE_EVIDENCE=1` o
  // corpo retorna na primeira linha e a suíte roda exatamente como antes.
  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA01 — os dois serviços do MDS aparecem com o nome por extenso, sem porta de criação', async ({
    page,
    apiClient,
  }) => {
    await expectSeeded(
      apiClient,
      SERVICES,
      SERVICOS.map((s) => s.code),
    );

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await goToList(page, SERVICES);

    await expect(
      page.getByRole('heading', { name: /^serviços de acompanhamento$/i }),
    ).toBeVisible();

    // RN01 — exatamente dois, nem um a mais: a lista é fechada.
    await expect(rows(page)).toHaveCount(2);

    for (const servico of SERVICOS) {
      const line = serviceRow(page, servico.code);
      await expect(line, `linha do ${servico.code} não encontrada`).toHaveCount(1);
      // O nome POR EXTENSO do MDS, não a sigla — é o que o CA01 exige.
      await expect(line).toContainText(servico.name);
    }

    await expectNoCreateAffordance(page);

    expect(
      consoleErrors,
      `console errors em /${SERVICES}: ${consoleErrors.join(' | ')}`,
    ).toEqual([]);
  });

  test('CA02 — o vínculo com o tipo de unidade está visível na listagem e no detalhe', async ({
    page,
    apiClient,
  }, testInfo) => {
    await expectSeeded(
      apiClient,
      SERVICES,
      SERVICOS.map((s) => s.code),
    );

    await goToList(page, SERVICES);

    // Na LISTAGEM: PAIF↔CRAS e PAEFI↔CREAS, sem abrir registro a registro.
    for (const servico of SERVICOS) {
      await expect(
        serviceRow(page, servico.code).getByTestId('fus-unit-type-cell'),
        `${servico.code} deveria ser ofertado por ${servico.unitType}`,
      ).toHaveText(servico.unitType);
    }

    // E no DETALHE: o vínculo é um select obrigatório (a coluna é NOT NULL),
    // preenchido com o tipo que oferta o serviço — a regra mora no item.
    await openRowMenu(serviceRow(page, 'PAIF'));
    await page.getByRole('menuitem', { name: /^editar$/i }).click();

    await expect(page.getByTestId('fus-unit-type')).toContainText(/^CRAS —/);
    // D04/RN02 — o `code` identifica o serviço no leiaute e NÃO é renumerado:
    // no detalhe ele é somente leitura.
    await expect(page.getByTestId('fus-code-readonly')).toHaveValue('PAIF');
    await expect(page.getByTestId('fus-code-readonly')).toHaveAttribute('readonly', /.*/);

    // O detalhe some ao fechar a sheet: a evidência do vínculo editável tem de
    // sair AQUI, não no estado final do caso.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'detalhe-paif');

    await page.getByRole('button', { name: /^cancelar$/i }).click();
    await expect(page.getByTestId('fus-unit-type')).toHaveCount(0);
  });

  test('CA03 — as quatro razões trazem os códigos do instrumento, na ordem do code e sem renumeração', async ({
    page,
    apiClient,
  }) => {
    await expectSeeded(
      apiClient,
      REASONS,
      RAZOES.map((r) => r.code),
    );

    await goToList(page, REASONS);

    await expect(
      page.getByRole('heading', { name: /^razões de desligamento do acompanhamento$/i }),
    ).toBeVisible();

    await expect(rows(page)).toHaveCount(4);

    // A ordem é a do `code` do instrumento — '1','2','3','4' — e os códigos são
    // literais: nada de renumerar nem de gerar sequência própria.
    const renderedCodes = await page.getByTestId('fuer-code-cell').allInnerTexts();
    expect(renderedCodes.map((text) => text.trim())).toEqual(RAZOES.map((r) => r.code));

    for (const razao of RAZOES) {
      const line = reasonRow(page, razao.code);
      await expect(line).toContainText(razao.name);
      // D09/RN10 — a regra de coerência é DADO do item (só o '2' conflita), e
      // está legível na listagem.
      await expect(line.getByTestId('fuer-conflicts-cell')).toHaveText(
        razao.conflicts ? /incoerente com progresso/i : /compatível com progresso/i,
      );
    }

    await expectNoCreateAffordance(page);
  });

  test('CA05 — a exclusão de um serviço é recusada com a orientação de inativar', async ({
    page,
    apiClient,
  }, testInfo) => {
    await expectSeeded(
      apiClient,
      SERVICES,
      SERVICOS.map((s) => s.code),
    );

    await goToList(page, SERVICES);

    await openRowMenu(serviceRow(page, SERVICE_UNDER_DELETE));

    const deleteRequest = waitForDelete(page, SERVICES);
    await page.getByRole('menuitem', { name: /^excluir$/i }).click();

    // D05 — o `DELETE` existe e SEMPRE recusa, com o motivo declarado. Hoje o
    // `CONSUMERS` do FollowUpServiceUsageService está vazio (a US-ACOMP-02
    // ainda não criou `family_follow_ups`), então o motivo é sempre
    // `follow_up_service_layout_bound`; o conjunto aceita os dois para que o
    // caso continue válido quando o primeiro acompanhamento for registrado.
    const response = await deleteRequest;
    expect(response.status(), 'DELETE de serviço do instrumento nunca pode ser aceito').toBe(422);
    const body = (await response.json()) as { error_code?: string; message?: string };
    expect(['follow_up_service_in_use', 'follow_up_service_layout_bound']).toContain(
      body.error_code,
    );

    // E a tela mostra a explicação AUTORITATIVA do servidor…
    await expect(page.getByText(/este serviço não pode ser excluído/i)).toBeVisible();
    // Regex bilíngue de propósito: o `SetLocale` da API resolve o idioma pelo
    // `Accept-Language` do navegador (o Chromium do Playwright manda en-US) e
    // NENHUM dos frontends envia `X-Locale`. Logo a UI fica em pt-BR e a
    // mensagem da API pode vir em inglês — inconsistência de plataforma,
    // anterior a esta HU e comum a todos os módulos. O que este caso prova é o
    // COMPORTAMENTO, não a tradução.
    await expect(page.getByTestId('fus-deletion-reason')).toContainText(
      /não pode ser excluído|cannot be deleted/i,
    );
    // …e a orientação de INATIVAR, que é da tela e não depende da redação do
    // backend (CA05: "a mensagem indica que o item pode ser inativado").
    await expect(page.getByTestId('fus-deletion-deactivate-hint')).toContainText(/pode inativ/i);

    // O diálogo da recusa é a evidência do CA05 — ele fecha no clique seguinte.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'recusa-servico');

    await page.getByRole('button', { name: /^entendi$/i }).click();

    // Nada foi apagado: os dois continuam lá, e o recusado continua ativo.
    await expect(rows(page)).toHaveCount(2);
    await expect(
      serviceRow(page, SERVICE_UNDER_DELETE).getByTestId('fus-badge-status'),
    ).toHaveText(/^ativo$/i);
  });

  test('CA05 — a exclusão de uma razão é recusada com a orientação de inativar', async ({
    page,
    apiClient,
  }, testInfo) => {
    await expectSeeded(
      apiClient,
      REASONS,
      RAZOES.map((r) => r.code),
    );

    await goToList(page, REASONS);

    await openRowMenu(reasonRow(page, REASON_UNDER_DELETE));

    const deleteRequest = waitForDelete(page, REASONS);
    await page.getByRole('menuitem', { name: /^excluir$/i }).click();

    const response = await deleteRequest;
    expect(response.status(), 'DELETE de razão do instrumento nunca pode ser aceito').toBe(422);
    const body = (await response.json()) as { error_code?: string; message?: string };
    expect([
      'follow_up_exit_reason_in_use',
      'follow_up_exit_reason_instrument_bound',
    ]).toContain(body.error_code);

    await expect(page.getByText(/esta razão não pode ser excluída/i)).toBeVisible();
    await expect(page.getByTestId('fuer-deletion-reason')).toContainText(
      /não pode ser excluída|cannot be deleted/i,
    );
    await expect(page.getByTestId('fuer-deletion-deactivate-hint')).toContainText(/pode inativ/i);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'recusa-razao');

    await page.getByRole('button', { name: /^entendi$/i }).click();

    // Nenhuma renumeração, nenhuma linha a menos: os quatro códigos intactos.
    await expect(rows(page)).toHaveCount(4);
    const renderedCodes = await page.getByTestId('fuer-code-cell').allInnerTexts();
    expect(renderedCodes.map((text) => text.trim())).toEqual(RAZOES.map((r) => r.code));
  });

  test('CA07 — trocar o tipo de unidade de um serviço aparece na trilha, com autor e data', async ({
    page,
    apiClient,
  }, testInfo) => {
    await expectSeeded(
      apiClient,
      SERVICES,
      SERVICOS.map((s) => s.code),
    );

    await goToList(page, SERVICES);

    const line = serviceRow(page, SERVICE_UNDER_EDIT);
    await expect(line.getByTestId('fus-unit-type-cell')).toHaveText('CRAS');

    // --- troca do vínculo (o evento mais sensível da HU) ---
    await openRowMenu(line);
    await page.getByRole('menuitem', { name: /^editar$/i }).click();

    await page.getByTestId('fus-unit-type').click();
    await page.getByRole('option', { name: /^CREAS —/ }).click();

    const updateRequest = waitForUpdate(page, SERVICES);
    await page.getByTestId('fus-submit').click();
    expect((await updateRequest).status(), 'a troca do vínculo deveria ser aceita').toBe(200);

    await expect(serviceRow(page, SERVICE_UNDER_EDIT).getByTestId('fus-unit-type-cell')).toHaveText(
      'CREAS',
    );

    // --- a trilha do item, com de/para, autor e data ---
    await openRowMenu(serviceRow(page, SERVICE_UNDER_EDIT));
    await page.getByRole('menuitem', { name: /ver histórico/i }).click();

    const entry = page.getByTestId('fus-history-updated').first();
    await expect(entry).toBeVisible();
    // O activity_log grava a FK crua; a tela traduz o de/para para a sigla do
    // tipo — é isso que o Administrador precisa conseguir ler.
    await expect(entry).toContainText(/unidade que oferta/i);
    await expect(entry).toContainText(/CRAS —/);
    await expect(entry).toContainText(/CREAS —/);
    // Autor (causer) e data — o "quem" e o "quando" que o CA07 exige.
    await expect(entry).toContainText(/E2E Super Admin/);
    await expect(entry).toContainText(/\d{2}\/\d{2}\/\d{4}/);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'trilha-vinculo');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('fus-history')).toHaveCount(0);

    // --- reverte o vínculo (não deixar resíduo na base de e2e) ---
    await openRowMenu(serviceRow(page, SERVICE_UNDER_EDIT));
    await page.getByRole('menuitem', { name: /^editar$/i }).click();
    await page.getByTestId('fus-unit-type').click();
    await page.getByRole('option', { name: /^CRAS —/ }).click();

    const revertRequest = waitForUpdate(page, SERVICES);
    await page.getByTestId('fus-submit').click();
    expect((await revertRequest).status()).toBe(200);

    await expect(serviceRow(page, SERVICE_UNDER_EDIT).getByTestId('fus-unit-type-cell')).toHaveText(
      'CRAS',
    );
  });

  test('CA06 — a razão inativada continua listada e deixa de ser oferecida como ativa', async ({
    page,
    apiClient,
  }, testInfo) => {
    await expectSeeded(
      apiClient,
      REASONS,
      RAZOES.map((r) => r.code),
    );

    await goToList(page, REASONS);

    const line = reasonRow(page, REASON_UNDER_TOGGLE);
    // Nome EXATO no badge: "Inativa" contém "ativa", e um regex frouxo passaria
    // nos dois estados.
    await expect(line.getByTestId('fuer-badge-status')).toHaveText(/^ativa$/i);

    // --- inativação (pelo badge de status, que é clicável) ---
    const patchRequest = waitForUpdate(page, REASONS);
    await line.getByTestId('fuer-badge-status').click();
    expect((await patchRequest).status()).toBe(200);

    await expect(
      reasonRow(page, REASON_UNDER_TOGGLE).getByTestId('fuer-badge-status'),
    ).toHaveText(/^inativa$/i);

    // D06/RN05 — inativar NÃO apaga: sem filtro, as quatro continuam na lista,
    // com os códigos do instrumento intactos.
    await expect(rows(page)).toHaveCount(4);

    // --- deixa de ser oferecida entre as ATIVAS (o select do desligamento novo) ---
    await page.getByRole('button', { name: /^filtros$/i }).click();

    let listRequest = waitForList(page, REASONS);
    await page.getByTestId('fuer-status-filter').click();
    await page.getByRole('option', { name: 'Ativas', exact: true }).click();
    await listRequest;

    await expect(rows(page)).toHaveCount(3);
    await expect(reasonRow(page, REASON_UNDER_TOGGLE)).toHaveCount(0);

    // --- e continua acessível pelo filtro de inativas (histórico/apuração) ---
    listRequest = waitForList(page, REASONS);
    await page.getByTestId('fuer-status-filter').click();
    await page.getByRole('option', { name: 'Inativas', exact: true }).click();
    await listRequest;

    await expect(rows(page)).toHaveCount(1);
    await expect(reasonRow(page, REASON_UNDER_TOGGLE)).toBeVisible();

    // A razão inativa ainda listada é a evidência do CA06 — a reativação
    // logo abaixo desfaz o estado.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'razao-inativada');

    // --- reativa e limpa o filtro (devolve a base ao estado original) ---
    const reactivateRequest = waitForUpdate(page, REASONS);
    await reasonRow(page, REASON_UNDER_TOGGLE).getByTestId('fuer-badge-status').click();
    expect((await reactivateRequest).status()).toBe(200);

    listRequest = waitForList(page, REASONS);
    await page.getByRole('button', { name: /^limpar filtros$/i }).click();
    await listRequest;

    await expect(rows(page)).toHaveCount(4);
    await expect(
      reasonRow(page, REASON_UNDER_TOGGLE).getByTestId('fuer-badge-status'),
    ).toHaveText(/^ativa$/i);
  });

  test('as duas telas do épico ficam juntas em Cadastros SUAS › Acompanhamento Familiar', async ({
    page,
  }) => {
    await page.goto('/app');
    await dismissPlatformUpdates(page);
    await expect(page.getByRole('main')).toBeVisible();

    const nav = page.locator('nav');
    const group = nav.getByRole('button', { name: /cadastros suas/i });
    await expect(group).toBeVisible();

    const servicesEntry = nav.getByRole('button', {
      name: 'Serviços de Acompanhamento',
      exact: true,
    });
    const reasonsEntry = nav.getByRole('button', { name: 'Razões de Desligamento', exact: true });

    // O estado aberto/fechado do grupo é persistido em localStorage: abre só se
    // a sessão herdada tiver deixado fechado.
    if (!(await servicesEntry.isVisible().catch(() => false))) {
      await group.click();
    }

    // O subgrupo próprio existe porque as duas telas do épico andam juntas.
    await expect(nav.getByText('Acompanhamento Familiar', { exact: true })).toBeVisible();
    await expect(servicesEntry).toBeVisible();
    await expect(reasonsEntry).toBeVisible();

    let listRequest = waitForList(page, SERVICES);
    await servicesEntry.click();
    await listRequest;
    await expect(page).toHaveURL(new RegExp(`/app/${SERVICES}$`));
    await expect(
      page.getByRole('heading', { name: /^serviços de acompanhamento$/i }),
    ).toBeVisible();

    listRequest = waitForList(page, REASONS);
    await reasonsEntry.click();
    await listRequest;
    await expect(page).toHaveURL(new RegExp(`/app/${REASONS}$`));
    await expect(
      page.getByRole('heading', { name: /^razões de desligamento do acompanhamento$/i }),
    ).toBeVisible();
  });
});
