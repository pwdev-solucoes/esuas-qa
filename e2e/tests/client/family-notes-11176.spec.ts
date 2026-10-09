import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { loginAsTenantUser } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureFinalEvidence } from '../../helpers/evidence';

/**
 * US-ANOT-01 (HU #11176) — aba Anotações do prontuário, no Painel do Tenant
 * (`client/`). Spec MANUAL multiusuário: cobre o que o cenário declarativo
 * E2E-006 (um único usuário) não alcança.
 *
 * ## Triagem dos CAs
 *
 * Navegador (aqui): CA03/CA08 (blocos Geral e Convivência), CA07 (filtro),
 * CA09/CA10 (outra unidade lê pelo eixo do encaminhamento).
 * API (aqui): CA04 (PUT/DELETE = 405), CA05 (trilha sem o texto), CA11 (403
 * `unit_not_assigned`). Pest cobre o isolamento entre municípios (CA12).
 *
 * ## Arranjo (⚠️ sessão única)
 *
 * O login de um usuário derruba a sessão do outro. Por isso a ordem é fixa:
 *  1. o Master, em contexto de API PRÓPRIO, escreve a massa (anotações pelo
 *     CREAS e na família de trabalho), prova o 405 e confere a trilha;
 *  2. SÓ ENTÃO o operador (CRAS Centro) loga pela interface — 1 login do
 *     Master + 1 do operador por execução, dentro do throttle de 6 req/min.
 *
 * ## Massa (E2EProntuarioSeeder, sem alterá-lo)
 *
 * - família na unidade: `E2E_CLIENT_FAMILY_IN_UNIT_UUID` (…0f0001);
 * - família inacessível ao operador: `E2E_CLIENT_FAMILY_OTHER_UNIT_UUID` (…0f0002, CREAS);
 * - família referenciada no CREAS e encaminhada ao CRAS Centro: …0f0014.
 *
 * ⚠️ Anotações são IMUTÁVEIS e não se apagam: toda asserção usa um texto único
 * por execução (`RUN_TAG`) e o filtro — nunca uma contagem absoluta.
 * Nunca registra nem imprime CPF, nome ou texto de anotação em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';

const FAMILY_WORK = process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID;
const FAMILY_OTHER_UNIT = process.env.E2E_CLIENT_FAMILY_OTHER_UNIT_UUID;
const FAMILY_RECEIVED =
  process.env.E2E_CLIENT_FAMILY_RECEIVED_REFERRAL_UUID ??
  '00000000-0000-4000-8000-0000000f0014';

const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? '52998224725';
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? 'senha123';
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF ?? '11144477735';
const OPERADOR_PASSWORD = process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? 'senha123';

const OPERATOR_UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';

const configured = Boolean(BASE && FAMILY_WORK && FAMILY_OTHER_UNIT);

const EVIDENCE_SLUG = 'us-anot-01-anotacoes-prontuario';

/** Texto único por execução: as anotações não se apagam. */
const RUN_TAG = `E2E11176-${Date.now()}`;
const TEXT = {
  creas: `${RUN_TAG} anotação do CREAS`,
  health: `${RUN_TAG} saúde`,
  housing: `${RUN_TAG} habitação`,
  general: `${RUN_TAG} geral`,
  uiGeneral: `${RUN_TAG} geral pela tela`,
  uiCoexistence: `${RUN_TAG} convivência pela tela`,
};

type NoteOptions = {
  units: Array<{ uuid: string; name: string }>;
  blocks: Array<{ value: string; label: string; notice: string | null }>;
  can_register: boolean;
};

type NoteRow = {
  uuid: string;
  block: { value: string; label: string };
  signature: { unit_name: string | null; role_label: string | null };
  created_at: string;
};

let masterApi: APIRequestContext;
let masterXsrf = '';
let operatorPage: Page;

