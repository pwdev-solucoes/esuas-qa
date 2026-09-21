import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';

/**
 * POM dos cadastros de referência "gold standard" do Super Admin que expõem o
 * CRUD completo (header + filtros + tabela + barra de ações em lote + Sheet de
 * formulário), como os lookups do prontuário criados na HU #10620:
 * `member-unlink-reasons` e `civil-document-types`.
 *
 * Diferente do {@link ../lookups/LookupCrudPage LookupCrudPage} — que só faz o
 * smoke de carregamento — aqui cobrimos criação, edição e inativação em lote.
 *
 * Uso:
 *   const lookup = new ReferenceLookupCrudPage(page, {
 *     slug: 'member-unlink-reasons',
 *     newButtonName: /novo motivo de desvínculo/i,
 *     fieldPrefix: 'mur',
 *   });
 */
export type ReferenceLookupOptions = {
  /** Slug da rota e do endpoint (`/app/<slug>` e `/api/<slug>`). */
  slug: string;
  /** Nome acessível do botão de criação no header. */
  newButtonName: RegExp;
  /** Prefixo dos ids dos campos do formulário (`mur-code`, `cdt-code`, ...). */
  fieldPrefix: string;
  /**
   * `data-testid` do Switch de uma flag de REGRA do formulário — quando o
   * cadastro tem uma (HU #10619: `fif-flag` = "exige órgão encaminhador";
   * `spr-flag` = "exige integrante beneficiário"). Ausente nos lookups simples.
   */
  flagTestId?: string;
};

export class ReferenceLookupCrudPage extends BasePage {
  constructor(
    page: Page,
    private readonly options: ReferenceLookupOptions,
  ) {
    super(page);
  }

  private get rows(): Locator {
    return this.page.locator('table tbody tr');
  }

  async goto(): Promise<void> {
    const listRequest = this.waitForList();
    await this.page.goto(`/app/${this.options.slug}`);
    const response = await listRequest;
    expect(
      response.status(),
      `GET /api/${this.options.slug} retornou ${response.status()}`,
    ).toBe(200);
    await expect(this.page.getByRole('main')).toBeVisible();
  }

  /** Promessa do próximo GET da listagem — encadeie ANTES da ação que dispara. */
  waitForList() {
    return this.page.waitForResponse(
      (res) =>
        res.url().includes(`/api/${this.options.slug}`) && res.request().method() === 'GET',
      { timeout: 15_000 },
    );
  }

  async expectListLoaded(): Promise<void> {
    const empty = this.page.getByText(/nenhum|sem registros|vazio/i).first();
    await expect(this.rows.first().or(empty)).toBeVisible({ timeout: 10_000 });
  }

  /** Filtra a listagem pelo termo (busca server-side com debounce de 350ms). */
  async search(term: string): Promise<void> {
    const input = this.page.getByPlaceholder(/buscar/i).first();
    const listRequest = this.waitForList();
    await input.fill(term);
    await listRequest;
  }

  row(code: string): Locator {
    return this.rows.filter({ hasText: code });
  }

  async create(code: string, name: string, flag?: boolean): Promise<void> {
    await this.page.getByRole('button', { name: this.options.newButtonName }).click();
    await this.page.locator(`#${this.options.fieldPrefix}-code`).fill(code);
    await this.page.locator(`#${this.options.fieldPrefix}-name`).fill(name);
    if (flag !== undefined) await this.setFlagControl(flag);
    const listRequest = this.waitForList();
    await this.page.getByRole('button', { name: /^salvar$/i }).click();
    await listRequest;
  }

  /** O Switch da flag de regra dentro do Sheet (exige `flagTestId`). */
  flagSwitch(): Locator {
    if (!this.options.flagTestId) {
      throw new Error(`Lookup ${this.options.slug} não declarou flagTestId no POM.`);
    }
    return this.page.getByTestId(this.options.flagTestId);
  }

  /** Põe o Switch no estado desejado (idempotente — só clica se divergir). */
  private async setFlagControl(value: boolean): Promise<void> {
    const control = this.flagSwitch();
    await expect(control).toBeVisible();
    const checked = (await control.getAttribute('aria-checked')) === 'true';
    if (checked !== value) await control.click();
    await expect(control).toHaveAttribute('aria-checked', String(value));
  }

  /**
   * Abre a edição de um registro e muda APENAS a flag de regra — é ela que
   * governa a validação do prontuário no `client/` (HU #10619 · RN03/CA02).
   */
  async setFlag(code: string, value: boolean): Promise<void> {
    await this.openRowMenu(code);
    await this.page.getByRole('menuitem', { name: /^editar$/i }).click();
    await this.setFlagControl(value);
    const listRequest = this.waitForList();
    await this.page.getByRole('button', { name: /^salvar$/i }).click();
    await listRequest;
  }

  /** Lê o estado da flag na edição, sem salvar (fecha o Sheet ao final). */
  async readFlagOnEdit(code: string): Promise<boolean> {
    await this.openRowMenu(code);
    await this.page.getByRole('menuitem', { name: /^editar$/i }).click();
    const checked = (await this.flagSwitch().getAttribute('aria-checked')) === 'true';
    await this.page.getByRole('button', { name: /^cancelar$/i }).click();
    return checked;
  }

  async openRowMenu(code: string): Promise<void> {
    await this.row(code).getByRole('button', { name: /mais ações/i }).click();
  }

  async rename(code: string, newName: string): Promise<void> {
    await this.openRowMenu(code);
    await this.page.getByRole('menuitem', { name: /^editar$/i }).click();
    await this.page.locator(`#${this.options.fieldPrefix}-name`).fill(newName);
    const listRequest = this.waitForList();
    await this.page.getByRole('button', { name: /^salvar$/i }).click();
    await listRequest;
  }

  /** O `code` de um registro existente não é editável (RN de integridade). */
  async expectCodeReadOnlyOnEdit(code: string): Promise<void> {
    await this.openRowMenu(code);
    await this.page.getByRole('menuitem', { name: /^editar$/i }).click();
    const field = this.page.locator(`#${this.options.fieldPrefix}-code`);
    await expect(field).toHaveValue(code);
    await expect(field).toHaveAttribute('readonly', /.*/);
    await this.page.getByRole('button', { name: /^cancelar$/i }).click();
  }

  async selectRow(code: string): Promise<void> {
    await this.row(code).getByRole('checkbox').first().click();
  }

  async bulkDeactivate(): Promise<void> {
    const listRequest = this.waitForList();
    await this.page.getByRole('button', { name: /^inativar$/i }).first().click();
    await listRequest;
  }

  async remove(code: string): Promise<void> {
    await this.openRowMenu(code);
    await this.page.getByRole('menuitem', { name: /^excluir$/i }).click();
    const listRequest = this.waitForList();
    await this.page.getByRole('button', { name: /^excluir$/i }).last().click();
    await listRequest;
  }
}
