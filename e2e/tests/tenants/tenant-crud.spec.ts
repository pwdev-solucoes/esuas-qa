import { expect, test } from '@playwright/test';
import { TenantsListPage } from '../../pages/tenants/TenantsListPage';
import { TenantFormSheet } from '../../pages/tenants/TenantFormSheet';
import { uniqueSuffix } from '../../fixtures/test-data';

/**
 * Gerador local de CNPJ válido (algoritmo da Receita).
 * Evita dependência adicional. Retorna sem máscara (14 dígitos).
 */
function generateCnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const calc = (digits: number[], weights: number[]): number => {
    const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
    const mod = sum % 11;

    return mod < 2 ? 0 : 11 - mod;
  };
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = calc(base, w1);
  const d2 = calc([...base, d1], w2);

  return [...base, d1, d2].join('');
}

test.describe('CRUD de Tenants', () => {
  test('cria, edita e remove um tenant via UI', async ({ page }, testInfo) => {
    const suffix = uniqueSuffix(testInfo.workerIndex);
    const tenant = {
      legalName: `Tenant ${suffix}`,
      cnpj: generateCnpj(),
      email: `${suffix}@e2e.local`,
      timezone: 'America/Maceio',
    };

    const list = new TenantsListPage(page);
    const sheet = new TenantFormSheet(page);

    await list.goto();

    // 1) CREATE
    await list.openCreateForm();
    await sheet.fill(tenant);
    // Seleciona o 1º status disponível (E2ESeeder garante seeds prontos).
    const firstStatus = await sheet.statusSelect.locator('option:not([disabled])').first();
    const firstStatusValue = await firstStatus.getAttribute('value');
    if (firstStatusValue) await sheet.statusSelect.selectOption(firstStatusValue);
    await sheet.save();

    // Filtra para garantir que a linha criada aparece (defensivo contra paginação).
    await list.searchInput.fill(tenant.legalName);
    await expect(list.row(tenant.legalName)).toBeVisible({ timeout: 10_000 });

    // 2) EDIT
    const updatedName = `${tenant.legalName} (editado)`;
    await list.clickEditFromMenu(tenant.legalName);
    await sheet.legalNameInput.fill(updatedName);
    await sheet.save();

    await list.searchInput.fill(updatedName);
    await expect(list.row(updatedName)).toBeVisible({ timeout: 10_000 });

    // 3) DELETE
    await list.clickDeleteFromMenu(updatedName);
    await list.confirmDelete();

    await expect(list.row(updatedName)).toHaveCount(0, { timeout: 10_000 });
  });

  test('valida campos obrigatórios ao tentar salvar form vazio', async ({ page }) => {
    const list = new TenantsListPage(page);
    const sheet = new TenantFormSheet(page);

    await list.goto();
    await list.openCreateForm();
    await sheet.saveButton.click();

    // Form não fecha — sheet permanece visível.
    await expect(sheet.sheet).toBeVisible();
    // E exibe ao menos uma mensagem de erro abaixo de algum campo.
    await expect(page.locator('p.text-\\[\\#f03d3d\\]').first()).toBeVisible({ timeout: 5_000 });
  });
});
