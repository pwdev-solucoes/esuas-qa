import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * POM da listagem de tenants (Organizações).
 *
 * Sem data-testids ainda no admin/, usamos seletores semânticos:
 *   - botão "Nova Organização" (texto)
 *   - linhas via texto da razão social
 *   - dropdown de ações por `aria-label="Mais ações"`
 */
export class TenantsListPage extends BasePage {
  readonly newTenantButton: Locator;
  readonly searchInput: Locator;
  readonly table: Locator;
  readonly deleteConfirmButton: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    super(page);
    this.newTenantButton = page.getByRole('button', { name: /nova organização/i });
    this.searchInput = page.getByPlaceholder(/buscar|pesquisar/i);
    this.table = page.locator('table');
    this.deleteConfirmButton = page.getByRole('button', { name: /^excluir$/i });
    this.emptyState = page.getByText(/nenhum tenant encontrado/i);
  }

  async goto(): Promise<void> {
    await this.page.goto('/app/tenants');
    await expect(this.newTenantButton).toBeVisible({ timeout: 10_000 });
  }

  /**
   * Aguarda uma linha contendo o texto (razão social) aparecer.
   */
  row(legalName: string): Locator {
    return this.page.locator('tr', { hasText: legalName });
  }

  async openCreateForm(): Promise<void> {
    await this.newTenantButton.click();
    await expect(this.page.getByRole('dialog')).toBeVisible();
  }

  async openRowMenu(legalName: string): Promise<void> {
    const row = this.row(legalName);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /mais ações/i }).click();
  }

  async clickEditFromMenu(legalName: string): Promise<void> {
    await this.openRowMenu(legalName);
    await this.page.getByRole('button', { name: /^editar$/i }).click();
    await expect(this.page.getByRole('dialog')).toBeVisible();
  }

  async clickDeleteFromMenu(legalName: string): Promise<void> {
    await this.openRowMenu(legalName);
    await this.page.getByRole('button', { name: /^excluir$/i }).click();
    await expect(this.page.getByText(/excluir tenant\?/i)).toBeVisible();
  }

  async confirmDelete(): Promise<void> {
    await this.deleteConfirmButton.click();
  }
}
