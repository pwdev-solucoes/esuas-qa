import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Base para Page Objects: utilidades comuns sem expor seletores específicos.
 */
export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  abstract goto(): Promise<void>;

  protected byTestId(testId: string): Locator {
    return this.page.getByTestId(testId);
  }

  /**
   * Aguarda um toast (vue-sonner renderiza em [data-sonner-toast]).
   */
  async expectToast(textOrRegex: string | RegExp): Promise<void> {
    const toast = this.page.locator('[data-sonner-toast]').filter({ hasText: textOrRegex });
    await expect(toast).toBeVisible({ timeout: 5_000 });
  }
}
