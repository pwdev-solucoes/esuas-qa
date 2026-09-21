import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { createTenantApiClient, loginAsTenantUser } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * E2E da aba "Acompanhamento familiar" do prontuário (US-ACOMP-02) no
 * frontend do TENANT (`client/`, porta 4174).
 *
 * O que este spec prova — e que nenhum teste de backend prova:
 *
 *  1. o INGRESSO chega ao prontuário pela tela (registro → linha vigente);
 *  2. o select de serviço honra o vínculo tipo↔serviço (CRAS oferta só PAIF);
 *  3. o segundo ingresso na MESMA unidade+serviço é recusado com a mensagem
 *     que aponta o acompanhamento EXISTENTE, em vez de um erro cego;
 *  4. data futura é barrada NO FORMULÁRIO (atributo `max` + validação local);
 *  5. cancelar NÃO apaga: a linha permanece, marcada como cancelada, com
 *     motivo e autor;
 *  6. a negativa de acesso ao prontuário não nomeia unidade nenhuma (LGPD);
 *  7. família nunca acompanhada mostra o estado vazio, não uma tabela vazia.
 *
 * ⚠️ HARNESS: o project `chromium-tenant` já entrega `page` autenticado como
 * o `E2E_CLIENT_OPERADOR_*` (lotado no "E2E CRAS Centro"). Nenhum cenário
 * aqui faz login — as rotas `/auth/*` têm throttle de 6 req/min.
 *
 * ⚠️ ESTADO: o acompanhamento é PERSISTENTE (cancelar não apaga). Para o spec
 * ser re-executável, o `beforeAll` cancela via API o que houver de vigente na
 * família de trabalho, e o cenário do estado vazio usa uma família que
 * NENHUM cenário daqui toca.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_WORK = process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID;
const FAMILY_OTHER_UNIT = process.env.E2E_CLIENT_FAMILY_OTHER_UNIT_UUID;
const UNIT_UUID = process.env.E2E_CLIENT_UNIT_UUID;
const UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';
const UNIT_NOT_ASSIGNED_NAME = process.env.E2E_CLIENT_UNIT_NOT_ASSIGNED_NAME ?? 'E2E CREAS';

/**
 * Família visível ao Operacional e NUNCA acompanhada — o cenário (g).
 * Fallback: a família "com divergência" do `E2EProntuarioSeeder`, que nenhum
 * cenário de acompanhamento usa.
 */
const FAMILY_NEVER_FOLLOWED =
  process.env.E2E_CLIENT_FAMILY_NO_FOLLOW_UP_UUID ?? '00000000-0000-4000-8000-0000000f0012';

const configured = Boolean(BASE && FAMILY_WORK && UNIT_UUID);

type FollowUpRow = {
  uuid: string;
  status: string;
  service: { code: string | null } | null;
  social_unit: { uuid: string } | null;
};

/** Famílias do "E2E CRAS Centro" que nenhum outro bloco toca. */
const REPORT_FAMILY_STALE = '00000000-0000-4000-8000-0000000f0006';
const REPORT_FAMILY_NEW = '00000000-0000-4000-8000-0000000f0007';

let api: APIRequestContext;
let xsrf = '';
/** uuid do PAIF neste banco (o seeder gera uuid aleatório — nunca fixe). */
let paifUuid = '';

