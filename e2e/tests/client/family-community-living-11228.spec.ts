import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { createTenantApiClient } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * US-CONV-01 (HU #11228) — convivência familiar e comunitária, aba
 * "Convivência" do prontuário, no frontend do TENANT (`client/`).
 *
 * Spec MANUAL. O cenário declarativo E2E-015 cobre CA01/CA02 (registrar e
 * "sempre morou") e CA03 (família só de adultos). Aqui ficam os critérios
 * que ele não expressa, mais uma checagem de persistência de cada um:
 *
 *  - CA01/CA02: a gravação sobrevive ao recarregamento; "sempre morou"
 *    desabilita e zera os anos;
 *  - CA04: a família com bebê (…0f0402) é perguntada sobre o lazer;
 *  - CA05: "Sem informação" é gravado como `null`, nunca como "Não";
 *  - CA07: o atalho abre a anotação com o bloco pré-escolhido e a anotação
 *    aparece no filtro por bloco (texto único por execução, `RUN_TAG`);
 *  - CA06 (por último): o Master lê a trilha `family_community_living`.
 *
 * ## Massa (E2ECommunityLivingSeeder, api)
 *
 *  - …0f0401: só adultos (lazer "não se aplica");
 *  - …0f0402: responsável adulto + criança de 1 ano (lazer se aplica).
 *
 * ## Ordem e re-execução
 *
 * Sessão do operador herdada do project `chromium-tenant`. O login do Master
 * (CA06) derruba essa sessão, por isso ele é o ÚLTIMO teste do arquivo — o
 * setup refaz a sessão do operador na execução seguinte. Os valores são
 * escritos de forma idempotente (PUT por valor) e as asserções são por valor,
 * nunca por histórico ou contagem. Nenhuma credencial, CPF ou nome é gravado
 * aqui: tudo vem do ambiente (`.env.qa`).
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8000';
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';

const FAMILY_ADULTS = '00000000-0000-4000-8000-0000000f0401';
const FAMILY_WITH_BABY = '00000000-0000-4000-8000-0000000f0402';
const UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';

const RUN_TAG = `E2E11228-${Date.now()}`;
const NOTE_TEXT = `${RUN_TAG} observação da convivência`;

const LEISURE_CHILDREN_QUESTION =
  'Existe criança ou adolescente do grupo familiar que não tem acesso a atividades de lazer, recreação e convívio social?';

let api: APIRequestContext;

test.use({ baseURL: BASE, locale: 'pt-BR' });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await createTenantApiClient();
});

test.afterAll(async () => {
  await api?.dispose();
});

