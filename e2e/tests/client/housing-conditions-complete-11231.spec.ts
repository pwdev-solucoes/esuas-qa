import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { createTenantApiClient } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * US-DIAG2-02 (HU #11231) — condições habitacionais completas, no frontend do
 * TENANT (`client/`). Spec MANUAL. O cenário declarativo E2E-016 cobre CA01
 * (registrar os onze itens), CA02 (pessoas por dormitório 2,5) e D04
 * (zero cômodos recusado pela faixa; a recusa por dormitórios acima de cômodos,
 * RN03/CA04 da #11231, foi revogada pela #11407). Aqui ficam o que ele não expressa:
 *
 *  - CA03: sem dormitórios, pessoas por dormitório mostra "Sem informação"
 *    (a evidência é a AUSÊNCIA de valor, nunca zero);
 *  - D04 (faixa): zero cômodos mostra o erro de faixa no campo de cômodos;
 *  - CT05: a família importada do CadÚnico, sem retrato, abre o formulário com
 *    todos os itens vazios e nenhum selo "CadÚnico" (a evidência é a AUSÊNCIA
 *    do selo). O CA05 NÃO é demonstrável com a importação atual (D08/A1);
 *  - CA06: o painel de apoio à vulnerabilidade mostra os valores respondidos
 *    ("Sim / Sem informação / Não") e continua sem campo de entrada.
 *
 * ## Massa (E2EHousingCompleteSeeder, api)
 *
 *  - …000001123101 "E2E Silva Habitação": 5 integrantes ativos, retrato migrado;
 *  - …000001123102 "E2E Souza Importada": origin cadunico, sem retrato.
 *
 * ## Re-execução
 *
 * Nenhum teste grava retrato: todos fecham o formulário sem salvar. As
 * asserções não dependem de quantos retratos a Silva já tem (o E2E-016 cria
 * um por execução). Sessão do operador herdada do project `chromium-tenant`.
 * Nenhuma credencial, CPF ou nome é gravado aqui.
 */

const BASE = process.env.CLIENT_BASE_URL;

const FAMILY_SILVA = '00000000-0000-4000-8000-000001123101';
const FAMILY_SOUZA = '00000000-0000-4000-8000-000001123102';
const UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';

let api: APIRequestContext;

test.use({ baseURL: BASE, locale: 'pt-BR', viewport: { width: 1440, height: 2300 } });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (!BASE) return;
  api = await createTenantApiClient();
});

test.afterAll(async () => {
  await api?.dispose();
});

function block(page: Page): Locator {
  return page.getByTestId('housing-condition-block');
}

