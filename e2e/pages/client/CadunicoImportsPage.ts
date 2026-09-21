import { expect, type Locator, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * Page Object da Importação do CadÚnico no frontend do TENANT (client) —
 * Sprint 8 (HU01–HU05). Encapsula login do client + seleção de tenant e o
 * fluxo em duas etapas (validar → confirmar → sincronizar).
 *
 * O módulo client NÃO tem `data-testid` — os seletores usam texto pt-BR
 * visível + roles + aria-label (todos confirmados no código do módulo).
 * Requer cenário pré-semeado (E2ESeeder): tenant Ativo + usuário MASTER com
 * `cadunico-imports.*`. Fila em modo `sync` torna o status determinístico.
 */
export class CadunicoImportsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Login por CPF + senha; seleciona o primeiro tenant quando solicitado. */
  async login(cpf: string, password: string, tenantHint = /.+/): Promise<void> {
    // Zera a sessão herdada do project `chromium-tenant` (storageState do
    // operador): sem isso o guard `redirectIfAuthenticated` desvia
    // /auth/login para /app e o formulário nunca aparece.
    await resetTenantSession(this.page);
    await this.page.locator('input#cpf, input[name="cpf"]').first().fill(cpf);
    await this.page.locator('input[type="password"]').first().fill(password);
    await this.page.locator('button[type="submit"]').first().click();
    await this.page.waitForLoadState('networkidle');

    if (this.page.url().includes('select-tenant')) {
      await this.page
        .getByText(tenantHint)
        .first()
        .click()
        .catch(() => {});
      await this.page
        .getByRole('button', { name: /entrar|continuar|acessar|confirmar/i })
        .first()
        .click()
        .catch(() => {});
      await this.page.waitForLoadState('networkidle');
    }
  }

  /** Vai direto para a listagem de importações do tenant. */
  async goto(): Promise<void> {
    await this.page.goto('/app/cadunico-imports');
    await expect(this.page.getByRole('main')).toBeVisible();
  }

  get sidebarLink(): Locator {
    return this.page.getByRole('link', { name: /importações do cadúnico/i });
  }

  get newImportButton(): Locator {
    return this.page.getByRole('button', { name: /nova importação/i });
  }

  /** Abre a sheet de upload. */
  async openUpload(): Promise<void> {
    await this.newImportButton.first().click();
    await expect(this.page.getByText(/nova importação do cadúnico/i)).toBeVisible();
  }

  /** Seleciona o arquivo no input escondido (accept=".csv,text/csv"). */
  async selectFile(filePath: string): Promise<void> {
    await this.page.locator('input[type="file"]').first().setInputFiles(filePath);
  }

  get validateButton(): Locator {
    return this.page.getByRole('button', { name: /validar arquivo/i });
  }

  get confirmButton(): Locator {
    return this.page.getByRole('button', { name: /confirmar importação/i });
  }

  /** Passo 1: dispara a validação prévia. */
  async validate(): Promise<void> {
    await this.validateButton.first().click();
  }

  /** Passo 2: confirma e enfileira a Etapa 1. */
  async confirm(): Promise<void> {
    await this.confirmButton.first().click();
  }

  /** Sucesso da validação prévia (habilita "Confirmar"). */
  async expectValidated(): Promise<void> {
    await expect(this.page.getByText(/arquivo validado/i)).toBeVisible();
  }

  /** Erro de validação no campo do arquivo (CA02). */
  async expectFileError(pattern: RegExp = /csv|layout|cabeçalho|colunas|formato/i): Promise<void> {
    await expect(this.page.getByText(pattern).first()).toBeVisible();
  }

  /** Linha da listagem pelo nome do arquivo. */
  row(filename: string): Locator {
    return this.page.getByRole('row', { name: new RegExp(filename, 'i') });
  }

  /** Abre o detalhe da importação via menu de ações da linha. */
  async openDetails(filename: string): Promise<void> {
    await this.row(filename).getByRole('button', { name: /mais ações/i }).first().click();
    await this.page.getByText(/ver detalhes/i).first().click();
    await expect(this.page.getByText(/processamento do arquivo/i).first()).toBeVisible();
  }

  get syncButton(): Locator {
    return this.page.getByRole('button', { name: /sincronizar famílias/i });
  }

  /** Dispara a Etapa 2 (sincronização manual) a partir do detalhe. */
  async sync(): Promise<void> {
    await this.syncButton.first().click();
  }

  /** Aguarda um badge de status (texto) ficar visível. */
  async expectBadge(text: RegExp, timeout = 30_000): Promise<void> {
    await expect(this.page.getByText(text).first()).toBeVisible({ timeout });
  }
}
