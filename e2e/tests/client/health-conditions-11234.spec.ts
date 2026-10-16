import { expect, test, type Page } from '@playwright/test';
import { loginAsTenantUser } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence, captureFinalEvidence } from '../../helpers/evidence';

/**
 * US-DIAG2-05 (HU #11234) — condições de saúde completas, restritas a quem
 * CONDUZ o caso, no frontend do TENANT (`client/`). Spec MANUAL: os cenários
 * declarativos E2E-019 (Centro e CREAS leem e registram; CT05) e E2E-020 (Rural
 * não vê) cobrem o mesmo núcleo; aqui ficam as asserções que o cenário não
 * expressa (aviso de leitores com o texto, payload do CA05) e os prints do
 * dossiê, NESTA ORDEM, com um login por usuário (três logins, dentro do
 * throttle de 6/min):
 *
 *  1. CRAS Centro (referência da família): CA01, CA07, CA08;
 *  2. CREAS (PAEFI vigente): CA02;
 *  3. CRAS Rural (só encaminhamento recebido): CA03, CA04, CA05 — a evidência
 *     de CA03 e CA04 é a AUSÊNCIA da aba Saúde e da seção de saúde.
 *
 * ## Massa (E2EHealthVisibilitySeeder, api)
 * "E2E Silva Saúde" …0f1234: José (responsável), Pedro (has_disability, retrato
 * migrado com doença grave) e Ana (16 anos, gestação sem meses). Rode o seeder
 * ANTES de cada execução (poda os retratos `recorded` e zera meses/pré-natal).
 *
 * ## Credenciais (só por variável de ambiente; nada é gravado aqui)
 * E2E_CLIENT_OPERADOR_CPF/PASSWORD (Centro), E2E_CLIENT_CREAS_OPERADOR_CPF/
 * PASSWORD (CREAS, da #11227) e E2E_CLIENT_RURAL_CPF/PASSWORD (Rural).
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';
const FAMILY =
  process.env.E2E_CLIENT_FAMILY_HEALTH_UUID ?? '00000000-0000-4000-8000-0000000f1234';
const UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';
const EVIDENCE_SLUG = '11234-condicoes-de-saude-completas';

const NOTICE =
  'Este registro será lido apenas pela unidade de referência da família, pelas unidades que a acompanham e pelo gestor Master.';

const CREDENTIALS = {
  centro: [process.env.E2E_CLIENT_OPERADOR_CPF, process.env.E2E_CLIENT_OPERADOR_PASSWORD],
  creas: [
    process.env.E2E_CLIENT_CREAS_OPERADOR_CPF,
    process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD,
  ],
  rural: [process.env.E2E_CLIENT_RURAL_CPF, process.env.E2E_CLIENT_RURAL_PASSWORD],
} as const;

const configured =
  Boolean(BASE) && Object.values(CREDENTIALS).every(([cpf, password]) => Boolean(cpf && password));

const MEMBER_ROW = (name: string) =>
  `tr[data-testid^="member-row-"]:has-text("${name}") [data-testid^="member-conditions-"]`;

let centro: Page;
let creas: Page;
let rural: Page;
let active: Page;

test.use({ baseURL: BASE, locale: 'pt-BR', viewport: { width: 1440, height: 1600 } });
test.describe.configure({ mode: 'serial' });

async function open(page: Page, tab: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=${tab}`);
  await dismissPlatformUpdates(page);
}

async function openMemberDrawer(page: Page, name: string): Promise<void> {
  await open(page, 'composicao');
  const button = page.locator(MEMBER_ROW(name));
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  await expect(page.getByTestId('member-conditions-drawer')).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async ({ browser }) => {
  if (!configured) return;

  const logins: Array<[keyof typeof CREDENTIALS, (page: Page) => void]> = [
    ['centro', (page) => (centro = page)],
    ['creas', (page) => (creas = page)],
    ['rural', (page) => (rural = page)],
  ];

  // Um login por usuário, em sequência (throttle 6/min), cada um na própria página.
  for (const [who, assign] of logins) {
    const page = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
    const [cpf, password] = CREDENTIALS[who];
    await loginAsTenantUser(page, cpf!, password!, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(page);
    assign(page);
  }
});

test.afterAll(async () => {
  await Promise.all([centro?.close(), creas?.close(), rural?.close()]);
});

test.afterEach(async ({}, testInfo) => {
  if (active) await captureFinalEvidence(active, testInfo, EVIDENCE_SLUG);
});

test.describe('US-DIAG2-05 — condições de saúde completas (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL e as credenciais do Centro, do CREAS e do Rural (ver o cabeçalho).',
  );

  test('CA01/CA07 — o Centro registra saúde da família e do integrante e vê o aviso de quem vai ler', async ({}, testInfo) => {
    active = centro;
    await open(centro, 'saude');

    const block = centro.getByTestId('health-block');
    await expect(block.locator('[data-testid^="snapshot-alter-"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await block.locator('[data-testid^="snapshot-alter-"]').first().click();
    await centro.getByTestId('snapshot-kind-update').click();

    const form = centro.getByTestId('health-snapshot-fields');
    await expect(form).toBeVisible({ timeout: 15_000 });
    // CA07 — o aviso já está no formulário, com o texto do backend.
    await expect(form.getByTestId('health-reader-notice')).toHaveText(NOTICE);

    await centro.getByTestId('health-food-insecurity-yes').click();
    await centro.locator('[data-testid$="-alcohol-yes"]').first().click();
    await centro.getByTestId('diagnosis-snapshot-unit-select').click();
    await centro.getByRole('option', { name: UNIT_NAME }).click();

    const saved = centro.waitForResponse(
      (res) => res.url().includes('/diagnosis-snapshots') && res.request().method() === 'POST',
    );
    await centro.getByTestId('diagnosis-snapshot-submit').click();
    expect((await saved).status(), 'POST do retrato de saúde').toBe(201);

    // CA07 — depois de salvar, o aviso segue na tela.
    await expect(centro.getByTestId('health-saved-notice')).toHaveText(NOTICE);
    await expect(block).toContainText('Sim');
    await expect(block).toContainText('álcool');
    await captureEvidence(centro, testInfo, EVIDENCE_SLUG, 'retrato-saude');
  });

  test('CA08 — o Centro detalha a gestação de Ana com 5 meses e pré-natal iniciado', async ({}, testInfo) => {
    active = centro;
    await openMemberDrawer(centro, 'E2E Saúde Ana');

    const block = centro.getByTestId('member-pregnancy-block');
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.locator('[data-testid^="member-pregnancy-details-edit-"]').click();
    await block.locator('input[data-testid^="member-pregnancy-edit-months-"]').fill('5');
    await block
      .locator('[data-testid^="member-pregnancy-edit-prenatal-"][data-testid$="-yes"]')
      .click();

    const patched = centro.waitForResponse(
      (res) => res.url().includes('/pregnancies/') && res.request().method() === 'PATCH',
    );
    await block.locator('[data-testid^="member-pregnancy-edit-save-"]').click();
    expect((await patched).status(), 'PATCH da gestação').toBe(200);

    await expect(block).toContainText('5 meses');
    await expect(block).toContainText('Já iniciou pré-natal: Sim');
    await captureEvidence(centro, testInfo, EVIDENCE_SLUG, 'gestacao-detalhada');
  });

  test('CA02 — o CREAS, com acompanhamento vigente, abre a aba Saúde e lê os valores', async ({}, testInfo) => {
    active = creas;
    await open(creas, 'saude');

    const block = creas.getByTestId('health-block');
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block.getByTestId('snapshot-series')).toBeVisible({ timeout: 15_000 });
    await expect(block).toContainText('álcool');
    await expect(block).toContainText('Sim');
    await captureEvidence(creas, testInfo, EVIDENCE_SLUG, 'creas-le');
  });

  test('CA03 — o Rural abre o prontuário e a evidência é a AUSÊNCIA da aba Saúde', async ({}, testInfo) => {
    active = rural;
    await open(rural, 'saude');

    await expect(rural.getByRole('heading', { name: /visualizar família/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(rural.getByTestId('family-access-denied')).toHaveCount(0);
    await expect(rural.getByRole('tab', { name: 'Composição Familiar', exact: true })).toBeVisible();
    // Ausência: nem a aba, nem o bloco, mesmo pedindo ?tab=saude.
    await expect(rural.getByRole('tab', { name: 'Saúde', exact: true })).toHaveCount(0);
    await expect(rural.getByTestId('health-block')).toHaveCount(0);
    await captureEvidence(rural, testInfo, EVIDENCE_SLUG, 'rural-sem-aba-saude');
  });

  test('CA04 — as telas de Pedro e de Ana não têm seção de saúde nem gestações (ausência)', async ({}, testInfo) => {
    active = rural;
    await openMemberDrawer(rural, 'E2E Saúde Pedro');
    await expect(rural.getByTestId('member-section-work_income_conditions')).toBeVisible();
    await expect(rural.getByTestId('member-section-health_conditions')).toHaveCount(0);
    await expect(rural.getByTestId('member-pregnancy-block')).toHaveCount(0);
    await captureEvidence(rural, testInfo, EVIDENCE_SLUG, 'pedro');

    await rural.keyboard.press('Escape');
    await openMemberDrawer(rural, 'E2E Saúde Ana');
    await expect(rural.getByTestId('member-section-work_income_conditions')).toBeVisible();
    await expect(rural.getByTestId('member-section-health_conditions')).toHaveCount(0);
    await expect(rural.getByTestId('member-pregnancy-block')).toHaveCount(0);
    await captureEvidence(rural, testInfo, EVIDENCE_SLUG, 'ana');
  });

  test('CA05 — a composição traz a marcação de deficiência de Pedro, sem o tipo', async ({}, testInfo) => {
    active = rural;
    const details = rural.waitForResponse(
      (res) =>
        res.url().includes(`/families/${FAMILY}/details`) && res.request().method() === 'GET',
    );
    await open(rural, 'composicao');
    const response = await details;
    expect(response.status(), 'GET details').toBe(200);

    const members: Array<Record<string, unknown>> = (await response.json()).data.members;
    const pedro = members.find((member) => member.name === 'E2E Saúde Pedro');
    expect(pedro, 'Pedro na composição').toBeDefined();
    expect(pedro!.has_disability).toBe(true);
    // Ausência: nenhuma chave de tipo de deficiência nem de saúde no payload.
    expect(
      Object.keys(pedro!).filter((key) => /disability_type|serious_illness|pregnanc/i.test(key)),
    ).toEqual([]);
    await expect(rural.getByTestId('composition-current')).toBeVisible({ timeout: 15_000 });
    await captureEvidence(rural, testInfo, EVIDENCE_SLUG, 'composicao-deficiencia');
  });
});
