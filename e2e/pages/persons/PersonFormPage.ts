import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';
import { maskCpf } from '../../helpers/cpf';

export interface PersonFormData {
  fullName: string;
  motherName: string;
  birthDate: string; // formato yyyy-mm-dd (input type=date)
  cpf: string; // somente dígitos
}

/**
 * Page Object do formulário de cadastro/edição de pessoa (#9585).
 *
 * Página dedicada (`/app/persons/novo` e `/app/persons/{uuid}/editar`), com
 * IDs estáveis `#pf-*` nos campos e `data-testid` nos controles instrumentados.
 */
export class PersonFormPage extends BasePage {
  readonly fullName: Locator;
  readonly motherName: Locator;
  readonly birthDate: Locator;
  readonly cpf: Locator;
  readonly sexTrigger: Locator;
  readonly nationalityTrigger: Locator;
  readonly foreignerCountry: Locator;
  readonly cpfDuplicateWarning: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    super(page);
    this.fullName = page.locator('#pf-name');
    this.motherName = page.locator('#pf-mother');
    this.birthDate = page.locator('#pf-birth');
    this.cpf = page.locator('#pf-cpf');
    this.sexTrigger = page.locator('#pf-sex');
    this.nationalityTrigger = page.locator('#pf-nat');
    this.foreignerCountry = page.getByTestId('pf-foreigner-country');
    this.cpfDuplicateWarning = page.getByTestId('pf-cpf-duplicate');
    this.saveButton = page.getByTestId('pf-save');
    this.cancelButton = page.getByTestId('pf-cancel');
  }

  async goto(): Promise<void> {
    await this.page.goto('/app/persons/novo');
    await expect(this.fullName).toBeVisible({ timeout: 10_000 });
    // O formulário só é resetado APÓS o carregamento assíncrono dos lookups
    // (onMounted: await lookups.load() → form.reset()). Esperar a rede estabilizar
    // garante preencher os campos depois do reset (senão os valores são apagados).
    await this.page.waitForLoadState('networkidle');
  }

  async fillRequired(data: PersonFormData): Promise<void> {
    await this.fullName.fill(data.fullName);
    await this.motherName.fill(data.motherName);
    await this.birthDate.fill(data.birthDate);
    await this.typeCpf(data.cpf);
  }

  /**
   * Preenche o CPF (mascarado). `.fill()` dispara o `@update:model-value` do
   * Input controlado — mesmo padrão usado com sucesso no form de usuários —
   * o que aciona a verificação em tempo real (check-cpf) após o debounce.
   */
  async typeCpf(cpf: string): Promise<void> {
    await this.cpf.fill(maskCpf(cpf));
  }

  /** Seleciona uma opção de um Select reka-ui (sexo/nacionalidade) pelo texto. */
  private async selectOption(trigger: Locator, label: string | RegExp): Promise<void> {
    await trigger.click();
    const option =
      typeof label === 'string'
        ? this.page.getByRole('option', { name: label, exact: true })
        : this.page.getByRole('option', { name: label });
    await option.click();
  }

  async selectSexo(label: string | RegExp): Promise<void> {
    await this.selectOption(this.sexTrigger, label);
  }

  async selectNacionalidade(label: string | RegExp): Promise<void> {
    await this.selectOption(this.nationalityTrigger, label);
  }

  async save(): Promise<void> {
    await this.saveButton.click();
  }

  /** Qualquer mensagem de erro de validação do form (token semântico text-destructive). */
  validationErrors(): Locator {
    return this.page.locator('p.text-destructive');
  }
}
