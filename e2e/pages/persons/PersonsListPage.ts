import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';
import { maskCpf } from '../../helpers/cpf';

/**
 * Page Object da listagem/busca do repositório global de pessoas (#9595).
 *
 * A busca tem dois modos (CPF exato / Nome parcial). A lista não oferece
 * exclusão (RN04) — `expectNoDeleteAction()` afirma essa ausência.
 */
export class PersonsListPage extends BasePage {
  readonly createButton: Locator;
  readonly modeCpf: Locator;
  readonly modeName: Locator;
  readonly searchInput: Locator;
  readonly searchSubmit: Locator;
  readonly searchClear: Locator;
  readonly emptyNoResults: Locator;
  readonly emptyCreateShortcut: Locator;

  constructor(page: Page) {
    super(page);
    this.createButton = page.getByTestId('persons-create-button');
    this.modeCpf = page.getByTestId('persons-search-mode-cpf');
    this.modeName = page.getByTestId('persons-search-mode-name');
    this.searchInput = page.getByTestId('persons-search-input');
    this.searchSubmit = page.getByTestId('persons-search-submit');
    this.searchClear = page.getByTestId('persons-search-clear');
    this.emptyNoResults = page.getByTestId('persons-empty-no-results');
    this.emptyCreateShortcut = page.getByTestId('persons-empty-create');
  }

  async goto(): Promise<void> {
    await this.page.goto('/app/persons');
    await expect(this.createButton).toBeVisible({ timeout: 10_000 });
  }

  /** Linha (tabela ou card) de uma pessoa pelo uuid. */
  row(uuid: string): Locator {
    return this.page.getByTestId(`persons-row-${uuid}`);
  }

  /** Linha/card que contém um texto (ex.: nome) — útil quando o uuid é desconhecido. */
  rowByText(text: string): Locator {
    return this.page.locator('[data-person-row]').filter({ hasText: text });
  }

  rows(): Locator {
    return this.page.locator('[data-person-row]');
  }

  async searchByCpf(cpf: string): Promise<void> {
    await this.modeCpf.click();
    await this.searchInput.fill(maskCpf(cpf));
    await this.searchSubmit.click();
  }

  async searchByName(name: string): Promise<void> {
    await this.modeName.click();
    await this.searchInput.fill(name);
    await this.searchSubmit.click();
  }

  async openCreate(): Promise<void> {
    await this.createButton.click();
    await this.page.waitForURL('**/app/persons/novo');
  }

  /**
   * RN04 — não pode existir nenhuma ação de exclusão na listagem.
   * Verifica botões e itens de menu com rótulos de exclusão.
   */
  async expectNoDeleteAction(): Promise<void> {
    await expect(
      this.page.getByRole('button', { name: /excluir|remover|deletar|apagar/i }),
    ).toHaveCount(0);
    await expect(
      this.page.getByRole('menuitem', { name: /excluir|remover|deletar|apagar/i }),
    ).toHaveCount(0);
  }
}
