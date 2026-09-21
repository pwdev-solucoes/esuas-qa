import { expect, type Locator, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * Page Object da aba "Profissionais" do gerenciamento de uma Unidade
 * Socioassistencial no frontend do TENANT (client) — HU #9697.
 *
 * Encapsula login do client, seleção de tenant, navegação direta para a aba
 * (`?tab=professionals`) e a interação com o formulário de vínculo
 * (combobox de candidato search-on-type + combobox de CBO + datas).
 *
 * Os seletores foram validados manualmente contra o client rodando em dev
 * (vite) apontando para a API Sail. Requer um cenário pré-semeado: um MASTER
 * do tenant, a unidade operacional, profissionais municipais ativos e CBOs.
 */
export class UnitProfessionalsPage {
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
      await this.page.getByText(tenantHint).first().click().catch(() => {});
      await this.page
        .getByRole('button', { name: /entrar|continuar|acessar|confirmar/i })
        .first()
        .click()
        .catch(() => {});
      await this.page.waitForLoadState('networkidle');
    }
  }

  /** Abre a aba "Profissionais" da unidade diretamente via query param. */
  async openTab(unitUuid: string): Promise<void> {
    await this.page.goto(`/app/unidades/${unitUuid}?tab=professionals`);
    await expect(this.page.getByText('Profissionais da unidade')).toBeVisible();
  }

  get linkButton(): Locator {
    return this.page.getByRole('button', { name: /vincular profissional/i });
  }

  /** Linha da listagem pelo nome do profissional. */
  row(name: string): Locator {
    return this.page.getByRole('row', { name: new RegExp(name, 'i') });
  }

  /**
   * Preenche e submete o formulário de vínculo. O combobox de candidato é
   * search-on-type; o de CBO carrega o relacional ao abrir.
   */
  async linkProfessional(opts: {
    candidateSearch: string;
    candidateName: RegExp;
    cboMatch: RegExp;
    startDate?: string;
    endDate?: string;
  }): Promise<void> {
    await this.linkButton.first().click();

    // Candidato (search-on-type)
    await this.page.getByText(/selecione o profissional/i).first().click();
    await this.page.getByPlaceholder(/buscar profissional/i).fill(opts.candidateSearch);
    await this.page.getByText(opts.candidateName).first().click();

    // CBO (relacional, carrega ao abrir)
    await this.page.getByText(/selecione o cbo/i).first().click();
    await this.page.getByText(opts.cboMatch).first().click();

    if (opts.startDate) {
      await this.page.locator('#unit-prof-start-date').fill(opts.startDate);
    }
    if (opts.endDate) {
      await this.page.locator('#unit-prof-end-date').fill(opts.endDate);
    }

    await this.page.getByRole('button', { name: /^vincular$/i }).first().click();
  }
}