function todayIso(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function tomorrowIso(): string {
  const now = new Date();
  now.setDate(now.getDate() + 1);
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Normaliza espaços para comparar/asseverar texto de tela. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function listFollowUps(familyUuid: string): Promise<FollowUpRow[]> {
  const response = await api.get(`/api/client/families/${familyUuid}/follow-ups`);
  expect(response.status(), 'listagem de acompanhamentos').toBe(200);
  const body = (await response.json()) as { data: FollowUpRow[] };

  return body.data;
}

/** Deixa a família de trabalho SEM vigente — o registro do cenário (a) é o 1º. */
async function cancelActiveFollowUps(familyUuid: string): Promise<void> {
  for (const row of await listFollowUps(familyUuid)) {
    if (row.status !== 'active') continue;
    const response = await api.delete(
      `/api/client/families/${familyUuid}/follow-ups/${row.uuid}`,
      { headers: { 'X-XSRF-TOKEN': xsrf }, data: { cancel_reason: 'Higienização do cenário E2E.' } },
    );
    expect([200, 409], 'cancelamento de higienização').toContain(response.status());
  }
}

/** Abre o prontuário já na aba de acompanhamento (`?tab=acompanhamento`). */
async function openFollowUpTab(page: Page, familyUuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=acompanhamento`);
  await page.waitForLoadState('networkidle');
  // O modal "Novidades da versão" põe aria-hidden no fundo e cega getByRole.
  await dismissPlatformUpdates(page);
}

/** Abre o Sheet de registro e espera o primeiro carregamento de `options`. */
async function openRegisterSheet(page: Page) {
  const optionsLoaded = page.waitForResponse(
    (response) => response.url().includes('/follow-ups/options') && response.request().method() === 'GET',
  );
  await page.getByTestId('follow-up-register-action').click();
  const sheet = page.getByTestId('follow-up-form-sheet');
  await expect(sheet).toBeVisible();
  await optionsLoaded;

  return sheet;
}

/**
 * Escolhe uma opção do Select (Reka UI) e espera a reconsulta de `options`:
 * trocar data/unidade invalida a elegibilidade e o form recarrega o resto.
 */
async function selectAndAwaitOptions(page: Page, testId: string, optionName: RegExp): Promise<void> {
  const optionsLoaded = page.waitForResponse(
    (response) => response.url().includes('/follow-ups/options') && response.request().method() === 'GET',
  );
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: optionName }).first().click();
  await optionsLoaded;
}

/**
 * Contexto de API do TENANT, compartilhado pelos dois describes: ele semeia,
 * higieniza e confere o que a tela grava. Reaproveita os cookies do
 * `tests/tenant-auth.setup.ts` — nenhum login extra (throttle de 6/min).
 */
test.beforeAll(async () => {
  if (!configured) return;

  api = await createTenantApiClient();
  const state = await api.storageState();
  xsrf = decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  expect(xsrf, 'XSRF-TOKEN da sessão de tenant').not.toBe('');

  const response = await api.get(`/api/client/families/${FAMILY_WORK}/follow-ups/options`);
  expect(response.status(), 'options do acompanhamento').toBe(200);
  const body = (await response.json()) as {
    data: { services: Array<{ uuid: string; code: string | null }> };
  };
  // O uuid do PAIF é gerado pelo seeder — nunca fixe; o que é estável é o code.
  paifUuid = body.data.services.find((service) => service.code === 'PAIF')?.uuid ?? '';
  expect(paifUuid, 'PAIF ofertado ao CRAS no catálogo').not.toBe('');

  // Massa da APURAÇÃO (US-ACOMP-05), semeada aqui de propósito: é o único
  // momento em que a sessão do Operador ainda está viva — os logins do Master,
  // nos blocos finais, a derrubam. Duas famílias que nenhum outro bloco toca:
  // uma admitida há 8 meses e sem atendimento (alimenta o ponto de atenção da
  // RN11) e outra admitida HOJE (é o que acende `new_families`).
  for (const [familyUuid, admittedOn] of [
    // 6 meses, não mais: a lotação do Operador começa há exatamente 6 meses e
    // a unidade precisa ser elegível NA DATA DO INGRESSO (RN02) — datar antes
    // disso devolve 422. Seis meses também é o corte do ponto de atenção da
    // RN11, então a mesma data serve aos dois propósitos.
    [REPORT_FAMILY_STALE, monthsAgoIso(6)],
    [REPORT_FAMILY_NEW, todayIso()],
  ] as const) {
    const created = await api.post(`/api/client/families/${familyUuid}/follow-ups`, {
      headers: { 'X-XSRF-TOKEN': xsrf },
      data: {
        admitted_on: admittedOn,
        social_unit_uuid: UNIT_UUID,
        follow_up_service_uuid: paifUuid,
      },
    });
    // 409 = já semeado por execução anterior; a apuração tolera.
    expect([201, 409], `massa da apuração para ${familyUuid}`).toContain(created.status());
  }
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('US-ACOMP-02 — acompanhamento familiar no prontuário (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_UNIT_UUID em e2e/.env.e2e.',
  );

  // Os cenários compartilham a MESMA família e o estado é persistente: o
  // registro do (a) é pré-requisito do (c) e do (e).
  test.describe.configure({ mode: 'serial' });

  // ⚠️ `locale` pt-BR não é cosmético: as mensagens do BACKEND (409, 422)
  // seguem o `Accept-Language` do navegador, e é a mensagem do backend que a
  // tela exibe. Sem isto, um usuário brasileiro seria testado com o toast em
  // inglês do Chrome padrão do Playwright.
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.beforeAll(async () => {
    // A família de trabalho começa SEM vigente: o registro do (a) é o 1º, e o
    // spec continua re-executável (cancelar não apaga — o histórico cresce).
    await cancelActiveFollowUps(FAMILY_WORK!);
  });

  test('(g) família nunca acompanhada mostra o estado vazio do bloco', async ({ page }) => {
    // Guarda de integridade: se alguém acompanhou esta família, o cenário
    // deixaria de provar o que promete — melhor falhar dizendo isso.
    const existing = await listFollowUps(FAMILY_NEVER_FOLLOWED);
    expect(
      existing,
      `A família ${FAMILY_NEVER_FOLLOWED} deveria estar sem acompanhamento (defina E2E_CLIENT_FAMILY_NO_FOLLOW_UP_UUID).`,
    ).toHaveLength(0);

    await openFollowUpTab(page, FAMILY_NEVER_FOLLOWED);

    await expect(page.getByTestId('follow-up-block')).toBeVisible();
    const empty = page.getByTestId('follow-up-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/nunca foi acompanhada/i);
    // Estado vazio é ORIENTAÇÃO, não tabela vazia nem erro.
    await expect(page.getByTestId('follow-up-active')).toHaveCount(0);
    await expect(page.getByTestId('follow-up-history')).toHaveCount(0);
    await expect(page.getByTestId('follow-up-load-error')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/acomp02-g-estado-vazio.png', fullPage: true });
  });

  test('(b) num CRAS o select oferece só o PAIF — o PAEFI não é ofertado', async ({ page }) => {
    await openFollowUpTab(page, FAMILY_WORK!);
    const sheet = await openRegisterSheet(page);

    await selectAndAwaitOptions(page, 'follow-up-form-unit', new RegExp(UNIT_NAME, 'i'));
    await expect(sheet.getByTestId('follow-up-form-services-empty')).toHaveCount(0);

    await page.getByTestId('follow-up-form-service').click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText(/PAIF/);
    // A regra é o vínculo tipo↔serviço: CREAS oferta PAEFI, CRAS não.
    await expect(page.getByRole('option', { name: /PAEFI/ })).toHaveCount(0);

    await page.screenshot({ path: 'test-results/acomp02-b-servicos-do-cras.png', fullPage: true });
    await page.keyboard.press('Escape');
  });

  test('(d) data futura é barrada no próprio formulário', async ({ page }) => {
    await openFollowUpTab(page, FAMILY_WORK!);
    const sheet = await openRegisterSheet(page);

    const date = sheet.getByTestId('follow-up-form-date');
    // O bloqueio começa no campo: o seletor nativo não passa de hoje.
    await expect(date).toHaveAttribute('max', todayIso());

    // ORDEM IMPORTA, e é a do usuário real: escolhe a unidade com a data
    // padrão (hoje) e SÓ ENTÃO erra a data. Preencher a data futura primeiro
    // esvazia o select — o `options` não devolve unidade elegível para um dia
    // que ainda não chegou —, e o cenário passaria a medir o select vazio em
    // vez da recusa da data.
    await selectAndAwaitOptions(page, 'follow-up-form-unit', new RegExp(UNIT_NAME, 'i'));
    await date.fill(tomorrowIso());
    await sheet.getByTestId('follow-up-form-submit').click();

    // Nada foi gravado e a recusa é explicada na tela, com o Sheet aberto.
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(/ainda não aconteceu/i).first()).toBeVisible();
    expect(
      (await listFollowUps(FAMILY_WORK!)).some((row) => row.status === 'active'),
      'data futura não pode ter criado acompanhamento vigente',
    ).toBe(false);

    await page.screenshot({ path: 'test-results/acomp02-d-data-futura.png', fullPage: true });
  });

  test('(a) registra o ingresso no PAIF a partir de um CRAS', async ({ page }) => {
    await cancelActiveFollowUps(FAMILY_WORK!);
    await openFollowUpTab(page, FAMILY_WORK!);
    const sheet = await openRegisterSheet(page);

    await sheet.getByTestId('follow-up-form-date').fill(todayIso());
    await selectAndAwaitOptions(page, 'follow-up-form-unit', new RegExp(UNIT_NAME, 'i'));
    await page.getByTestId('follow-up-form-service').click();
    await page.getByRole('option', { name: /PAIF/ }).first().click();

    await sheet.getByTestId('follow-up-form-submit').click();
    await expect(sheet).toBeHidden();

    // A linha entra em VIGENTES, com o serviço e a unidade que acompanha.
    const active = await listFollowUps(FAMILY_WORK!);
    const created = active.find((row) => row.status === 'active');
    expect(created, 'acompanhamento vigente após o registro').toBeDefined();
    expect(created!.service?.code).toBe('PAIF');
    expect(created!.social_unit?.uuid).toBe(UNIT_UUID);

    const row = page.getByTestId(`follow-up-row-${created!.uuid}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId('follow-up-active')).toBeVisible();
    await expect(page.getByTestId('follow-up-active')).toContainText(UNIT_NAME);
    await expect(page.getByTestId(`follow-up-status-${created!.uuid}`)).toHaveAttribute(
      'data-status',
      'active',
    );
    await expect(page.getByTestId('follow-up-empty')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/acomp02-a-ingresso.png', fullPage: true });
  });

  test('(c) segundo ingresso na mesma unidade e serviço é recusado, apontando o existente', async ({
    page,
  }) => {
    const existing = (await listFollowUps(FAMILY_WORK!)).find((row) => row.status === 'active');
    expect(existing, 'pré-requisito: o ingresso do cenário (a)').toBeDefined();

    await openFollowUpTab(page, FAMILY_WORK!);
    const sheet = await openRegisterSheet(page);

    await sheet.getByTestId('follow-up-form-date').fill(todayIso());
    await selectAndAwaitOptions(page, 'follow-up-form-unit', new RegExp(UNIT_NAME, 'i'));
    await page.getByTestId('follow-up-form-service').click();
    await page.getByRole('option', { name: /PAIF/ }).first().click();
    await sheet.getByTestId('follow-up-form-submit').click();

    // 409 `follow_up_already_active`: o Sheet fecha e a tela LEVA o
    // profissional até a linha existente, em vez de um erro cego.
    await expect(sheet).toBeHidden();
    await expect(page.getByText(/já tem acompanhamento vigente/i).first()).toBeVisible();
    await expect(page.getByTestId(`follow-up-details-${existing!.uuid}`)).toBeVisible();

    // E nada foi duplicado.
    const rows = await listFollowUps(FAMILY_WORK!);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);

    await page.screenshot({ path: 'test-results/acomp02-c-duplicado.png', fullPage: true });
  });

  test('(e) cancelar com motivo mantém a linha no prontuário, marcada', async ({ page }) => {
    const target = (await listFollowUps(FAMILY_WORK!)).find((row) => row.status === 'active');
    expect(target, 'pré-requisito: o ingresso do cenário (a)').toBeDefined();

    await openFollowUpTab(page, FAMILY_WORK!);
    await page.getByTestId(`follow-up-cancel-${target!.uuid}`).click();

    const dialog = page.getByTestId('cancel-follow-up-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('cancel-follow-up-summary')).toContainText(UNIT_NAME);

    // Motivo é obrigatório: confirmar sem ele não cancela nada.
    await dialog.getByTestId('cancel-follow-up-confirm').click();
    await expect(dialog.getByTestId('cancel-follow-up-error')).toBeVisible();

    await dialog.getByTestId('cancel-follow-up-reason').fill('Lançamento feito na família errada.');
    await dialog.getByTestId('cancel-follow-up-confirm').click();
    await expect(dialog).toBeHidden();

    // CANCELAR NÃO APAGA: a linha continua visível, agora marcada.
    const row = page.getByTestId(`follow-up-row-${target!.uuid}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`follow-up-status-${target!.uuid}`)).toHaveAttribute(
      'data-status',
      'cancelled',
    );
    await expect(page.getByTestId(`follow-up-status-${target!.uuid}`)).toContainText(/cancelad/i);
    await expect(page.getByTestId('follow-up-history')).toBeVisible();

    // Motivo e autor ficam no detalhe da linha (RN11/CA09).
    await page.getByTestId(`follow-up-expand-${target!.uuid}`).click();
    const cancelInfo = page.getByTestId(`follow-up-cancel-info-${target!.uuid}`);
    await expect(cancelInfo).toBeVisible();
    await expect(cancelInfo).toContainText(/lançamento feito na família errada/i);

    const persisted = (await listFollowUps(FAMILY_WORK!)).find((r) => r.uuid === target!.uuid);
    expect(persisted?.status, 'o registro permanece, cancelado').toBe('cancelled');

    await page.screenshot({ path: 'test-results/acomp02-e-cancelado.png', fullPage: true });
  });
});

/**
 * (f) A negativa de acesso ao prontuário — e, com ele, ao bloco de
 * acompanhamento.
 *
 * ⚠️ NENHUM login aqui: a sessão herdada do project `chromium-tenant` já é a
 * do Operacional lotado no CRAS, e as rotas `/auth/*` têm throttle de 6/min.
 * A família usada é a referenciada em OUTRA unidade (CREAS).
 *
 * ⚠️ E por que este cenário se declara indisponível em vez de falhar: com a
 * US-ACOMP-04 o eixo "minha unidade ACOMPANHA" abre o prontuário de uma
 * família de outra unidade assim que ela passa a ser acompanhada pela minha.
 * Se outro cenário (ou outra suíte) deixou um acompanhamento VIGENTE da minha
 * unidade nessa família, ela deixa de ser inacessível — e o teste estaria
 * medindo o resíduo alheio, não o corte. A checagem prévia é feita pela API.
 */
test.describe('US-ACOMP-02 — negativa de acesso ao bloco de acompanhamento (client)', () => {
  test.skip(
    !(configured && FAMILY_OTHER_UNIT),
    'Defina CLIENT_BASE_URL + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_FAMILY_OTHER_UNIT_UUID.',
  );

  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test('(f) Operacional sem acesso não vê o bloco, e a negativa não nomeia unidade', async ({
    page,
  }) => {
    const probe = await api.get(`/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups`);
    test.skip(
      probe.ok(),
      `A família ${FAMILY_OTHER_UNIT} está acessível: alguma unidade em que este profissional tem lotação a ACOMPANHA (US-ACOMP-04). Sem uma família fora do alcance, o cenário não prova o corte.`,
    );

    // A negativa da API — que é a que a tela exibe — não nomeia unidade.
    expect([403, 404]).toContain(probe.status());
    const body = (await probe.json()) as { message?: string };
    const apiMessage = body.message ?? '';
    expect(apiMessage).not.toContain(UNIT_NAME);
    expect(apiMessage).not.toContain(UNIT_NOT_ASSIGNED_NAME);
    expect(apiMessage).not.toMatch(/cras|creas/i);

    await openFollowUpTab(page, FAMILY_OTHER_UNIT!);

    // Sem prontuário não há bloco: nem lista, nem ação de registrar.
    await expect(page.getByTestId('follow-up-block')).toHaveCount(0);
    await expect(page.getByTestId('follow-up-register-action')).toHaveCount(0);
    await expect(page.getByTestId('follow-up-empty')).toHaveCount(0);

    const denial = page
      .getByTestId('family-not-found')
      .or(page.getByTestId('family-access-denied'))
      .or(page.getByTestId('family-no-active-assignment'))
      .first();
    await expect(denial).toBeVisible();

    // LGPD: a negativa diz o que fazer sem revelar ONDE a família é atendida.
    const text = squash(await denial.innerText());
    expect(text).not.toContain(UNIT_NAME);
    expect(text).not.toContain(UNIT_NOT_ASSIGNED_NAME);
    expect(text).not.toMatch(/cras|creas/i);

    await page.screenshot({ path: 'test-results/acomp02-f-negativa.png', fullPage: true });
  });
});

/*
|------------------------------------------------------------------------------
| US-ACOMP-03 — desligamento com avaliação de resultados
|------------------------------------------------------------------------------
|
| Este bloco usa a fixture `page` (sessão do setup, o Operador) e por isso vem
| ANTES do bloco da US-ACOMP-04, que autentica o Master e derruba essa sessão.
| Ver o aviso de SESSÃO no cabeçalho daquele bloco.
|
*/

/** Razão de desligamento que CONFLITA com "avanço significativo" (RN10). */
const CONFLICTING_EXIT_REASON = /evas[ãa]o ou recusa da fam[íi]lia/i;
/** Razão neutra, usada no happy path. */
const NEUTRAL_EXIT_REASON = /avalia[çc][ãa]o t[ée]cnica/i;

/** Data N meses atrás — o ingresso é retroativo para os meses derivados > 0. */
function monthsAgoIso(months: number): string {
  const now = new Date();
  now.setMonth(now.getMonth() - months);

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Registra um acompanhamento vigente via API e devolve o uuid. */
async function seedActiveFollowUp(familyUuid: string, admittedOn: string): Promise<string> {
  const response = await api.post(`/api/client/families/${familyUuid}/follow-ups`, {
    headers: { 'X-XSRF-TOKEN': xsrf },
    data: {
      admitted_on: admittedOn,
      social_unit_uuid: UNIT_UUID,
      follow_up_service_uuid: paifUuid,
    },
  });
  expect(response.status(), 'ingresso semeado para o desligamento').toBe(201);

  return ((await response.json()) as { data: { uuid: string } }).data.uuid;
}

/** Escolhe uma opção no Select (Reka UI) da razão de desligamento. */
async function pickExitReason(page: Page, label: RegExp): Promise<void> {
  await page.getByTestId('discharge-form-exit-reason').click();
  await page.getByRole('option', { name: label }).first().click();
}

/** Responde as quatro perguntas fechadas do instrumento. */
async function answerAllQuestions(
  page: Page,
  answers: Record<string, string> = {
    offers_provided: 'yes',
    referrals_effective: 'not_applicable',
    family_recognizes_service: 'yes',
    outcome_classification: 'progress',
  },
): Promise<void> {
  for (const [field, value] of Object.entries(answers)) {
    await page.getByTestId(`discharge-form-answer-${field}-${value}`).check();
  }
}

test.describe('US-ACOMP-03 — desligamento e avaliação de resultados (client)', () => {
  test.skip(!configured, 'Defina CLIENT_BASE_URL + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_UNIT_UUID.');

  // Estado acumulativo: o desligamento do (a) é pré-requisito do (f) e do reingresso.
  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  /** uuid do acompanhamento vigente que os cenários desligam. */
  let followUpUuid = '';
  const ADMITTED_ON = monthsAgoIso(3);

  test.beforeAll(async () => {
    // Parte-se de UM vigente, admitido há 3 meses: sem isso os meses derivados
    // seriam zero e o cenário (c) não provaria nada.
    await cancelActiveFollowUps(FAMILY_WORK!);
    followUpUuid = await seedActiveFollowUp(FAMILY_WORK!, ADMITTED_ON);
  });

  test('(c) os meses de acompanhamento são apresentados calculados e NÃO digitáveis', async ({
    page,
  }) => {
    await openFollowUpTab(page, FAMILY_WORK!);
    await page.getByTestId(`follow-up-discharge-${followUpUuid}`).click();
    await expect(page.getByTestId('discharge-form-sheet')).toBeVisible();

    const months = page.getByTestId('discharge-form-months');
    await expect(months).toBeVisible();
    // O campo é derivado no servidor: readonly, fora da ordem de tabulação.
    await expect(months).toHaveAttribute('readonly', '');
    await expect(months).toHaveAttribute('aria-readonly', 'true');
    await expect(months).toHaveAttribute('tabindex', '-1');
    await expect(months).toHaveValue(/\d+\s+meses/i);

    // A orientação do instrumento sobre a participação da família está na tela.
    await expect(page.getByTestId('discharge-form-guidance')).toBeVisible();

    await page.screenshot({ path: 'test-results/acomp03-c-meses-readonly.png', fullPage: true });
  });

  test('(d) "não se aplica" vem sugerida quando não houve encaminhamento — e é alterável', async ({
    page,
  }) => {
    await openFollowUpTab(page, FAMILY_WORK!);
    await page.getByTestId(`follow-up-discharge-${followUpUuid}`).click();
    await expect(page.getByTestId('discharge-form-sheet')).toBeVisible();

    // Sem encaminhamento no período, o painel diz isso e a sugestão aparece.
    await expect(page.getByTestId('discharge-form-referrals-empty')).toBeVisible();
    await expect(page.getByTestId('discharge-form-suggestion-hint')).toBeVisible();

    const suggested = page.getByTestId('discharge-form-answer-referrals_effective-not_applicable');
    await expect(suggested, 'a sugestão vem pré-selecionada').toBeChecked();

    // Sugestão é sugestão: o profissional continua livre para responder outra coisa.
    await page.getByTestId('discharge-form-answer-referrals_effective-partially').check();
    await expect(suggested).not.toBeChecked();
    await expect(page.getByTestId('discharge-form-answer-referrals_effective-partially')).toBeChecked();

    // E "não se aplica" NÃO é oferecida nas outras perguntas (RN04).
    await expect(
      page.getByTestId('discharge-form-answer-offers_provided-not_applicable'),
    ).toHaveCount(0);
    await expect(
      page.getByTestId('discharge-form-answer-family_recognizes_service-not_applicable'),
    ).toHaveCount(0);

    await page.screenshot({ path: 'test-results/acomp03-d-sugestao-nao-se-aplica.png', fullPage: true });
  });

  test('(b) concluir sem a avaliação é recusado, e o acompanhamento continua vigente', async ({
    page,
  }) => {
    await openFollowUpTab(page, FAMILY_WORK!);
    await page.getByTestId(`follow-up-discharge-${followUpUuid}`).click();

    const sheet = page.getByTestId('discharge-form-sheet');
    await expect(sheet).toBeVisible();

    // Só a razão — nenhuma das perguntas, nenhum descritivo.
    await pickExitReason(page, NEUTRAL_EXIT_REASON);
    await sheet.getByTestId('discharge-form-submit').click();

    // A recusa é por pergunta, no lugar onde a resposta falta.
    await expect(sheet.getByTestId('discharge-form-question-error-offers_provided')).toBeVisible();
    await expect(sheet.getByTestId('discharge-form-question-error-outcome_classification')).toBeVisible();
    await expect(sheet, 'o formulário permanece aberto').toBeVisible();

    // ATOMICIDADE, que é o coração desta história: nada mudou de estado.
    const rows = await listFollowUps(FAMILY_WORK!);
    const target = rows.find((row) => row.uuid === followUpUuid);
    expect(target?.status, 'o acompanhamento continua vigente').toBe('active');

    await page.screenshot({ path: 'test-results/acomp03-b-sem-avaliacao-bloqueado.png', fullPage: true });
  });

  test('(e) a combinação incoerente pede confirmação — e, confirmada, é salva como informada', async ({
    page,
  }) => {
    await openFollowUpTab(page, FAMILY_WORK!);
    await page.getByTestId(`follow-up-discharge-${followUpUuid}`).click();

    const sheet = page.getByTestId('discharge-form-sheet');
    await expect(sheet).toBeVisible();

    // Razão que conflita + "avanço significativo": o instrumento não proíbe,
    // mas a combinação é improvável e merece confirmação consciente (RN10).
    await pickExitReason(page, CONFLICTING_EXIT_REASON);
    await answerAllQuestions(page, {
      offers_provided: 'partially',
      referrals_effective: 'not_applicable',
      family_recognizes_service: 'no',
      outcome_classification: 'significant_progress',
    });
    await sheet
      .getByTestId('discharge-form-achieved-results')
      .fill('Familia evadiu, porem os objetivos pactuados foram alcancados antes da evasao.');
    await sheet.getByTestId('discharge-form-submit').click();

    const dialog = page.getByTestId('confirm-incoherence-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'alertdialog');

    await page.screenshot({ path: 'test-results/acomp03-e-incoerencia-confirmacao.png', fullPage: true });

    // Cancelar devolve ao rascunho, sem gravar nada.
    await dialog.getByTestId('confirm-incoherence-cancel').click();
    await expect(dialog).toBeHidden();
    await expect(sheet, 'o rascunho continua aberto').toBeVisible();
    expect(
      (await listFollowUps(FAMILY_WORK!)).find((row) => row.uuid === followUpUuid)?.status,
      'cancelar a confirmação não desliga',
    ).toBe('active');

    // Confirmar salva EXATAMENTE como informado — o sistema não corrige o técnico.
    await sheet.getByTestId('discharge-form-submit').click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('confirm-incoherence-confirm').click();
    await expect(sheet).toBeHidden();

    const target = (await listFollowUps(FAMILY_WORK!)).find((row) => row.uuid === followUpUuid);
    expect(target?.status, 'confirmada, a incoerência é aceita').toBe('discharged');
  });

  test('(a) o desligamento aparece no prontuário com a avaliação ao lado', async ({ page }) => {
    await openFollowUpTab(page, FAMILY_WORK!);

    // A linha saiu de vigentes e está marcada como desligada.
    await expect(page.getByTestId(`follow-up-status-${followUpUuid}`)).toHaveAttribute(
      'data-status',
      'discharged',
    );
    await expect(page.getByTestId('follow-up-history')).toBeVisible();

    // Os detalhes do desligamento e a linha do tempo da avaliação vivem na
    // linha EXPANDIDA — a linha fechada mostra só o estado.
    await page.getByTestId(`follow-up-expand-${followUpUuid}`).click();
    await expect(page.getByTestId(`follow-up-discharge-info-${followUpUuid}`)).toBeVisible();
    const timeline = page.getByTestId(`follow-up-evaluations-${followUpUuid}`);
    await expect(timeline).toBeVisible();

    const evaluations = timeline.locator('[data-testid^="follow-up-evaluation-context-"]');
    await expect(evaluations.first()).toHaveAttribute('data-context', 'discharge');

    await page.screenshot({ path: 'test-results/acomp03-a-desligado-com-avaliacao.png', fullPage: true });
  });

  test('(f) a avaliação não tem ação de excluir nem de editar — e não há reabertura', async ({
    page,
  }) => {
    await openFollowUpTab(page, FAMILY_WORK!);
    await page.getByTestId(`follow-up-expand-${followUpUuid}`).click();

    const timeline = page.getByTestId(`follow-up-evaluations-${followUpUuid}`);
    await expect(timeline).toBeVisible();

    // APPEND-ONLY na interface: a ausência do botão é o requisito.
    await expect(timeline.locator('button')).toHaveCount(0);
    await expect(page.locator('[data-testid^="follow-up-evaluation-delete-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="follow-up-evaluation-edit-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="follow-up-reopen-"]')).toHaveCount(0);

    // Corrigir o desligamento existe — e é outra coisa: não cria avaliação nova.
    await expect(page.getByTestId(`follow-up-correct-discharge-${followUpUuid}`)).toBeVisible();

    await page.screenshot({ path: 'test-results/acomp03-f-sem-excluir-avaliacao.png', fullPage: true });
  });

  test('reingresso após desligamento é aceito, e a linha anterior permanece intacta', async ({
    page,
  }) => {
    // Destrava o CA05 da US-ACOMP-02, que até aqui só tinha cobertura de suíte:
    // sem o desligamento na tela, não havia como chegar a este estado.
    await openFollowUpTab(page, FAMILY_WORK!);

    const sheet = await openRegisterSheet(page);
    await selectAndAwaitOptions(page, 'follow-up-form-unit', new RegExp(UNIT_NAME, 'i'));
    await selectAndAwaitOptions(page, 'follow-up-form-service', /PAIF/i);
    await sheet.getByTestId('follow-up-form-date').fill(todayIso());
    await sheet.getByTestId('follow-up-form-submit').click();
    await expect(sheet).toBeHidden();

    const rows = await listFollowUps(FAMILY_WORK!);
    const active = rows.filter((row) => row.status === 'active');
    const discharged = rows.filter((row) => row.uuid === followUpUuid);

    expect(active, 'o reingresso na mesma unidade e serviço é aceito').toHaveLength(1);
    expect(active[0]!.uuid, 'e é uma linha NOVA').not.toBe(followUpUuid);
    expect(discharged[0]?.status, 'a linha desligada permanece intacta').toBe('discharged');

    await page.screenshot({ path: 'test-results/acomp03-reingresso.png', fullPage: true });
  });
});

/*
|------------------------------------------------------------------------------
| US-SCFV-02 — participação do integrante em serviço, programa ou projeto
|------------------------------------------------------------------------------
|
| Vive NESTE arquivo, e não em um spec próprio, pelo mesmo motivo que o bloco da
| US-ACOMP-03: os blocos finais autenticam o MASTER, e isso derruba a sessão do
| Operador no browser. Em arquivos separados os dois specs caem em workers
| paralelos e se atropelam; aqui a ordem é determinística e este bloco corre
| ANTES de qualquer login de Master.
|
*/

/**
 * Serviços e locais do bloco 16, ancorados pelo CÓDIGO.
 *
 * O select rotula as opções como `código — nome` (`lookupLabel`), e o código é
 * a parte ESTÁVEL: o nome é editável no Painel Global e mudá-lo não pode
 * quebrar este spec. O uuid, por sua vez, é gerado pelo seeder e não serve.
 */
const SCFV_ELDERLY = /^2\s*—/;
const PAIF_GROUP = /^3\s*—/;
const OTHERS_SERVICE = /^99\s*—/;
const OWN_UNIT_LOCATION = /^1\s*—/;
const OTHER_POLICY_LOCATION = /^9\s*—/;

/** Integrante vigente da família de trabalho, e o que está desvinculado (CA04). */
const ACTIVE_MEMBER = /E2E Integrante Local/i;
const UNLINKED_MEMBER = /E2E Integrante Desvinculado/i;

type ParticipationRow = {
  uuid: string;
  status: string;
  member: { uuid: string } | null;
  service: { uuid: string; code: string | null } | null;
  location: { uuid: string } | null;
};

async function listParticipations(familyUuid: string): Promise<ParticipationRow[]> {
  const response = await api.get(`/api/client/families/${familyUuid}/participations`);
  expect(response.status(), 'listagem de participações').toBe(200);

  return ((await response.json()) as { data: ParticipationRow[] }).data;
}

/** Deixa a família sem participação vigente — o registro do (a) é o primeiro. */
async function cancelActiveParticipations(familyUuid: string): Promise<void> {
  for (const row of await listParticipations(familyUuid)) {
    if (row.status !== 'active') continue;

    const response = await api.delete(
      `/api/client/families/${familyUuid}/participations/${row.uuid}`,
      {
        headers: { 'X-XSRF-TOKEN': xsrf },
        data: { cancel_reason: 'Higienização do cenário E2E da participação.' },
      },
    );
    expect([200, 409], 'cancelamento de higienização').toContain(response.status());
  }
}

/** Abre o prontuário já na aba de participação — o bloco só carrega quando ativa. */
async function openParticipationTab(page: Page, familyUuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=participacao`);
  await page.waitForLoadState('networkidle');
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId('participation-block')).toBeVisible();
}

/** Escolhe uma opção num Select (Reka UI) do formulário. */
async function pick(page: Page, testId: string, option: RegExp): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: option }).first().click();
}

test.describe('US-SCFV-02 — participação em serviços no prontuário (client)', () => {
  test.skip(!configured, 'Defina CLIENT_BASE_URL + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_UNIT_UUID.');

  // Estado acumulativo: o registro do (a) é pré-requisito do (c) e do (f).
  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.beforeAll(async () => {
    await cancelActiveParticipations(FAMILY_WORK!);
  });

  test('(h) família sem participação mostra o estado vazio, não uma tabela vazia', async ({
    page,
  }) => {
    // Família que nenhum outro cenário toca — o vazio precisa ser real.
    expect(await listParticipations(FAMILY_NEVER_FOLLOWED), 'família sem participação').toHaveLength(0);

    await openParticipationTab(page, FAMILY_NEVER_FOLLOWED);

    const empty = page.getByTestId('participation-empty');
    await expect(empty).toBeVisible();
    await expect(page.getByTestId('participation-active')).toBeHidden();
    await expect(page.getByTestId('participation-history')).toBeHidden();
    await expect(page.getByTestId('participation-load-error')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/scfv02-h-estado-vazio.png', fullPage: true });
  });

  test('(e) data futura é barrada no próprio formulário', async ({ page }) => {
    await openParticipationTab(page, FAMILY_WORK!);
    await page.getByTestId('participation-register-action').click();

    const sheet = page.getByTestId('participation-form-sheet');
    await expect(sheet).toBeVisible();

    // O bloqueio começa no campo: o seletor nativo não passa de hoje.
    await expect(sheet.getByTestId('participation-form-started-on')).toHaveAttribute(
      'max',
      todayIso(),
    );
    await expect(sheet.getByTestId('participation-form-ended-on')).toHaveAttribute('max', todayIso());

    await page.screenshot({ path: 'test-results/scfv02-e-data-futura.png', fullPage: true });
    await page.keyboard.press('Escape');
  });

  test('(b) local fora da unidade exige a identificação de onde acontece', async ({ page }) => {
    await openParticipationTab(page, FAMILY_WORK!);
    await page.getByTestId('participation-register-action').click();

    const sheet = page.getByTestId('participation-form-sheet');
    await expect(sheet).toBeVisible();

    // Na própria unidade, o campo NEM EXISTE no DOM.
    await pick(page, 'participation-form-location', OWN_UNIT_LOCATION);
    await expect(
      page.getByTestId('participation-form-location-description'),
      'na própria unidade não se pede identificação do local',
    ).toHaveCount(0);

    // Fora dela, o campo aparece — é a orientação expressa do instrumento.
    await pick(page, 'participation-form-location', OTHER_POLICY_LOCATION);
    await expect(
      page.getByTestId('participation-form-location-description'),
      'fora da unidade, a identificação passa a ser pedida',
    ).toBeVisible();

    await page.screenshot({ path: 'test-results/scfv02-b-identificacao-local.png', fullPage: true });
    await page.keyboard.press('Escape');
  });

  test('(CA15) o serviço "Outros" exige descrição; os demais não', async ({ page }) => {
    await openParticipationTab(page, FAMILY_WORK!);
    await page.getByTestId('participation-register-action').click();

    const sheet = page.getByTestId('participation-form-sheet');
    await expect(sheet).toBeVisible();

    await pick(page, 'participation-form-service', SCFV_ELDERLY);
    await expect(page.getByTestId('participation-form-other-description')).toHaveCount(0);

    // O código 99 não informa nada por si — a descrição é o que dá rastreabilidade.
    await pick(page, 'participation-form-service', OTHERS_SERVICE);
    await expect(page.getByTestId('participation-form-other-description')).toBeVisible();

    await page.screenshot({ path: 'test-results/scfv02-ca15-outros-descricao.png', fullPage: true });
    await page.keyboard.press('Escape');
  });

  test('(CA04) integrante desvinculado não é oferecido na escolha', async ({ page }) => {
    await openParticipationTab(page, FAMILY_WORK!);
    await page.getByTestId('participation-register-action').click();
    await expect(page.getByTestId('participation-form-sheet')).toBeVisible();

    await page.getByTestId('participation-form-member').click();
    await expect(page.getByRole('option', { name: ACTIVE_MEMBER })).toBeVisible();
    await expect(
      page.getByRole('option', { name: UNLINKED_MEMBER }),
      'quem saiu da composição não participa por ela',
    ).toHaveCount(0);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  test('(a) registra a participação no SCFV para idosos — happy path', async ({ page }) => {
    await openParticipationTab(page, FAMILY_WORK!);
    await page.getByTestId('participation-register-action').click();

    const sheet = page.getByTestId('participation-form-sheet');
    await expect(sheet).toBeVisible();

    await pick(page, 'participation-form-member', ACTIVE_MEMBER);
    // A unidade que DECLARA é escolha explícita: o Operador tem lotação em
    // mais de uma, então o formulário não auto-seleciona.
    await pick(page, 'participation-form-unit', new RegExp(UNIT_NAME, 'i'));
    await pick(page, 'participation-form-service', SCFV_ELDERLY);
    await pick(page, 'participation-form-location', OWN_UNIT_LOCATION);
    await sheet.getByTestId('participation-form-started-on').fill(todayIso());
    await sheet.getByTestId('participation-form-submit').click();
    await expect(sheet).toBeHidden();

    const created = (await listParticipations(FAMILY_WORK!)).find((row) => row.status === 'active');
    expect(created, 'participação vigente após o registro').toBeDefined();

    // A linha entra em "Em andamento", com o estado no atributo.
    await expect(page.getByTestId('participation-active')).toBeVisible();
    await expect(page.getByTestId(`participation-status-${created!.uuid}`)).toHaveAttribute(
      'data-status',
      'active',
    );

    await page.screenshot({ path: 'test-results/scfv02-a-registro.png', fullPage: true });
  });

  test('(c) segundo registro no mesmo serviço é recusado, apontando o existente', async ({
    page,
  }) => {
    const existing = (await listParticipations(FAMILY_WORK!)).find((row) => row.status === 'active');
    expect(existing, 'pré-requisito: o registro do cenário (a)').toBeDefined();

    await openParticipationTab(page, FAMILY_WORK!);
    await page.getByTestId('participation-register-action').click();

    const sheet = page.getByTestId('participation-form-sheet');
    await pick(page, 'participation-form-member', ACTIVE_MEMBER);
    await pick(page, 'participation-form-unit', new RegExp(UNIT_NAME, 'i'));
    await pick(page, 'participation-form-service', SCFV_ELDERLY);

    // A tela avisa ANTES de o profissional tentar salvar — sem bloquear o botão.
    await expect(page.getByTestId('participation-form-already-active-hint')).toBeVisible();

    await pick(page, 'participation-form-location', OWN_UNIT_LOCATION);
    await sheet.getByTestId('participation-form-started-on').fill(todayIso());
    await sheet.getByTestId('participation-form-submit').click();

    // A recusa NÃO vira erro dentro do formulário: o sheet fecha e a tela LEVA
    // o profissional até a participação existente, destacada e expandida.
    await expect(sheet).toBeHidden();
    await expect(
      page.getByTestId(`participation-details-${existing!.uuid}`),
      'a existente é expandida para o profissional ver qual é',
    ).toBeVisible();

    // Nada foi duplicado.
    const active = (await listParticipations(FAMILY_WORK!)).filter((row) => row.status === 'active');
    expect(active, 'a recusa não pode criar linha').toHaveLength(1);
    expect(active[0]!.uuid, 'e a vigente continua sendo a mesma').toBe(existing!.uuid);

    // RN11 — o CORPO da recusa não pode nomear a unidade que declarou. Isto
    // importa porque o índice único é por integrante + serviço e NÃO inclui a
    // unidade: a mesma recusa acontece quando a vigente foi declarada por
    // OUTRA unidade, e aí dizer qual seria vazamento.
    //
    // A asserção é sobre a resposta da API, não sobre o bloco na tela: a linha
    // expandida mostra "Unidade que declara" de propósito — é participação que
    // este profissional PODE ver, e esconder isso dele não protegeria ninguém.
    const refused = await api.post(`/api/client/families/${FAMILY_WORK}/participations`, {
      headers: { 'X-XSRF-TOKEN': xsrf },
      data: {
        family_member_uuid: existing!.member?.uuid,
        social_unit_uuid: UNIT_UUID,
        participation_service_uuid: existing!.service?.uuid,
        participation_location_uuid: existing!.location?.uuid,
        started_on: todayIso(),
      },
    });
    expect(refused.status(), 'RN07 recusa o segundo vigente').toBe(409);
    const body = (await refused.json()) as { message?: string; meta?: Record<string, unknown> };
    expect(body.message ?? '').not.toMatch(/cras|creas/i);
    expect(Object.keys(body.meta ?? {}), 'só o uuid e a data saem no meta').toEqual(
      expect.arrayContaining(['participation_uuid']),
    );

    await page.screenshot({ path: 'test-results/scfv02-c-duplicado.png', fullPage: true });
    await page.keyboard.press('Escape');
  });

  test('(d) a mesma pessoa participa de serviços diferentes ao mesmo tempo', async ({ page }) => {
    await openParticipationTab(page, FAMILY_WORK!);
    await page.getByTestId('participation-register-action').click();

    const sheet = page.getByTestId('participation-form-sheet');
    await pick(page, 'participation-form-member', ACTIVE_MEMBER);
    await pick(page, 'participation-form-unit', new RegExp(UNIT_NAME, 'i'));
    await pick(page, 'participation-form-service', PAIF_GROUP);
    await pick(page, 'participation-form-location', OWN_UNIT_LOCATION);
    await sheet.getByTestId('participation-form-started-on').fill(todayIso());
    await sheet.getByTestId('participation-form-submit').click();
    await expect(sheet).toBeHidden();

    const active = (await listParticipations(FAMILY_WORK!)).filter((row) => row.status === 'active');
    expect(active, 'as duas participações convivem').toHaveLength(2);

    await page.screenshot({ path: 'test-results/scfv02-d-simultaneas.png', fullPage: true });
  });

  test('(f) cancelar com motivo mantém a linha no prontuário, marcada', async ({ page }) => {
    const target = (await listParticipations(FAMILY_WORK!)).find((row) => row.status === 'active');
    expect(target, 'pré-requisito: uma participação vigente').toBeDefined();

    await openParticipationTab(page, FAMILY_WORK!);
    await page.getByTestId(`participation-cancel-${target!.uuid}`).click();

    const dialog = page.getByTestId('cancel-participation-dialog');
    await expect(dialog).toBeVisible();

    // Motivo é obrigatório: confirmar sem ele não cancela nada.
    await dialog.getByTestId('cancel-participation-confirm').click();
    await expect(dialog.getByTestId('cancel-participation-error')).toBeVisible();

    await dialog
      .getByTestId('cancel-participation-reason')
      .fill('Registro lançado na pessoa errada.');
    await dialog.getByTestId('cancel-participation-confirm').click();
    await expect(dialog).toBeHidden();

    // CANCELAR NÃO APAGA: a linha continua, agora marcada.
    await expect(page.getByTestId(`participation-row-${target!.uuid}`)).toBeVisible();
    await expect(page.getByTestId(`participation-status-${target!.uuid}`)).toHaveAttribute(
      'data-status',
      'cancelled',
    );
    await expect(page.getByTestId('participation-history')).toBeVisible();

    const still = (await listParticipations(FAMILY_WORK!)).find((row) => row.uuid === target!.uuid);
    expect(still?.status, 'a linha permanece, cancelada').toBe('cancelled');

    await page.screenshot({ path: 'test-results/scfv02-f-cancelada.png', fullPage: true });
  });
});

const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const TENANT_UUID = process.env.E2E_TENANT_UUID;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASSWORD = process.env.E2E_CLIENT_OPERADOR_PASSWORD;
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF;
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD;

const axisConfigured = Boolean(
  configured && TENANT_UUID && FAMILY_OTHER_UNIT && OPERADOR_CPF && OPERADOR_PASSWORD && MASTER_CPF && MASTER_PASSWORD,
);

/** uuid do acompanhamento semeado — o que o cenário (c) cancela pela tela. */
let seededFollowUpUuid = '';

/**
 * Sessão do Master MANTIDA VIVA entre o `beforeAll` e o cenário do
 * desligamento. Abrir uma segunda sessão custaria mais um login, e a suíte
 * inteira opera no limite do `throttle:6,1` das rotas `/auth/*`.
 */
let axisMasterApi: APIRequestContext | null = null;
let axisMasterXsrf = '';

/**
 * Página COMPARTILHADA pelos cenários.
 *
 * ⚠️ Não use a fixture `page`: ela nasce a cada teste com o `storageState` do
 * setup — a sessão que o login do Master (no `beforeAll`) derruba. Cada
 * cenário cairia no formulário de login, e reautenticar por cenário estoura o
 * `throttle:6,1`. Uma página só, autenticada uma vez, resolve os dois.
 */
let axisPage: Page;

/**
 * A asserção central da HU: a negativa explica os dois eixos sem entregar o
 * nome de unidade nenhuma — nem a de referência, nem a que acompanha.
 */
function expectNoUnitLeak(message: string): void {
  const text = squash(message);

  expect(text, 'a negativa não pode nomear a unidade de referência').not.toContain(
    UNIT_NOT_ASSIGNED_NAME,
  );
  expect(text, 'a negativa não pode nomear a unidade que acompanha').not.toContain(
    UNIT_NAME,
  );
  expect(text, 'a negativa não pode nomear sigla de tipo de unidade').not.toMatch(/cras|creas/i);
}

/** Abre o prontuário e devolve o que a tela mostrou. */
async function openRecord(page: Page): Promise<{ denied: boolean; message: string }> {
  await page.goto(`/app/cadastros/familias/${FAMILY_OTHER_UNIT}`);
  await page.waitForLoadState('networkidle');
  await dismissPlatformUpdates(page);

  const deniedPanel = page.getByTestId('family-access-denied');
  const denied = await deniedPanel.isVisible().catch(() => false);

  return { denied, message: denied ? squash(await deniedPanel.innerText()) : '' };
}

/**
 * Sessão do MASTER em contexto de API LIMPO. Ver o aviso de SESSÃO no topo do
 * bloco: usar o contexto compartilhado com o browser derrubaria a sessão do
 * Operador e a tela cairia no login no meio do cenário.
 */
async function openMasterSession(): Promise<{ api: APIRequestContext; xsrf: string }> {
  const api = await playwrightRequest.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: {
      Accept: 'application/json',
      Origin: BASE!,
      Referer: `${BASE}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Tenant-UUID': TENANT_UUID!,
    },
  });

  await api.get('/sanctum/csrf-cookie');
  const readXsrf = async (): Promise<string> =>
    decodeURIComponent(
      (await api.storageState()).cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value ?? '',
    );

  const login = await api.post('/api/client/auth/login', {
    headers: { 'X-XSRF-TOKEN': await readXsrf() },
    data: { cpf: MASTER_CPF, password: MASTER_PASSWORD, tenant_uuid: TENANT_UUID },
  });
  expect(login.status(), 'login do Master via API').toBe(200);

  return { api, xsrf: await readXsrf() };
}

/**
 * Estado de partida, montado pelo MASTER: a família do CREAS passa a ser
 * acompanhada pela unidade do Operador, e nada mais.
 */

test.describe('US-ACOMP-04 — acesso ao prontuário pela unidade que acompanha (client)', () => {
  test.skip(
    !axisConfigured,
    'Defina CLIENT_BASE_URL + E2E_TENANT_UUID + E2E_CLIENT_FAMILY_OTHER_UNIT_UUID + E2E_CLIENT_UNIT_UUID + E2E_CLIENT_OPERADOR_* + E2E_CLIENT_MASTER_* em e2e/.env.e2e.',
  );

  // O estado é acumulativo: (a)/(b) exigem o acompanhamento vigente, (c) o
  // cancela e só então a negativa do (d) pode ser medida.
  test.describe.configure({ mode: 'serial' });

  // `locale` não é cosmético: a mensagem de negativa vem do BACKEND.
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.beforeAll(async ({ browser }) => {
    if (!axisConfigured) return;

    const { api: masterApi, xsrf } = await openMasterSession();
    axisMasterApi = masterApi;
    axisMasterXsrf = xsrf;

    // Higieniza: o acompanhamento é persistente, e cancelar não apaga.
    const listing = await masterApi.get(`/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups`);
    expect(listing.status(), 'listagem de acompanhamentos (Master)').toBe(200);

    for (const row of ((await listing.json()) as { data: FollowUpRow[] }).data) {
      if (row.status !== 'active') continue;

      const cancelled = await masterApi.delete(
        `/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups/${row.uuid}`,
        {
          headers: { 'X-XSRF-TOKEN': xsrf },
          data: { cancel_reason: 'Higienização do cenário E2E do eixo de acesso.' },
        },
      );
      expect([200, 409], 'cancelamento de higienização').toContain(cancelled.status());
    }

    // O uuid do PAIF é gerado pelo seeder — o que é estável é o `code`.
    const options = await masterApi.get(
      `/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups/options?social_unit_uuid=${UNIT_UUID}`,
    );
    expect(options.status(), 'options do acompanhamento (Master)').toBe(200);
    const services = ((await options.json()) as {
      data: { services: Array<{ uuid: string; code: string | null }> };
    }).data.services;
    const paifUuid = services.find((service) => service.code === 'PAIF')?.uuid ?? '';
    expect(paifUuid, 'PAIF ofertado ao tipo da unidade que acompanha').not.toBe('');

    const created = await masterApi.post(`/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups`, {
      headers: { 'X-XSRF-TOKEN': xsrf },
      data: {
        admitted_on: todayIso(),
        social_unit_uuid: UNIT_UUID,
        follow_up_service_uuid: paifUuid,
      },
    });
    expect(created.status(), 'ingresso semeado pelo Master').toBe(201);
    seededFollowUpUuid = ((await created.json()) as { data: { uuid: string } }).data.uuid;

      // A sessão do Master NÃO é descartada aqui: o cenário do desligamento a
    // reaproveita (ver `axisMasterApi`).

    // Só agora o Operador entra — depois de o Master ter derrubado a sessão.
    axisPage = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
    await loginAsTenantUser(axisPage, OPERADOR_CPF!, OPERADOR_PASSWORD!, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(axisPage);
  });

  test.afterAll(async () => {
    await axisPage?.close();
    await axisMasterApi?.dispose();
    axisMasterApi = null;
  });

  test('(a) quando a minha unidade acompanha, o prontuário da família de outra unidade abre', async () => {
    const { denied } = await openRecord(axisPage);
    expect(denied, 'o eixo de acompanhamento deve conceder o acesso').toBe(false);

    // Não basta não negar: o prontuário tem de estar de fato na tela.
    await expect(axisPage.getByRole('heading', { name: /visualizar família/i })).toBeVisible();
    await expect(axisPage.locator('#family-tab-acompanhamento')).toBeVisible();

    await axisPage.screenshot({ path: 'test-results/acomp04-a-acesso-concedido.png', fullPage: true });
  });

  test('(b) o acesso é ao prontuário INTEIRO — composição, atendimentos e encaminhamentos', async () => {
    await openRecord(axisPage);

    // Pelo `id` do botão, não pelo rótulo: o texto é traduzido e acentuado.
    for (const tabId of ['composicao', 'atendimentos', 'encaminhamentos']) {
      const tab = axisPage.locator(`#family-tab-${tabId}`);
      await expect(tab, `aba ${tabId}`).toBeVisible();
      await tab.click();
      // A aba assume o painel: o corte não é por pedaço do prontuário.
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(axisPage.locator(`#family-tabpanel-${tabId}`)).toBeVisible();
      await expect(axisPage.getByTestId('family-access-denied')).toBeHidden();
    }

    await axisPage.screenshot({ path: 'test-results/acomp04-b-prontuario-inteiro.png', fullPage: true });
  });

  test('(c) cancelado NÃO concede: o acesso fecha, e a negativa declara os dois eixos sem nomear unidade', async () => {
    // ⚠️ Este cenário só é observável com a base recém-semeada — o modo oficial
    // (`npm run e2e:local`, que roda `migrate:fresh --seed`). Um acompanhamento
    // DESLIGADO de execução anterior concede acesso PARA SEMPRE (decisão D09,
    // sem prazo) e não há como removê-lo pela API: cancelar um `discharged`
    // responde 422. Nesse estado o corte não fecha, e medir isso seria medir o
    // resíduo, não a regra.
    // Reusa a sessão do `beforeAll` — sondar não justifica mais um login.
    const probe = await axisMasterApi!.get(`/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups`);
    const hasDischarged = ((await probe.json()) as { data: FollowUpRow[] }).data.some(
      (row) => row.status === 'discharged',
    );
    test.skip(
      hasDischarged,
      'Há acompanhamento DESLIGADO nesta família (resíduo de execução anterior): ele concede acesso permanentemente. Rode com a base recém-semeada (npm run e2e:local).',
    );

    // O cancelamento é feito PELA TELA, pelo próprio operador — ele já tem
    // acesso e a unidade que acompanha é a dele (RN11).
    await axisPage.goto(`/app/cadastros/familias/${FAMILY_OTHER_UNIT}?tab=acompanhamento`);
    await axisPage.waitForLoadState('networkidle');
    await dismissPlatformUpdates(axisPage);

    await axisPage.getByTestId(`follow-up-cancel-${seededFollowUpUuid}`).click();
    const dialog = axisPage.getByTestId('cancel-follow-up-dialog');
    await expect(dialog).toBeVisible();
    await dialog
      .getByTestId('cancel-follow-up-reason')
      .fill('Encerrando o vínculo de acompanhamento no cenário E2E.');
    await dialog.getByTestId('cancel-follow-up-confirm').click();
    await expect(dialog).toBeHidden();

    // Navegação seguinte: o acesso já fechou (o predicado não é memoizado).
    const { denied, message } = await openRecord(axisPage);

    expect(denied, 'acompanhamento CANCELADO não pode conceder acesso').toBe(true);
    // Os DOIS eixos são declarados — é o que distingue esta redação da
    // anterior, que só falava de unidade de referência.
    expect(message).toMatch(/referenciada/i);
    expect(message).toMatch(/acompanhada/i);
    expectNoUnitLeak(message);

    await axisPage.screenshot({
      path: 'test-results/acomp04-c-cancelado-fecha-acesso.png',
      fullPage: true,
    });
  });
  test('DESLIGADO mantém o acesso — só o cancelamento fecha (US-ACOMP-03 destrava este par)', async () => {
    // O par que faltava para a regra estar provada na interface: o cenário (c)
    // acima mostra que CANCELADO fecha; este mostra que DESLIGADO não fecha.
    // Os dois estados são mutuamente exclusivos no mesmo acompanhamento, então
    // o cenário parte de um acompanhamento NOVO, aberto e desligado pelo Master
    // — o Operador não teria como abri-lo agora, porque o cancelamento do (c)
    // fechou o acesso dele a esta família.
    // Reusa a sessão aberta no `beforeAll` — sem login novo (throttle).
    const masterApi = axisMasterApi!;
    const xsrf = axisMasterXsrf;

    // Idempotência: sobra de execução anterior devolveria 409 no `store`.
    const current = await masterApi.get(`/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups`);
    for (const row of ((await current.json()) as { data: FollowUpRow[] }).data) {
      if (row.status !== 'active') continue;
      await masterApi.delete(`/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups/${row.uuid}`, {
        headers: { 'X-XSRF-TOKEN': xsrf },
        data: { cancel_reason: 'Higienização do cenário do desligamento.' },
      });
    }

    const options = await masterApi.get(
      `/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups/options?social_unit_uuid=${UNIT_UUID}`,
    );
    expect(options.status(), 'options do acompanhamento (Master)').toBe(200);
    const paif = ((await options.json()) as {
      data: { services: Array<{ uuid: string; code: string | null }> };
    }).data.services.find((service) => service.code === 'PAIF');
    expect(paif?.uuid, 'PAIF ofertado ao tipo da unidade').toBeTruthy();

    const created = await masterApi.post(`/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups`, {
      headers: { 'X-XSRF-TOKEN': xsrf },
      data: {
        admitted_on: todayIso(),
        social_unit_uuid: UNIT_UUID,
        follow_up_service_uuid: paif!.uuid,
      },
    });
    expect(created.status(), 'acompanhamento novo para desligar').toBe(201);
    const followUpUuid = ((await created.json()) as { data: { uuid: string } }).data.uuid;

    // Razão de desligamento: o `code` é estável, o uuid é gerado pelo seeder.
    const evaluationOptions = await masterApi.get(
      `/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups/${followUpUuid}/evaluations/options`,
    );
    expect(evaluationOptions.status(), 'options da avaliação').toBe(200);
    const exitReason = ((await evaluationOptions.json()) as {
      data: { exit_reasons: Array<{ uuid: string; code: string | null }> };
    }).data.exit_reasons[0];
    expect(exitReason?.uuid, 'catálogo de razões de desligamento').toBeTruthy();

    const discharged = await masterApi.post(
      `/api/client/families/${FAMILY_OTHER_UNIT}/follow-ups/${followUpUuid}/discharge`,
      {
        headers: { 'X-XSRF-TOKEN': xsrf },
        data: {
          discharged_on: todayIso(),
          follow_up_exit_reason_uuid: exitReason!.uuid,
          offers_provided: 'yes',
          referrals_effective: 'not_applicable',
          family_recognizes_service: 'yes',
          outcome_classification: 'progress',
          achieved_results: 'Objetivos pactuados alcancados; acompanhamento encerrado no cenario E2E.',
        },
      },
    );
    // 201: o desligamento CRIA a avaliação — os dois atos são uma transação só.
    expect(discharged.status(), 'desligamento com avaliação, numa transação só').toBe(201);

    // O login do Master derrubou a sessão do Operador — reautentica uma vez.
    await loginAsTenantUser(axisPage, OPERADOR_CPF!, OPERADOR_PASSWORD!, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(axisPage);

    const { denied } = await openRecord(axisPage);
    expect(denied, 'acompanhamento DESLIGADO continua concedendo acesso').toBe(false);
    await expect(axisPage.getByRole('heading', { name: /visualizar família/i })).toBeVisible();

    // E a linha está lá, marcada como desligada — não é acesso por engano.
    await axisPage.goto(`/app/cadastros/familias/${FAMILY_OTHER_UNIT}?tab=acompanhamento`);
    await axisPage.waitForLoadState('networkidle');
    await dismissPlatformUpdates(axisPage);
    await expect(axisPage.getByTestId(`follow-up-status-${followUpUuid}`)).toHaveAttribute(
      'data-status',
      'discharged',
    );

    await axisPage.screenshot({
      path: 'test-results/acomp04-d-desligado-mantem-acesso.png',
      fullPage: true,
    });
  });
});

/*
|------------------------------------------------------------------------------
| US-ACOMP-05 — contadores de acompanhamento na apuração
|------------------------------------------------------------------------------
|
| A tela de apuração exige `attendance-reports.view`, que o Operador NÃO tem —
| é tela de gestão, do Master. Por isso este bloco tem sessão própria e vem por
| último: autenticar o Master derruba a sessão do Operador (ver o aviso de
| SESSÃO no bloco da US-ACOMP-04).
|
| Os números da apuração dependem do estado acumulado pelos blocos anteriores,
| então as asserções são sobre COMPORTAMENTO — contador aceso, perfil
| declarado, alerta presente, zero declarado — e não sobre valores exatos. Os
| valores exatos são provados pelo cenário canônico na suíte de backend, que é
| o instrumento certo para isso.
|
*/

/** Página autenticada como MASTER — a apuração é tela de gestão. */
let reportPage: Page;


/** Chaves dos perfis que dependem das fases F6/F7 — sempre indisponíveis aqui. */
const UNAVAILABLE_PROFILES = [
  'profile_bf_noncompliance',
  'profile_school_dropout',
  'profile_teen_pregnancy',
  'profile_sheltering',
];
/** Chaves dos perfis efetivamente apurados nesta entrega. */
const AVAILABLE_PROFILES = [
  'profile_extreme_poverty',
  'profile_bolsa_familia',
  'profile_child_labor',
  'profile_bpc',
];

test.describe('US-ACOMP-05 — contadores de acompanhamento na apuração (client)', () => {
  test.skip(!axisConfigured, 'Requer as credenciais do Master e o recorte de unidade.');

  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.beforeAll(async ({ browser }) => {
    // ⚠️ A massa desta tela é semeada no `beforeAll` GLOBAL do arquivo, com a
    // sessão do Operador — que a esta altura já foi derrubada pelos logins do
    // Master no bloco anterior. Semear aqui exigiria mais um login, e a suíte
    // inteira opera no limite do `throttle:6,1` das rotas `/auth/*`.
    reportPage = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
    await loginAsTenantUser(reportPage, MASTER_CPF!, MASTER_PASSWORD!, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(reportPage);

    await reportPage.goto('/app/prestacao-contas/apuracao-atendimentos');
    await reportPage.waitForLoadState('networkidle');
    await dismissPlatformUpdates(reportPage);
    await expect(reportPage.getByTestId('follow-up-counters')).toBeVisible();
  });

  test.afterAll(async () => {
    await reportPage?.close();
  });

  test('(a) os contadores do 15.6 e do 15.7 aparecem ACESOS, onde antes diziam indisponível', async () => {
    const unit = reportPage.getByTestId(`follow-up-unit-${UNIT_UUID}`);
    await expect(unit, 'bloco da unidade que acompanha').toBeVisible();

    const inFollowUp = reportPage.getByTestId(`follow-up-value-families_in_follow_up-${UNIT_UUID}`);
    const newFamilies = reportPage.getByTestId(`follow-up-value-new_families-${UNIT_UUID}`);

    // Aceso = número, não travessão. O travessão é a marca do indisponível.
    await expect(inFollowUp).toHaveText(/^\d+$/);
    await expect(newFamilies).toHaveText(/^\d+$/);
    expect(Number(await inFollowUp.innerText()), 'famílias em acompanhamento').toBeGreaterThan(0);
    expect(Number(await newFamilies.innerText()), 'novas famílias do mês').toBeGreaterThan(0);

    // E saiu do painel de indisponíveis, que era onde ele vivia.
    await expect(reportPage.getByTestId('unavailable-families_in_follow_up')).toHaveCount(0);

    await reportPage.screenshot({
      path: 'test-results/acomp05-a-contadores-acesos.png',
      fullPage: true,
    });
  });

  test('(b) os quatro perfis indisponíveis são IDENTIFICADOS com a fase de que dependem', async () => {
    const profile = reportPage.getByTestId(`new-families-profile-${UNIT_UUID}`);
    await expect(profile).toBeVisible();

    // Os OITO aparecem — nenhum é omitido.
    for (const key of [...AVAILABLE_PROFILES, ...UNAVAILABLE_PROFILES]) {
      await expect(
        reportPage.getByTestId(`new-family-${key}-${UNIT_UUID}`),
        `perfil ${key} presente`,
      ).toBeVisible();
    }

    // Os quatro pendentes dizem DE QUE FASE dependem, e o valor NÃO é zero —
    // é a distinção entre "é zero" e "ainda não apuramos", que é o ponto da HU.
    for (const key of UNAVAILABLE_PROFILES) {
      await expect(
        reportPage.getByTestId(`new-family-depends-on-${key}-${UNIT_UUID}`),
        `selo de fase em ${key}`,
      ).toBeVisible();
      await expect(reportPage.getByTestId(`new-family-value-${key}-${UNIT_UUID}`)).not.toHaveText(
        /^\d+$/,
      );
    }

    // E os quatro apurados NÃO têm selo de pendência.
    for (const key of AVAILABLE_PROFILES) {
      await expect(
        reportPage.getByTestId(`new-family-depends-on-${key}-${UNIT_UUID}`),
        `${key} não pode ter selo de fase`,
      ).toHaveCount(0);
    }

    // A nota da RN07: os perfis não são exclusivos, então a soma pode passar
    // do total de novas famílias sem que isso seja erro de cálculo.
    await expect(reportPage.getByTestId(`new-families-profile-note-${UNIT_UUID}`)).toBeVisible();

    await reportPage.screenshot({
      path: 'test-results/acomp05-b-perfis-declarados.png',
      fullPage: true,
    });
  });

  test('(c) o ponto de atenção lista acompanhamentos vigentes sem nenhum atendimento', async () => {
    const alert = reportPage.getByTestId(`stale-follow-ups-${UNIT_UUID}`);
    await expect(alert, 'alerta da RN11').toBeVisible();

    const count = reportPage.getByTestId(`stale-follow-ups-count-${UNIT_UUID}`);
    expect(Number(await count.innerText()), 'acompanhamentos sem atendimento').toBeGreaterThan(0);

    // O alerta explica o que o número significa — não é só um badge solto.
    await expect(alert).toContainText(/atendimento/i);

    await reportPage.screenshot({
      path: 'test-results/acomp05-c-ponto-de-atencao.png',
      fullPage: true,
    });
  });

  test('(e) unidade sem nenhum acompanhamento aparece com ZERO DECLARADO', async () => {
    // O selo só existe quando os dois contadores vêm apurados valendo zero —
    // é a diferença entre "apuramos e deu zero" e "não sabemos".
    const zeros = reportPage.locator('[data-testid^="follow-up-zero-declared-"]');
    await expect(zeros.first(), 'ao menos uma unidade sem acompanhamento').toBeVisible();

    // A ressalva do épico viaja com o selo: o sistema não distingue "não
    // acompanha" de "não registrou".
    await expect(zeros.first()).toHaveAttribute('title', /registr/i);

    await reportPage.screenshot({
      path: 'test-results/acomp05-e-zero-declarado.png',
      fullPage: true,
    });
  });
});

/*
|------------------------------------------------------------------------------
| US-SCFV-03 — contadores do leiaute 15.8 na apuração
|------------------------------------------------------------------------------
|
| A tela é a mesma da apuração (Master), e este bloco vem por último pela mesma
| razão dos anteriores: autenticar o Master derruba a sessão do Operador.
|
| O que estes cenários provam, e que a suíte de backend não prova: que a tela
| deixa LEGÍVEL a assimetria das três naturezas de contagem. O leiaute conta
| famílias em um campo, pessoas por idade em quatro, pessoas por SERVIÇO em um
| e pessoas com deficiência num conjunto mais amplo — e um gestor que leia sete
| números soltos conclui que a soma está errada e abre chamado.
|
*/

/** Família do integrante de 76 anos — é ele que torna a assimetria demonstrável. */
const ELDERLY_FAMILY = '00000000-0000-4000-8000-0000000f0006';

/** Página do MASTER: a apuração exige `attendance-reports.view`. */
let scfvPage: Page;

/** Lê um contador da tela, tolerando o formato pt-BR (1.234) e o travessão. */
async function counterValue(unitUuid: string, key: string): Promise<number | null> {
  const text = squash(await scfvPage.getByTestId(`scfv-value-${key}-${unitUuid}`).innerText());

  return /^\d/.test(text) ? Number(text.replace(/\./g, '')) : null;
}

async function reloadReport(): Promise<void> {
  await scfvPage.goto('/app/prestacao-contas/apuracao-atendimentos');
  await scfvPage.waitForLoadState('networkidle');
  await dismissPlatformUpdates(scfvPage);
  await expect(scfvPage.getByTestId('scfv-counters')).toBeVisible();
}

test.describe('US-SCFV-03 — contadores do leiaute 15.8 na apuração (client)', () => {
  test.skip(!axisConfigured, 'Requer as credenciais do Master e o recorte de unidade.');

  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.beforeAll(async ({ browser }) => {
    const { api: masterApi, xsrf: masterXsrf } = await openMasterSession();

    const serviceUuidByCode = async (familyUuid: string, code: string): Promise<string> => {
      const response = await masterApi.get(
        `/api/client/families/${familyUuid}/participations/options?social_unit_uuid=${UNIT_UUID}`,
      );
      expect(response.status(), 'options da participação').toBe(200);

      return (
        ((await response.json()) as {
          data: { services: Array<{ uuid: string; code: string | null }> };
        }).data.services.find((service) => service.code === code)?.uuid ?? ''
      );
    };

    // O idoso de 76 anos entra no SCFV PARA IDOSOS: é o que acende `elderly`.
    const memberList = await masterApi.get(
      `/api/client/families/${ELDERLY_FAMILY}/participations/options?social_unit_uuid=${UNIT_UUID}`,
    );
    const member = ((await memberList.json()) as {
      data: { members: Array<{ uuid: string; name: string }> };
    }).data.members.find((m) => /beneficiário/i.test(m.name));
    expect(member?.uuid, 'integrante de 76 anos na massa').toBeTruthy();

    const elderlyService = await serviceUuidByCode(ELDERLY_FAMILY, '2');
    expect(elderlyService, 'SCFV para idosos no catálogo').not.toBe('');

    const created = await masterApi.post(
      `/api/client/families/${ELDERLY_FAMILY}/participations`,
      {
        headers: { 'X-XSRF-TOKEN': masterXsrf },
        data: {
          family_member_uuid: member!.uuid,
          social_unit_uuid: UNIT_UUID,
          participation_service_uuid: elderlyService,
          participation_location_uuid: (
            (await masterApi.get(
              `/api/client/families/${ELDERLY_FAMILY}/participations/options?social_unit_uuid=${UNIT_UUID}`,
            ).then((r) => r.json())) as { data: { locations: Array<{ uuid: string; code: string }> } }
          ).data.locations.find((l) => l.code === '1')!.uuid,
          started_on: todayIso(),
        },
      },
    );
    expect([201, 409], 'participação do idoso semeada').toContain(created.status());

    await masterApi.dispose();

    scfvPage = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
    await loginAsTenantUser(scfvPage, MASTER_CPF!, MASTER_PASSWORD!, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(scfvPage);
    await reloadReport();
  });

  test.afterAll(async () => {
    await scfvPage?.close();
  });

  test('(a) os sete contadores do 15.8 aparecem, agrupados pela NATUREZA de cada contagem', async () => {
    const unit = scfvPage.getByTestId(`scfv-unit-${UNIT_UUID}`);
    await expect(unit, 'bloco da unidade').toBeVisible();

    // Os sete existem...
    for (const key of [
      'families_in_groups',
      'children_0_6',
      'preadolescents_7_14',
      'adolescents_15_17',
      'adults_18_59',
      'elderly',
      'people_with_disability',
    ]) {
      await expect(
        scfvPage.getByTestId(`scfv-value-${key}-${UNIT_UUID}`),
        `contador ${key}`,
      ).toBeVisible();
    }

    // ...e a tela os separa pela natureza da contagem, em vez de enfileirar
    // sete números que não somam entre si.
    await expect(scfvPage.getByTestId(`scfv-group-families-${UNIT_UUID}`)).toBeVisible();
    await expect(scfvPage.getByTestId(`scfv-group-age-ranges-${UNIT_UUID}`)).toBeVisible();
    await expect(scfvPage.getByTestId(`scfv-group-specific-${UNIT_UUID}`)).toBeVisible();

    // O 8º campo do leiaute vem da F1 (atendimentos) e a tela marca a origem.
    await expect(
      scfvPage.getByTestId(`scfv-value-non_continued_collective_participation-${UNIT_UUID}`),
      'o oitavo campo do 15.8 continua vindo dos atendimentos',
    ).toBeVisible();

    await scfvPage.screenshot({
      path: 'test-results/scfv03-a-sete-contadores.png',
      fullPage: true,
    });
  });

  test('(b) idosos é contado pelo SERVIÇO — a tela explica o escopo', async () => {
    const elderly = await counterValue(UNIT_UUID!, 'elderly');
    expect(elderly, 'o idoso de 76 anos no SCFV para idosos').toBeGreaterThan(0);

    // O contador de idosos NÃO é "todo mundo com 60+": a tela declara que ele
    // é restrito ao SCFV para idosos, senão o número parece faltar gente.
    await expect(
      scfvPage.getByTestId(`scfv-scope-elderly-${UNIT_UUID}`),
      'o escopo do contador de idosos é declarado na tela',
    ).toBeVisible();

    // E ele não some com o de adultos: são contadores de naturezas diferentes.
    const adults = await counterValue(UNIT_UUID!, 'adults_18_59');
    expect(adults, 'adultos é apurado à parte').not.toBeNull();

    await scfvPage.screenshot({
      path: 'test-results/scfv03-b-idosos-pelo-servico.png',
      fullPage: true,
    });
  });

  test('(c) idoso em SCFV que não é o de idosos pode não contar em faixa alguma — e a tela avisa', async () => {
    // Move o idoso do SCFV para idosos (código 2) para o SCFV de ADULTOS
    // (código 900, a extensão do produto). Ele deixa de contar em `elderly`,
    // que é restrito pelo serviço, e não entra em `adults_18_59`, que vai até
    // 59 anos: fica fora de TODA faixa. Não é erro — é a redação do leiaute.
    const { api: masterApi, xsrf: masterXsrf } = await openMasterSession();

    const options = await masterApi
      .get(`/api/client/families/${ELDERLY_FAMILY}/participations/options?social_unit_uuid=${UNIT_UUID}`)
      .then((r) => r.json()) as {
      data: {
        members: Array<{ uuid: string; name: string }>;
        services: Array<{ uuid: string; code: string | null }>;
        locations: Array<{ uuid: string; code: string }>;
      };
    };
    const member = options.data.members.find((m) => /beneficiário/i.test(m.name))!;
    const adultScfv = options.data.services.find((s) => s.code === '900')!;
    const ownUnit = options.data.locations.find((l) => l.code === '1')!;

    const current = await masterApi
      .get(`/api/client/families/${ELDERLY_FAMILY}/participations`)
      .then((r) => r.json()) as { data: Array<{ uuid: string; status: string }> };

    for (const row of current.data.filter((r) => r.status === 'active')) {
      await masterApi.delete(`/api/client/families/${ELDERLY_FAMILY}/participations/${row.uuid}`, {
        headers: { 'X-XSRF-TOKEN': masterXsrf },
        data: { cancel_reason: 'Troca de serviço no cenário E2E da assimetria do 15.8.' },
      });
    }

    const moved = await masterApi.post(`/api/client/families/${ELDERLY_FAMILY}/participations`, {
      headers: { 'X-XSRF-TOKEN': masterXsrf },
      data: {
        family_member_uuid: member.uuid,
        social_unit_uuid: UNIT_UUID,
        participation_service_uuid: adultScfv.uuid,
        participation_location_uuid: ownUnit.uuid,
        started_on: todayIso(),
      },
    });
    expect(moved.status(), 'idoso movido para o SCFV de adultos').toBe(201);
    await masterApi.dispose();

    // O login do Master derrubou a sessão da página: reautentica uma vez.
    await loginAsTenantUser(scfvPage, MASTER_CPF!, MASTER_PASSWORD!, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(scfvPage);
    await reloadReport();

    // A tela AVISA que há gente fora de toda faixa, explicando que é
    // consequência do leiaute e não erro de apuração.
    await expect(
      scfvPage.getByTestId(`scfv-elderly-outside-range-${UNIT_UUID}`),
      'o aviso do idoso fora de faixa',
    ).toBeVisible();

    await scfvPage.screenshot({
      path: 'test-results/scfv03-c-idoso-fora-de-faixa.png',
      fullPage: true,
    });
  });

  test('(e) unidade sem participação aparece com ZERO DECLARADO', async () => {
    // O selo só existe quando os contadores vêm apurados valendo zero — é a
    // diferença entre "apuramos e deu zero" e "não sabemos".
    const zeros = scfvPage.locator('[data-testid^="scfv-zero-declared-"]');
    await expect(zeros.first(), 'ao menos uma unidade sem participação').toBeVisible();

    await scfvPage.screenshot({
      path: 'test-results/scfv03-e-zero-declarado.png',
      fullPage: true,
    });
  });
});
