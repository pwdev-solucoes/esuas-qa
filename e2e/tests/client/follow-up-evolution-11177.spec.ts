import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { createTenantApiClient } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureFinalEvidence } from '../../helpers/evidence';

/**
 * US-EVOL-01 (HU #11177) — plano 03: evolução do acompanhamento no registro de
 * atendimento, no frontend do TENANT (`client/`, porta 4174). Spec MANUAL: o
 * cenário declarativo E2E-008 cobre `happy_path` e `empty_state` sem massa
 * própria; aqui a massa é garantida por API.
 *
 * ## O que prova
 *
 *  - CA06: com acompanhamento vigente na unidade, o formulário oferece a
 *    evolução, com um texto de ajuda sob cada campo;
 *  - CA07: salvar sem evolução funciona e não cria evolução;
 *  - CA08: família sem acompanhamento não mostra o campo;
 *  - CA09/CA12: o atendimento com evolução a mostra no histórico (sem ações) e
 *    na aba Acompanhamento; a edição a mostra só para leitura, com a unidade
 *    travada;
 *  - CA09 (API): `PUT` com `evolution` é recusado, `PUT`/`DELETE` na coleção
 *    de anotações dão 405 e a trilha não carrega o texto.
 *
 * ## Massa
 *
 * Família de trabalho: a mesma do E2E-007 (…0f0008, CRAS Centro). O spec
 * garante, por API, um acompanhamento vigente nela e NÃO o cancela no fim: o
 * E2E-008 `happy_path` depende dele.
 *
 * ⚠️ Evolução é imutável e não se apaga: todo texto leva `RUN_TAG`. Os
 * atendimentos criados são CANCELADOS no fim (contadores de apuração); a
 * evolução permanece, por regra.
 *
 * ⚠️ Sessão única: o login do Master (trilha) derruba a do operador. Por isso
 * ele só entra no ÚLTIMO caso, depois do cancelamento dos atendimentos.
 *
 * Nunca registra nem imprime CPF, nome ou texto de atendimento/evolução em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';

const FAMILY_WORK =
  process.env.E2E_CLIENT_FAMILY_EVOLUTION_UUID ?? '00000000-0000-4000-8000-0000000f0008';
const FAMILY_NEVER_FOLLOWED =
  process.env.E2E_CLIENT_FAMILY_NO_FOLLOW_UP_UUID ?? '00000000-0000-4000-8000-0000000f0012';
const UNIT_UUID = process.env.E2E_CLIENT_UNIT_UUID;
const UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';

const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? '52998224725';
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? 'senha123';

const configured = Boolean(BASE && UNIT_UUID);

const EVIDENCE_SLUG = 'us-evol-01-evolucao-no-atendimento';

const RUN_TAG = `E2E11177-${Date.now()}`;
const TEXT = {
  plain: `${RUN_TAG} atendimento sem evolução`,
  withEvolution: `${RUN_TAG} atendimento com evolução`,
  evolution: `${RUN_TAG} evolução registrada pelo atendimento`,
};

type AttendanceRow = {
  uuid: string;
  attended_on: string;
  status: string;
  description: string;
  social_unit: { uuid: string } | null;
  attendance_type: { uuid: string } | null;
  responsible_professional: { uuid: string } | null;
  evolution: { uuid: string; content: string } | null;
};

type FollowUpRow = { uuid: string; status: string; social_unit: { uuid: string } | null };

let api: APIRequestContext;
let xsrf = '';
const createdAttendances: string[] = [];

function todayIso(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * O catálogo global de tipos de atendimento NÃO vem do `E2EProntuarioSeeder`:
 * numa stack E2E recém-criada o select de tipo fica vazio e nenhum atendimento
 * se registra. Se faltar, o Super Admin (credenciais do ambiente, nunca
 * impressas) cria o tipo '1' — o mesmo do `AttendanceTypeSeeder`.
 */
