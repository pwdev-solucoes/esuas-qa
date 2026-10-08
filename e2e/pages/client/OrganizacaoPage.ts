import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

export type OrganizacaoTab = 'cadastral' | 'address' | 'tce' | 'responsible' | 'history';

/**
 * Page Object da tela Organização do Painel do Tenant (`/app/configuracoes`),
 * com foco nas abas "Parâmetros TCE/AL" e "Histórico" (HU #10996, US-03).
 *
 * Seletores validados contra o client em dev: o drawer TCE é um
 * `aside[role="dialog"]`, o identificador tem `#tce-cardug-identifier` e a
 * trilha é a seção `[data-testid="organization-history"]`.
 */
export class OrganizacaoPage extends BasePage {
  readonly tceDrawer: Locator;
  readonly cardugInput: Locator;
  readonly cnpjInput: Locator;
  readonly drawerSaveButton: Locator;
  readonly identifierChangeConfirm: Locator;
  readonly history: Locator;
  readonly historyEntries: Locator;
  readonly historyEmpty: Locator;

  constructor(page: Page) {
    super(page);
    this.tceDrawer = page.locator('aside[role="dialog"]');
    this.cardugInput = page.locator('#tce-cardug-identifier');
    this.cnpjInput = this.tceDrawer.locator('input[maxlength="18"]');
    this.drawerSaveButton = this.tceDrawer.getByRole('button', { name: /^salvar$/i });
    this.identifierChangeConfirm = page.getByRole('button', { name: /salvar mesmo assim/i });
    this.history = this.byTestId('organization-history');
    this.historyEntries = this.byTestId('history-entry');
    this.historyEmpty = this.byTestId('history-empty');
  }

  async goto(tab: OrganizacaoTab = 'cadastral'): Promise<void> {
    await this.page.goto(`/app/configuracoes?tab=${tab}`);
    await dismissPlatformUpdates(this.page);
  }

  /** Botão "Editar" do cartão de parâmetros TCE (fora do drawer). */
  get tceEditButton(): Locator {
    return this.page.getByRole('button', { name: /^editar$/i }).first();
  }

  /** Abre o drawer de parâmetros TCE/AL. */
  async openTceEditor(): Promise<void> {
    await this.goto('tce');
    await expect(this.tceEditButton).toBeVisible({ timeout: 10_000 });
    await this.tceEditButton.click();
    await expect(this.cardugInput).toBeVisible();
  }

  /** Preenche o CARDUG e salva, confirmando o aviso de remessas se ele aparecer. */
  async saveCardug(value: string): Promise<void> {
    await this.openTceEditor();
    await this.cardugInput.fill(value);
    await this.drawerSaveButton.click();
    if (await this.identifierChangeConfirm.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await this.identifierChangeConfirm.click();
    }
    await expect(this.tceDrawer).toBeHidden({ timeout: 10_000 });
  }

  async openHistory(): Promise<void> {
    await this.goto('history');
    await expect(this.history).toBeVisible({ timeout: 10_000 });
    await expect(this.page.getByTestId('history-loading')).toBeHidden({ timeout: 10_000 });
  }

  /** Itens da trilha cujo texto contém o assunto (ex.: "Parâmetros do TCE"). */
  entriesOf(subject: string | RegExp): Locator {
    return this.historyEntries.filter({ hasText: subject });
  }
}
