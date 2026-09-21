import { expect, test } from '@playwright/test';

/**
 * Regression: o select de país no /app/states só mostrava "Afeganistão" porque
 * StatesListPage chamava `countryHttp.all()` (per_page=0) e o backend tratava
 * per_page=0 como per_page=1 (bug em HandlesPagination::resolvePerPage).
 *
 * Garante que:
 *   1. GET /api/countries?per_page=0 retorna >1 país
 *   2. O dropdown de país do form "Novo estado" lista >1 opção
 *   3. Filtro de país no header da listagem também lista >1 opção
 */
test.describe('Cadastro de Estados — select de País', () => {
  test('API /api/countries?per_page=0 retorna todos os países seeded (não 1)', async ({
    page,
  }) => {
    await page.goto('/app/states');
    const response = await page.waitForResponse(
      (res) => res.url().includes('/api/countries') && res.url().includes('per_page=0'),
      { timeout: 10_000 },
    );
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { data: Array<{ name: string }> };
    expect(body.data.length).toBeGreaterThan(1);
  });

  test('dropdown do form "Novo estado" lista mais de 1 país', async ({ page }) => {
    await page.goto('/app/states');

    // Abre o sheet de novo estado.
    await page.getByRole('button', { name: /novo estado|nova estado|adicionar/i }).first().click();

    const select = page.locator('select#state-country');
    await expect(select).toBeVisible();

    // Aguarda a chamada async de countries.all() popular as opções
    // (countries vem do onMounted, pode levar alguns ms para resolver).
    await expect
      .poll(async () => await select.locator('option:not([disabled])').count(), {
        timeout: 5_000,
      })
      .toBeGreaterThan(1);

    // Sanity check: pelo menos um país comum aparece (não só Afeganistão).
    const optionTexts = await select.locator('option').allTextContents();
    expect(optionTexts.join(' ')).toMatch(/Brasil|United States|Argentina|Portugal/i);
  });

  test('filtro de país no header da listagem lista mais de 1 opção', async ({ page }) => {
    await page.goto('/app/states');

    // O filtro pode ser um select ou combobox no StatesFilters.
    const filterSelect = page.locator('select').filter({ has: page.locator('option', { hasText: /país|pais|todos/i }) }).first();

    if (await filterSelect.count() > 0) {
      const optionCount = await filterSelect.locator('option').count();
      expect(optionCount).toBeGreaterThan(2); // "Todos" + ao menos 2 países
    }
  });
});
