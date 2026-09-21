import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '../BasePage';

export interface UserFormData {
  fullName: string;
  email: string;
  cpf: string;
  type?: 'manager' | 'client';
  role?: string;
}

/**
 * POM do sheet de criação/edição de usuário em /app/usuarios.
 *
 * Foco: ações de upload de foto (cobertas pelos specs novos). Outras
 * interações reusam seletores estáveis por id (`#u-full-name`, `#u-email`).
 */
export class UserFormSheet extends BasePage {
  readonly sheet: Locator;
  readonly fullNameInput: Locator;
  readonly emailInput: Locator;
  readonly cpfInput: Locator;
  readonly typeSelect: Locator;
  readonly roleSelect: Locator;
  readonly photoInput: Locator;
  readonly photoPreview: Locator;
  readonly removePhotoButton: Locator;
  readonly photoFieldError: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    super(page);
    this.sheet = page.getByRole('dialog');
    this.fullNameInput = page.locator('input#u-full-name');
    this.emailInput = page.locator('input#u-email');
    this.cpfInput = page.locator('input#u-cpf');
    this.typeSelect = page.locator('select#u-role'); // legado — não usado; type é por botão
    this.roleSelect = page.locator('select#u-role');
    this.photoInput = page.locator('input[type="file"][accept*="image"]');
    this.photoPreview = page.locator('img[alt="Foto do usuário"]');
    this.removePhotoButton = page.getByRole('button', { name: /remover seleção/i });
    this.photoFieldError = page.locator('p.text-\\[\\#f03d3d\\]').filter({ hasText: /foto|photo/i });
    this.saveButton = page.getByRole('button', { name: /^salvar$/i });
    this.cancelButton = page.getByRole('button', { name: /^cancelar$/i });
  }

  async goto(): Promise<void> {
    throw new Error('UserFormSheet abre via /app/usuarios → "Novo usuário".');
  }

  async setAvatar(filePath: string): Promise<void> {
    await this.photoInput.setInputFiles(filePath);
    await expect(this.photoPreview).toBeVisible({ timeout: 3_000 });
  }

  async setAvatarFromBuffer(name: string, mimeType: string, buffer: Buffer): Promise<void> {
    await this.photoInput.setInputFiles({ name, mimeType, buffer });
  }

  async removeSelectedAvatar(): Promise<void> {
    await this.removePhotoButton.click();
  }

  async fillBasic(data: UserFormData): Promise<void> {
    await this.fullNameInput.fill(data.fullName);
    await this.emailInput.fill(data.email);
    await this.cpfInput.fill(data.cpf);

    // Type é botão (não select). Selecionar Manager por default (campo obrigatório).
    const type = data.type ?? 'manager';
    const typeButtonName = type === 'manager' ? /^manager$/i : /^client$/i;
    await this.page.getByRole('button', { name: typeButtonName }).click();

    // Role é select #u-role — só aparece após selecionar o type. Aguardar
    // ao menos uma opção válida ser populada (fetchRoles é async).
    await expect(this.roleSelect).toBeVisible({ timeout: 5_000 });
    await expect(
      this.roleSelect.locator('option:not([disabled]):not([value=""])'),
    ).not.toHaveCount(0, { timeout: 5_000 });

    const role = data.role ?? (type === 'manager' ? 'admin' : 'client');
    await this.roleSelect.selectOption(role);
  }

  async save(): Promise<void> {
    await this.saveButton.click();
  }
}