/** Abre a aba Habitação e o formulário de atualização (ou o primeiro registro). */
async function openForm(page: Page, familyUuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=habitacao`);
  await dismissPlatformUpdates(page);
  await expect(block(page).getByTestId('snapshot-series')).toBeVisible({ timeout: 15_000 });

  const register = block(page).getByTestId('snapshot-register');
  if (await register.isVisible().catch(() => false)) {
    await register.click();
  } else {
    await block(page).locator('[data-testid^="snapshot-alter-"]').click();
    await page.getByTestId('snapshot-kind-update').click();
  }
  await expect(page.getByTestId('diagnosis-snapshot-form-sheet')).toBeVisible();
}

async function closeForm(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^cancelar$/i }).click();
  await expect(page.getByTestId('diagnosis-snapshot-form-sheet')).toBeHidden();
}

test.describe('US-DIAG2-02 — condições habitacionais completas (client)', () => {
  test.skip(!BASE, 'Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.');

  test('CA03 — sem dormitórios, pessoas por dormitório mostra "Sem informação" (não zero)', async ({ page }) => {
    await openForm(page, FAMILY_SILVA);

    const persons = page.getByTestId('housing-persons-per-bedroom');
    const bedrooms = page.getByTestId('housing-bedrooms_count');

    await bedrooms.fill('2');
    await expect(persons).toHaveText('2,5');

    await bedrooms.fill('');
    await expect(persons).toHaveText('Sem informação');
    await expect(persons).not.toHaveText(/^0/);
    // Calculado: não há campo editável para o valor.
    await expect(page.getByTestId('housing-persons-per-bedroom-field').locator('input')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/habitacao11231-ca03-sem-valor.png' });

    // Zero dormitório também não vira valor (D05).
    await bedrooms.fill('0');
    await expect(persons).toHaveText('Sem informação');

    await closeForm(page);
  });

  test('D04 (faixa) — zero cômodos mostra a mensagem de faixa no campo', async ({ page }) => {
    await openForm(page, FAMILY_SILVA);

    await page.getByTestId('housing-rooms_count').fill('0');
    await page.getByTestId('housing-bedrooms_count').fill('0');
    await page.getByTestId('diagnosis-snapshot-unit-select').click();
    await page.getByRole('option', { name: UNIT_NAME }).click();
    await page.getByTestId('diagnosis-snapshot-submit').click();

    // #11407 revogou a RN03/CA04 da #11231: dormitórios acima de cômodos agora
    // avisa e pede conferência; a recusa que resta é a de faixa.
    await expect(page.locator('#housing-rooms_count ~ [role="alert"]')).toBeVisible();
    await expect(page.getByTestId('diagnosis-snapshot-form-sheet')).toBeVisible();
    await page.screenshot({ path: 'test-results/habitacao11231-d04-faixa.png' });

    await closeForm(page);
  });

  test('CT05 — família importada do CadÚnico, sem retrato: itens vazios e nenhum selo "CadÚnico"', async ({ page }) => {
    // Servidor: draft com todos os itens null, sem origem por campo nem divergência.
    const draft = await api.get(
      `/api/client/families/${FAMILY_SOUZA}/diagnosis-snapshots/draft?block=housing_conditions`,
    );
    expect(draft.status(), 'GET do draft da Souza').toBe(200);
    const body = await draft.json();
    const payload = (body.data ?? body) as Record<string, unknown>;
    const data = (payload.data ?? {}) as Record<string, unknown>;
    expect(Object.keys(data).length, 'o draft traz os itens').toBeGreaterThan(0);
    for (const [key, value] of Object.entries(data)) {
      expect(value, `item ${key} vem null`).toBeNull();
    }
    expect(payload.field_sources ?? null).toBeNull();
    expect(payload.cadunico_divergences ?? []).toEqual([]);

    // Tela: formulário aberto sem nenhum selo "CadÚnico" no bloco.
    await openForm(page, FAMILY_SOUZA);
    const sheet = page.getByTestId('diagnosis-snapshot-form-sheet');
    await expect(page.getByTestId('housing-persons-per-bedroom')).toHaveText('Sem informação');
    await expect(sheet.getByText(/cad[úu]nico/i)).toHaveCount(0);
    await expect(sheet.locator('[data-testid*="cadunico"]')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/habitacao11231-ct05-sem-cadunico.png' });

    await closeForm(page);
  });

  test('CA06 — o painel de apoio mostra "Sim / Sem informação / Não" e não tem campo de entrada', async ({ page }) => {
    await openForm(page, FAMILY_SILVA);

    await page.getByTestId('housing-condition-risk-area-no').click();
    await page.getByTestId('housing-difficult_geographic_access-yes').click();
    await page.getByTestId('housing-area_conflict_violence-unknown').click();

    await expect(page.getByTestId('housing-condition-support-difficult_access-value')).toHaveText('Sim');
    await expect(page.getByTestId('housing-condition-support-violence-value')).toHaveText('Sem informação');
    await expect(page.getByTestId('housing-condition-support-risk_area-value')).toHaveText('Não');
    await expect(
      page.getByTestId('housing-condition-support').locator('input, select, textarea, button'),
    ).toHaveCount(0);
    await page.screenshot({ path: 'test-results/habitacao11231-ca06-apoio.png' });

    await closeForm(page);
  });
});
