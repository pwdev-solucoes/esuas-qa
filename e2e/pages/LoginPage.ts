import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Page Object da tela de login do Super Admin.
 *
 * Expõe apenas ações de alto nível. Seletores ficam internos para
 * que mudanças de markup só afetem este arquivo.
 */
export class LoginPage extends BasePage {
  readonly cpfInput: Locator;
  readonly passwordInput: Locator;
  readonly rememberMeCheckbox: Locator;
  readonly submitButton: Locator;
  readonly errorAlert: Locator;
  readonly forgotPasswordLink: Locator;

  constructor(page: Page) {
    super(page);
    this.cpfInput = page.locator('input#cpf');
    this.passwordInput = page.locator('input#password');
    this.rememberMeCheckbox = page.locator('input#remember');
    this.submitButton = page.locator('button[type="submit"]');
    this.errorAlert = page.getByTestId('login-error');
    this.forgotPasswordLink = page.getByRole('link', { name: /esqueci|forgot/i });
  }

  async goto(): Promise<void> {
    // Importante: navegar via UI dispara o ensureCsrfCookie() antes do login,
    // evitando race condition que retornaria 419 (vide pegadinha #3 do plano).
    await this.page.goto('/auth/login');
    await expect(this.cpfInput).toBeVisible();
  }

  async fillCredentials(cpf: string, password: string): Promise<void> {
    await this.cpfInput.fill(cpf);
    await this.passwordInput.fill(password);
  }

  async toggleRememberMe(): Promise<void> {
    await this.rememberMeCheckbox.click();
  }

  async submit(): Promise<void> {
    await this.submitButton.click();
  }

  /**
   * Fluxo completo: preenche, marca remember-me se solicitado, submete e aguarda redirect.
   */
  async login(cpf: string, password: string, options: { remember?: boolean } = {}): Promise<void> {
    await this.fillCredentials(cpf, password);
    if (options.remember) await this.toggleRememberMe();
    await this.submit();
    await this.page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
  }

  async expectError(textOrRegex?: string | RegExp): Promise<void> {
    await expect(this.errorAlert).toBeVisible();
    if (textOrRegex) {
      await expect(this.errorAlert).toContainText(textOrRegex);
    }
  }
}