async function openConvivencia(page: Page, familyUuid: string): Promise<void> {
  const loaded = page.waitForResponse(
    (res) =>
      res.url().includes(`/families/${familyUuid}/community-living`) &&
      res.request().method() === 'GET',
  );
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=convivencia`);
  await dismissPlatformUpdates(page);
  expect((await loaded).status(), 'GET da convivência').toBe(200);
  await expect(page.getByTestId('community-living-form')).toBeVisible();
}

async function save(page: Page): Promise<void> {
  const put = page.waitForResponse(
    (res) =>
      res.url().includes('/community-living') && res.request().method() === 'PUT',
  );
  await page.getByTestId('community-living-save').click();
  expect((await put).status(), 'PUT da convivência').toBe(200);
}

async function livingPayload(familyUuid: string): Promise<Record<string, unknown>> {
  const res = await api.get(`/api/client/families/${familyUuid}/community-living`);
  expect(res.status(), 'GET da convivência (API)').toBe(200);
  const body = await res.json();
  return (body.data?.community_living ?? body.data ?? body) as Record<string, unknown>;
}

test.describe('US-CONV-01 — convivência familiar e comunitária (client)', () => {
  test.skip(!BASE, 'Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.');

  test('CA01/CA02 — o registro persiste e "sempre morou" desabilita e zera os anos', async ({ page }) => {
    await openConvivencia(page, FAMILY_WITH_BABY);

    // Valor distinto a cada execução: o botão Salvar só habilita com alteração.
    const years = String(9 + (Date.now() % 60));
    const neighborhoodYears = page.getByTestId('residence-time-neighborhood-years');
    const neighborhoodAlways = page.getByTestId('residence-time-neighborhood-always');
    if (await neighborhoodAlways.isChecked()) await neighborhoodAlways.uncheck();
    await neighborhoodYears.fill(years);

    const stateAlways = page.getByTestId('residence-time-state-always');
    if (!(await stateAlways.isChecked())) await stateAlways.check();
    await expect(page.getByTestId('residence-time-state-years')).toBeDisabled();
    await expect(page.getByTestId('residence-time-state-years')).toHaveValue('');

    await page.getByTestId('community-living-threat-yes').check();
    await save(page);

    await openConvivencia(page, FAMILY_WITH_BABY);
    await expect(page.getByTestId('residence-time-neighborhood-years')).toHaveValue(years);
    await expect(page.getByTestId('residence-time-state-always')).toBeChecked();
    await expect(page.getByTestId('residence-time-state-years')).toBeDisabled();
    await expect(page.getByTestId('community-living-threat-yes')).toBeChecked();
  });

  test('CA04 — a família com criança é perguntada sobre o lazer (a sem criança não é)', async ({ page }) => {
    await openConvivencia(page, FAMILY_WITH_BABY);

    const children = page.getByTestId('leisure-children');
    await expect(children).toHaveAttribute('data-applicable', 'true');
    await expect(children).toContainText(LEISURE_CHILDREN_QUESTION);
    await expect(page.getByTestId('leisure-children-control-yes')).toBeVisible();
    await expect(page.getByTestId('leisure-children-not-applicable')).toHaveCount(0);
    await expect(page.getByTestId('community-living-pending')).toContainText(
      'Lazer de crianças e adolescentes',
    );

    // Contraste com o par: sem criança, a pergunta não tem controle.
    await openConvivencia(page, FAMILY_ADULTS);
    await expect(page.getByTestId('leisure-children')).toHaveAttribute('data-applicable', 'false');
    await expect(page.getByTestId('leisure-children-control-yes')).toHaveCount(0);
  });

  test('CA05 — "Sem informação" é gravado como nulo, e não como "Não"', async ({ page }) => {
    await openConvivencia(page, FAMILY_WITH_BABY);

    // Passa por "Não" (valor declarado) e volta a "Sem informação".
    await page.getByTestId('community-living-threat-no').check();
    await save(page);
    expect((await livingPayload(FAMILY_WITH_BABY)).suffers_threat_or_discrimination).toBe(false);

    await openConvivencia(page, FAMILY_WITH_BABY);
    await page.getByTestId('community-living-threat-unknown').check();
    await save(page);

    await openConvivencia(page, FAMILY_WITH_BABY);
    await expect(page.getByTestId('community-living-threat-unknown')).toBeChecked();
    await expect(page.getByTestId('community-living-threat-no')).not.toBeChecked();
    expect((await livingPayload(FAMILY_WITH_BABY)).suffers_threat_or_discrimination).toBeNull();
    await expect(page.getByTestId('community-living-pending')).toContainText(
      'Ameaça ou discriminação',
    );
  });

  test('CA07 — o atalho abre a anotação com o bloco pré-escolhido e ela aparece no filtro do bloco', async ({ page }) => {
    await openConvivencia(page, FAMILY_WITH_BABY);

    await page.getByTestId('community-living-note-shortcut').click();
    const sheet = page.getByTestId('family-note-form-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('family-note-block-select')).toContainText(
      'Convivência familiar e comunitária',
    );

    await page.getByTestId('family-note-unit-select').click();
    await page.getByRole('option', { name: UNIT_NAME, exact: true }).click();
    await page.getByTestId('family-note-content').fill(NOTE_TEXT);

    const created = page.waitForResponse(
      (res) => res.url().includes('/notes') && res.request().method() === 'POST',
    );
    await page.getByTestId('family-note-submit').click();
    expect((await created).status(), 'POST da anotação').toBe(201);

    // Aparece na aba Anotações, filtrando pelo bloco.
    await page.goto(`/app/cadastros/familias/${FAMILY_WITH_BABY}?tab=anotacoes`);
    await dismissPlatformUpdates(page);
    const filtered = page.waitForResponse(
      (res) =>
        res.url().includes('/notes') && res.url().includes('block=family_community_living'),
    );
    await page.getByTestId('family-note-filter-block').click();
    await page
      .getByRole('option', { name: 'Convivência familiar e comunitária', exact: true })
      .click();
    expect((await filtered).status(), 'GET filtrado por bloco').toBe(200);

    const item = page.getByTestId('family-note-item').filter({ hasText: RUN_TAG });
    await expect(item).toBeVisible();
    await expect(item.getByTestId('family-note-block-badge')).toHaveText(
      'Convivência familiar e comunitária',
    );
  });

  // Último: o login do Master derruba a sessão herdada do operador.
  test('CA06 — a correção fica na trilha do tenant, com autor e data (lida pelo Master)', async () => {
    const cpf = process.env.E2E_CLIENT_MASTER_CPF;
    const password = process.env.E2E_CLIENT_MASTER_PASSWORD;
    expect(cpf && password, 'credenciais do Master no ambiente').toBeTruthy();

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
      const xsrf = decodeURIComponent(
        (await master.storageState()).cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '',
      );
      const login = await master.post('/api/client/auth/login', {
        headers: { 'X-XSRF-TOKEN': xsrf },
        data: { cpf, password, tenant_uuid: TENANT_UUID },
      });
      expect(login.status(), 'login do Master via API').toBe(200);

      const audits = await master.get(
        '/api/client/tenant-audits?filter[log_name]=family_community_living&sort=-id&per_page=50',
      );
      expect(audits.status(), 'trilha do tenant (Master)').toBe(200);
      const rows = ((await audits.json()).data ?? []) as Array<Record<string, unknown>>;
      const updated = rows.filter((row) => row.event === 'updated');
      expect(updated.length, 'eventos updated em family_community_living').toBeGreaterThan(0);

      const latest = updated[0];
      expect(latest.created_at, 'data na trilha').toBeTruthy();
      expect(latest.causer, 'autor na trilha').toBeTruthy();
      const changes = JSON.stringify([latest.properties, latest.attribute_changes]);
      expect(changes, 'valores antigo e novo na trilha').toMatch(/suffers_threat_or_discrimination|years_in_|always_lived_in_/);
      // LGPD: a anotação livre nunca vai para a trilha da convivência.
      expect(JSON.stringify(rows)).not.toContain(RUN_TAG);
    } finally {
      await master.dispose();
    }
  });
});
