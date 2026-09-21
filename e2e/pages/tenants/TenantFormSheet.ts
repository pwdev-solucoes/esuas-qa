import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';

export interface TenantFormData {
  legalName: string;
  tradeName?: string;
  cnpj: string;
  email: string;
  phone?: string;
  timezone?: string;
  statusId?: number;
}

/**
 * POM do sheet lateral de criação/edição de tenant.
 *
 * Inputs são identificáveis por id estável: #t-legal-name, #t-cnpj, #t-email, etc.
 */
export class TenantFormSheet extends BasePage {
  readonly sheet: Locator;
  readonly legalNameInput: Locator;
  readonly tradeNameInput: Locator;
  readonly cnpjInput: Locator;
  readonly phoneInput: Locator;
  readonly emailInput: Locator;
  readonly timezoneInput: Locator;
  readonly statusSelect: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    super(page);
    this.sheet = page.getByRole('dialog');
    this.legalNameInput = page.locator('input#t-legal-name');
    this.tradeNameInput = page.locator('input#t-trade-name');
    this.cnpjInput = page.locator('input#t-cnpj');
    this.phoneInput = page.locator('input#t-phone');
    this.emailInput = page.locator('input#t-email');
    this.timezoneInput = page.locator('input#t-timezone');
    this.statusSelect = page.locator('select#t-status');
    this.saveButton = page.getByRole('button', { name: /^salvar$/i });
    this.cancelButton = page.getByRole('button', { name: /^cancelar$/i });
    this.closeButton = page.getByRole('button', { name: /fechar/i });
  }

  async goto(): Promise<void> {
    throw new Error('TenantFormSheet abre via TenantsListPage; não navegue diretamente.');
  }

  async fill(data: TenantFormData): Promise<void> {
    await this.legalNameInput.fill(data.legalName);
    if (data.tradeName !== undefined) await this.tradeNameInput.fill(data.tradeName);
    await this.cnpjInput.fill(data.cnpj);
    await this.emailInput.fill(data.email);
    if (data.phone !== undefined) await this.phoneInput.fill(data.phone);
    if (data.timezone !== undefined) await this.timezoneInput.fill(data.timezone);
    if (data.statusId !== undefined) {
      await this.statusSelect.selectOption(String(data.statusId));
    }
  }

  async save(): Promise<void> {
    await this.saveButton.click();
    await expect(this.sheet).toBeHidden({ timeout: 10_000 });
  }
}
