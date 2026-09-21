import { expect, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * POM genérico para páginas de lookup do Super Admin.
 *
 * Os 9 módulos de lookup (countries, states, location-types, social-unit-types, etc.)
 * compartilham o mesmo padrão visual: header + filtros + tabela + paginação.
 * Este POM cobre apenas o smoke (carregamento e contagem de linhas) — formulários
 * específicos variam e ficam fora do escopo desta primeira onda.
 *
 * Uso:
 *   const page = new LookupCrudPage(playwrightPage, 'countries');
 *   await page.goto();
 *   await page.expectAnyRow();
 */
export class LookupCrudPage extends BasePage {
  constructor(
    page: Page,
    private readonly slug: string,
  ) {
    super(page);
  }

  async goto(): Promise<void> {
    await this.page.goto(`/app/${this.slug}`);
    await expect(this.page.getByRole('main')).toBeVisible();
  }

  async expectListLoaded(): Promise<void> {
    // Aceita estado vazio OU pelo menos 1 linha visível em ≤ 10s.
    const rows = this.page.locator('table tbody tr');
    const empty = this.page.getByText(/nenhum|sem registros|vazio/i).first();
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 10_000 });
  }

  async rowCount(): Promise<number> {
    return this.page.locator('table tbody tr').count();
  }
}