async function ensureAttendanceType(): Promise<void> {
  const options = await api.get(
    `/api/client/families/${FAMILY_WORK}/attendances/options?social_unit_uuid=${UNIT_UUID}`,
  );
  expect(options.status(), 'options do atendimento').toBe(200);
  const types = ((await options.json()).data.types ?? []) as unknown[];
  if (types.length > 0) return;

  const adminOrigin = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
  const cpf = process.env.E2E_ADMIN_CPF;
  const password = process.env.E2E_ADMIN_PASSWORD;
  expect(cpf && password, 'E2E_ADMIN_CPF/E2E_ADMIN_PASSWORD para semear o tipo de atendimento').toBeTruthy();

  const admin = await playwrightRequest.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: {
      Accept: 'application/json',
      Origin: adminOrigin,
      Referer: `${adminOrigin}/auth/login`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  try {
    await admin.get('/sanctum/csrf-cookie');
    const readXsrf = async (): Promise<string> =>
      decodeURIComponent(
        (await admin.storageState()).cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value ?? '',
      );
    const login = await admin.post('/api/manager/auth/login', {
      headers: { 'X-XSRF-TOKEN': await readXsrf() },
      data: { cpf, password },
    });
    expect(login.status(), 'login do Super Admin via API').toBe(200);
    const created = await admin.post('/api/attendance-types', {
      headers: { 'X-XSRF-TOKEN': await readXsrf() },
      data: {
        code: '1',
        name: 'Atendimento socioassistencial individualizado',
        remittance_counter: 'individualized_attendance',
        is_active: true,
      },
    });
    expect([200, 201, 422], 'criação do tipo de atendimento').toContain(created.status());
  } finally {
    await admin.dispose();
  }
}

async function listAttendances(familyUuid: string): Promise<AttendanceRow[]> {
  const response = await api.get(
    `/api/client/families/${familyUuid}/attendances?per_page=50`,
  );
  expect(response.status(), 'histórico de atendimentos').toBe(200);
  return ((await response.json()).data ?? []) as AttendanceRow[];
}

/** Garante um acompanhamento vigente na unidade do operador (não o cancela no fim). */
async function ensureActiveFollowUp(familyUuid: string): Promise<void> {
  const list = await api.get(`/api/client/families/${familyUuid}/follow-ups`);
  expect(list.status(), 'listagem de acompanhamentos').toBe(200);
  const rows = ((await list.json()).data ?? []) as FollowUpRow[];
  if (rows.some((row) => row.status === 'active' && row.social_unit?.uuid === UNIT_UUID)) return;

  const options = await api.get(`/api/client/families/${familyUuid}/follow-ups/options`);
  expect(options.status(), 'options do acompanhamento').toBe(200);
  const services = ((await options.json()).data.services ?? []) as Array<{
    uuid: string;
    code: string | null;
  }>;
  const paif = services.find((service) => service.code === 'PAIF')?.uuid ?? '';
  expect(paif, 'PAIF ofertado ao CRAS no catálogo').not.toBe('');

  const created = await api.post(`/api/client/families/${familyUuid}/follow-ups`, {
    headers: { 'X-XSRF-TOKEN': xsrf },
    data: { admitted_on: todayIso(), social_unit_uuid: UNIT_UUID, follow_up_service_uuid: paif },
  });
  expect([201, 409], 'ingresso para a massa da evolução').toContain(created.status());
}

async function openAttendancesTab(page: Page, familyUuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=atendimentos`);
  await page.waitForLoadState('networkidle');
  await dismissPlatformUpdates(page);
}

/** Abre o Sheet e escolhe a unidade, esperando a reconsulta de `options`. */
async function openSheetAndPickUnit(page: Page) {
  await page.getByTestId('attendance-register-action').click();
  const sheet = page.getByTestId('attendance-form-sheet');
  await expect(sheet).toBeVisible();

  const optionsLoaded = page.waitForResponse(
    (response) =>
      response.url().includes('/attendances/options') &&
      response.url().includes('social_unit_uuid') &&
      response.request().method() === 'GET',
  );
  await page.getByTestId('attendance-form-unit').click();
  await page.getByRole('option', { name: new RegExp(UNIT_NAME, 'i') }).first().click();
  await optionsLoaded;

  return sheet;
}

/** Preenche tipo e descrição (o responsável já vem como o próprio operador). */
async function fillAndSubmit(page: Page, description: string, evolution?: string): Promise<string> {
  await page.getByTestId('attendance-form-type').click();
  await page.getByRole('option').first().click();
  await expect(page.getByTestId('attendance-form-responsible')).not.toContainText(/selecione/i);
  await page.getByTestId('attendance-form-description').fill(description);
  if (evolution !== undefined) {
    await page.getByTestId('attendance-form-evolution').fill(evolution);
  }

  const saved = page.waitForResponse(
    (response) =>
      /\/attendances$/.test(response.url()) && response.request().method() === 'POST',
  );
  await page.getByTestId('attendance-form-submit').click();
  const response = await saved;
  expect(response.status(), 'POST do atendimento').toBe(201);
  const uuid = ((await response.json()).data.uuid ?? '') as string;
  createdAttendances.push(uuid);
  await expect(page.getByTestId('attendance-form-sheet')).toBeHidden();
  return uuid;
}

test.beforeAll(async () => {
  if (!configured) return;

  api = await createTenantApiClient();
  const state = await api.storageState();
  xsrf = decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  expect(xsrf, 'XSRF-TOKEN da sessão de tenant').not.toBe('');

  await ensureActiveFollowUp(FAMILY_WORK);
  await ensureAttendanceType();
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('US-EVOL-01 — evolução do acompanhamento no atendimento (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_UNIT_UUID no arquivo de ambiente do E2E.',
  );

  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA08 — família sem acompanhamento: o formulário não oferece a evolução', async ({
    page,
  }) => {
    const followUps = await api.get(`/api/client/families/${FAMILY_NEVER_FOLLOWED}/follow-ups`);
    expect(followUps.status()).toBe(200);
    expect(
      ((await followUps.json()).data ?? []) as unknown[],
      'a família sem acompanhamento precisa continuar sem acompanhamento',
    ).toHaveLength(0);

    await openAttendancesTab(page, FAMILY_NEVER_FOLLOWED);
    await openSheetAndPickUnit(page);

    await expect(page.getByTestId('attendance-form-description')).toBeVisible();
    await expect(page.getByTestId('attendance-form-evolution')).toHaveCount(0);
    await expect(page.getByTestId('attendance-form-description-help')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/evol01-ca08-sem-campo.png' });
    await page.keyboard.press('Escape');
  });

  test('CA06/CA07 — com acompanhamento o campo aparece com as duas ajudas; salvar sem evolução não cria evolução', async ({
    page,
  }) => {
    await openAttendancesTab(page, FAMILY_WORK);
    await openSheetAndPickUnit(page);

    await expect(page.getByTestId('attendance-form-evolution')).toBeVisible();
    await expect(page.getByTestId('attendance-form-description-help')).toBeVisible();
    await expect(page.getByTestId('attendance-form-evolution-help')).toBeVisible();
    await expect(page.getByTestId('attendance-form-evolution-signature-hint')).toBeVisible();
    await page.screenshot({ path: 'test-results/evol01-ca06-campo-evolucao.png' });

    const uuid = await fillAndSubmit(page, TEXT.plain);

    const row = (await listAttendances(FAMILY_WORK)).find((item) => item.uuid === uuid);
    expect(row, 'atendimento sem evolução no histórico').toBeTruthy();
    expect(row!.evolution, 'sem evolução criada').toBeNull();

    await page.getByTestId(`attendance-expand-${uuid}`).click();
    await expect(page.getByTestId(`attendance-details-${uuid}`)).toContainText(TEXT.plain);
    await expect(page.getByTestId(`attendance-evolution-${uuid}`)).toHaveCount(0);
  });

  test('CA09/CA12 — atendimento com evolução: histórico, aba Acompanhamento e edição só leitura', async ({
    page,
  }) => {
    await openAttendancesTab(page, FAMILY_WORK);
    await openSheetAndPickUnit(page);
    const uuid = await fillAndSubmit(page, TEXT.withEvolution, TEXT.evolution);

    // Histórico: bloco da evolução, sem ações.
    await page.getByTestId(`attendance-expand-${uuid}`).click();
    const block = page.getByTestId(`attendance-evolution-${uuid}`);
    await expect(block).toBeVisible();
    await expect(block).toContainText(TEXT.evolution);
    await expect(block.getByTestId('attendance-evolution-signature')).toContainText(
      new RegExp(`${todayIso().slice(8, 10)}/${todayIso().slice(5, 7)}/${todayIso().slice(0, 4)}`),
    );
    await expect(block.getByRole('button')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/evol01-ca09-evolucao-no-historico.png' });

    // Edição: evolução só leitura, unidade travada, sem campo editável.
    await page.getByTestId(`attendance-correct-${uuid}`).click();
    const sheet = page.getByTestId('attendance-form-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('attendance-form-evolution-readonly')).toContainText(
      TEXT.evolution,
    );
    await expect(sheet.getByTestId('attendance-form-evolution')).toHaveCount(0);
    await expect(sheet.getByTestId('attendance-form-unit-locked')).toBeVisible();
    await expect(sheet.getByTestId('attendance-form-unit')).toBeDisabled();
    await page.screenshot({ path: 'test-results/evol01-ca09-edicao-evolucao-leitura.png' });
    await page.keyboard.press('Escape');

    // Aba Acompanhamento: a evolução está na lista do acompanhamento.
    await page.goto(`/app/cadastros/familias/${FAMILY_WORK}?tab=acompanhamento`);
    await page.waitForLoadState('networkidle');
    await dismissPlatformUpdates(page);
    const item = page
      .getByTestId('follow-up-evolution-item')
      .filter({ hasText: TEXT.evolution });
    await page.getByRole('button', { name: 'Ver detalhes do acompanhamento' }).first().click();
    await expect(page.getByTestId('follow-up-evolutions-error')).toHaveCount(0);
    await expect(page.getByTestId('follow-up-evolution-item').first()).toBeAttached({
      timeout: 20_000,
    });
    await item.first().scrollIntoViewIfNeeded();
    await expect(item).toBeVisible();
    await expect(item.getByTestId('follow-up-evolution-attendance')).toBeVisible();
    // Sem exclusão: a correção pelo autor existe desde a #11400.
    await expect(item.getByTestId('family-note-delete')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/evol01-ca12-evolucao-no-acompanhamento.png' });
  });

  test('CA09 — imutabilidade pela API, cancelamento dos atendimentos de teste e trilha sem o texto', async ({
    browser,
  }) => {
    // 1. O PUT do atendimento recusa `evolution`; a anotação não tem PUT/DELETE.
    const rows = await listAttendances(FAMILY_WORK);
    const withEvolution = rows.find((item) => item.evolution?.content === TEXT.evolution);
    expect(withEvolution, 'atendimento com a evolução do teste').toBeTruthy();

    const put = await api.put(
      `/api/client/families/${FAMILY_WORK}/attendances/${withEvolution!.uuid}`,
      {
        headers: { 'X-XSRF-TOKEN': xsrf },
        data: {
          attended_on: withEvolution!.attended_on,
          social_unit_uuid: withEvolution!.social_unit?.uuid,
          responsible_professional_uuid: withEvolution!.responsible_professional?.uuid,
          description: withEvolution!.description,
          evolution: `${RUN_TAG} tentativa de edição`,
        },
      },
    );
    expect(put.status(), 'PUT do atendimento com evolution').toBe(422);

    const collection = `/api/client/families/${FAMILY_WORK}/notes`;
    const putNote = await api.put(collection, { headers: { 'X-XSRF-TOKEN': xsrf }, data: {} });
    expect(putNote.status(), 'PUT na coleção de anotações').toBe(405);
    const delNote = await api.delete(collection, { headers: { 'X-XSRF-TOKEN': xsrf } });
    expect(delNote.status(), 'DELETE na coleção de anotações').toBe(405);

    // 2. Cancela os atendimentos de teste (contadores); a evolução permanece.
    for (const uuid of createdAttendances) {
      const cancel = await api.delete(`/api/client/families/${FAMILY_WORK}/attendances/${uuid}`, {
        headers: { 'X-XSRF-TOKEN': xsrf },
        data: { cancel_reason: 'Higienização do cenário E2E.' },
      });
      expect([200, 409], 'cancelamento de higienização').toContain(cancel.status());
    }
    const after = (await listAttendances(FAMILY_WORK)).find(
      (item) => item.uuid === withEvolution!.uuid,
    );
    expect(after?.status).toBe('cancelled');
    expect(after?.evolution?.content, 'a evolução permanece após o cancelamento').toBe(
      TEXT.evolution,
    );

    // 3. Trilha (Master): linha da evolução com autor e data, sem o texto.
    //    Só agora: o login do Master derruba a sessão do operador.
    const master = await playwrightRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: {
        Accept: 'application/json',
        Origin: BASE!,
        Referer: `${BASE}/app`,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Tenant-UUID': TENANT_UUID,
      },
    });
    try {
      await master.get('/sanctum/csrf-cookie');
      const readXsrf = async (): Promise<string> =>
        decodeURIComponent(
          (await master.storageState()).cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')
            ?.value ?? '',
        );
      const login = await master.post('/api/client/auth/login', {
        headers: { 'X-XSRF-TOKEN': await readXsrf() },
        data: { cpf: MASTER_CPF, password: MASTER_PASSWORD, tenant_uuid: TENANT_UUID },
      });
      expect(login.status(), 'login do Master via API').toBe(200);

      const audits = await master.get(
        '/api/client/tenant-audits?filter[log_name]=family_note&sort=-id&per_page=50',
      );
      expect(audits.status(), 'trilha do tenant (Master)').toBe(200);
      const trail = ((await audits.json()).data ?? []) as Array<Record<string, unknown>>;
      const created = trail.filter((row) => row.event === 'created');
      expect(created.length, 'linhas family_note/created na trilha').toBeGreaterThan(0);
      expect(JSON.stringify(trail), 'a trilha não carrega o texto').not.toContain(RUN_TAG);
      expect(created[0].created_at, 'data na trilha').toBeTruthy();
      expect(created[0].causer, 'autor na trilha').toBeTruthy();
    } finally {
      await master.dispose();
    }
    void browser;
  });
});