async function openMasterSession(): Promise<{ api: APIRequestContext; xsrf: string }> {
  const api = await playwrightRequest.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: {
      Accept: 'application/json',
      Origin: BASE!,
      Referer: `${BASE}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Tenant-UUID': TENANT_UUID,
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

async function masterOptions(familyUuid: string): Promise<NoteOptions> {
  const res = await masterApi.get(`/api/client/families/${familyUuid}/notes/options`);
  expect(res.status(), 'options das anotações (Master)').toBe(200);
  return (await res.json()).data as NoteOptions;
}

/** Registra pelo Master; devolve a anotação criada (resource, sem ids internos). */
async function masterRegister(
  familyUuid: string,
  unitUuid: string,
  block: string,
  content: string,
): Promise<NoteRow> {
  const res = await masterApi.post(`/api/client/families/${familyUuid}/notes`, {
    headers: { 'X-XSRF-TOKEN': masterXsrf },
    data: { social_unit_uuid: unitUuid, block, content },
  });
  expect(res.status(), `POST de anotação (${block})`).toBe(201);
  return (await res.json()).data as NoteRow;
}

async function openNotesTab(familyUuid: string): Promise<void> {
  await operatorPage.goto(`/app/cadastros/familias/${familyUuid}?tab=anotacoes`);
  await dismissPlatformUpdates(operatorPage);
}

async function pickOption(testId: string, name: string): Promise<void> {
  await operatorPage.getByTestId(testId).click();
  await operatorPage.getByRole('option', { name, exact: true }).click();
}

test.beforeAll(async ({ browser }) => {
  if (!configured) return;

  const session = await openMasterSession();
  masterApi = session.api;
  masterXsrf = session.xsrf;

  // Massa da família de trabalho: três blocos distintos (CA07).
  const work = await masterOptions(FAMILY_WORK!);
  expect(work.units.length, 'o Master precisa de ao menos uma unidade para assinar').toBeGreaterThan(0);
  const workUnit = work.units[0].uuid;
  const health = await masterRegister(FAMILY_WORK!, workUnit, 'health_conditions', TEXT.health);
  // Gestão municipal (CA02b): Master sem lotação assina com o rótulo, não com função.
  expect(health.signature.role_label, 'assinatura do Master sem lotação').toBe('Gestão municipal');
  await masterRegister(FAMILY_WORK!, workUnit, 'housing_conditions', TEXT.housing);
  await masterRegister(FAMILY_WORK!, workUnit, 'general', TEXT.general);

  // Anotação pelo CREAS na família referenciada no CREAS (CA09/CA10).
  const received = await masterOptions(FAMILY_RECEIVED);
  const creas = received.units.find((unit) => /creas/i.test(unit.name)) ?? received.units[0];
  expect(creas, 'unidade CREAS nas opções do Master').toBeTruthy();
  await masterRegister(FAMILY_RECEIVED, creas.uuid, 'general', TEXT.creas);

  // CA04 — imutável: PUT e DELETE na coleção respondem 405.
  const collection = `/api/client/families/${FAMILY_WORK}/notes`;
  const put = await masterApi.put(collection, {
    headers: { 'X-XSRF-TOKEN': masterXsrf },
    data: { content: 'x' },
  });
  expect(put.status(), 'PUT na coleção de anotações').toBe(405);
  const del = await masterApi.delete(collection, { headers: { 'X-XSRF-TOKEN': masterXsrf } });
  expect(del.status(), 'DELETE na coleção de anotações').toBe(405);

  // CA05 — a trilha tem autor, data e bloco, e NUNCA o texto.
  const audits = await masterApi.get(
    '/api/client/tenant-audits?filter[log_name]=family_note&sort=-id&per_page=50',
  );
  expect(audits.status(), 'trilha do tenant (Master)').toBe(200);
  const rows = ((await audits.json()).data ?? []) as Array<Record<string, unknown>>;
  const created = rows.filter((row) => row.event === 'created');
  expect(created.length, 'linhas family_note/created na trilha').toBeGreaterThan(0);
  expect(JSON.stringify(rows), 'a trilha não carrega o texto da anotação').not.toContain(RUN_TAG);
  expect(created[0].created_at, 'data na trilha').toBeTruthy();
  expect(created[0].causer, 'autor na trilha').toBeTruthy();
  expect(
    JSON.stringify([created[0].properties, created[0].attribute_changes]),
    'bloco na trilha',
  ).toMatch(/health_conditions|housing_conditions|general/);

  // SÓ AGORA o operador entra: o login do Master derrubaria a sessão dele.
  operatorPage = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
  await loginAsTenantUser(operatorPage, OPERADOR_CPF, OPERADOR_PASSWORD, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(operatorPage);
});

test.afterAll(async () => {
  await operatorPage?.close();
  await masterApi?.dispose();
});

test.describe('US-ANOT-01 — anotações qualitativas do prontuário (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_FAMILY_OTHER_UNIT_UUID no arquivo de ambiente do E2E.',
  );

  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.afterEach(async ({}, testInfo) => {
    await captureFinalEvidence(operatorPage, testInfo, EVIDENCE_SLUG);
  });

  test('CA09/CA10 — o operador do CRAS Centro lê a anotação feita pelo CREAS (eixo do encaminhamento)', async () => {
    await openNotesTab(FAMILY_RECEIVED);

    const item = operatorPage.getByTestId('family-note-item').filter({ hasText: TEXT.creas });
    await expect(item).toBeVisible();
    await expect(item.getByTestId('family-note-signature')).toContainText(/creas/i);
    await expect(item.getByTestId('family-note-block-badge')).toHaveText('Geral (família)');
  });

  test('CA07 — o filtro mostra só as anotações do bloco, da mais recente para a mais antiga', async () => {
    await openNotesTab(FAMILY_WORK!);

    await expect(
      operatorPage.getByTestId('family-note-item').filter({ hasText: TEXT.health }),
    ).toBeVisible();
    await expect(
      operatorPage.getByTestId('family-note-item').filter({ hasText: TEXT.housing }),
    ).toBeVisible();

    // Ordem da API: a geral foi gravada por último, então vem antes da de saúde.
    const texts = await operatorPage.getByTestId('family-note-content-text').allInnerTexts();
    const tagged = texts.map((text) => text.trim()).filter((text) => text.includes(RUN_TAG));
    expect(tagged.indexOf(TEXT.general)).toBeGreaterThanOrEqual(0);
    expect(tagged.indexOf(TEXT.general)).toBeLessThan(tagged.indexOf(TEXT.health));

    const filtered = operatorPage.waitForResponse(
      (res) => res.url().includes('/notes') && res.url().includes('block=health_conditions'),
    );
    await operatorPage.getByTestId('family-note-filter-block').click();
    await operatorPage.getByRole('option', { name: 'Condições de saúde', exact: true }).click();
    expect((await filtered).status(), 'GET filtrado').toBe(200);

    await expect(
      operatorPage.getByTestId('family-note-item').filter({ hasText: TEXT.health }),
    ).toBeVisible();
    await expect(
      operatorPage.getByTestId('family-note-item').filter({ hasText: TEXT.housing }),
    ).toHaveCount(0);
    for (const badge of await operatorPage.getByTestId('family-note-block-badge').all()) {
      await expect(badge).toHaveText('Condições de saúde');
    }

    // Bloco sem nenhuma anotação na massa: vazio do filtro, não o vazio geral.
    await operatorPage.getByTestId('family-note-filter-block').click();
    await operatorPage.getByRole('option', { name: 'Medidas socioeducativas', exact: true }).click();
    await expect(operatorPage.getByTestId('family-notes-empty-filtered')).toBeVisible();
    await expect(operatorPage.getByText('Nenhuma anotação deste bloco')).toBeVisible();
  });

  test('CA03/CA08 — "Geral (família)" e "Convivência familiar e comunitária" são salvos normalmente', async () => {
    await openNotesTab(FAMILY_WORK!);

    const cases: Array<[string, string]> = [
      ['Geral (família)', TEXT.uiGeneral],
      ['Convivência familiar e comunitária', TEXT.uiCoexistence],
    ];

    for (const [blockLabel, text] of cases) {
      await operatorPage.getByTestId('family-note-register-action').click();
      await expect(operatorPage.getByTestId('family-note-form-sheet')).toBeVisible();
      await pickOption('family-note-unit-select', OPERATOR_UNIT_NAME);
      await pickOption('family-note-block-select', blockLabel);
      await operatorPage.getByTestId('family-note-content').fill(text);

      const created = operatorPage.waitForResponse(
        (res) => res.url().includes('/notes') && res.request().method() === 'POST',
      );
      await operatorPage.getByTestId('family-note-submit').click();
      expect((await created).status(), `POST (${blockLabel})`).toBe(201);

      const item = operatorPage.getByTestId('family-note-item').filter({ hasText: text });
      await expect(item).toBeVisible();
      await expect(item.getByTestId('family-note-block-badge')).toHaveText(blockLabel);
      await expect(item.getByTestId('family-note-signature')).toContainText(OPERATOR_UNIT_NAME);
      // Imutável: o card não tem nenhuma ação.
      await expect(item.locator('button')).toHaveCount(0);
    }
  });

  test('CA11 — na família de outra unidade, sem eixo, a API de anotações responde 403 unit_not_assigned', async () => {
    const res = await operatorPage.request.get(
      `${API_BASE}/api/client/families/${FAMILY_OTHER_UNIT}/notes`,
      {
        headers: {
          Accept: 'application/json',
          Origin: BASE!,
          Referer: `${BASE}/app`,
          'X-Requested-With': 'XMLHttpRequest',
          'X-Tenant-UUID': TENANT_UUID,
        },
      },
    );
    expect(res.status(), 'GET notes em família inacessível').toBe(403);
    const body = (await res.json()) as { error_code?: string; message?: string };
    expect(body.error_code).toBe('unit_not_assigned');
    // LGPD: a mensagem não nomeia unidade.
    expect((body.message ?? '').toLowerCase()).not.toMatch(/creas|cras/);

    await openNotesTab(FAMILY_OTHER_UNIT!);
    await expect(operatorPage.getByTestId('family-access-denied')).toBeVisible();
  });
});
