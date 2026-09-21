import { expect, test, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * E2E do bloco de INGRESSO e PROGRAMAS SOCIAIS do prontuário (HU #10619 —
 * CA01/CA02/CA03/CA05/CA06/CA07) no frontend do TENANT (client).
 *
 * ⚠️ HARNESS: a stack E2E padrão (`start-stack.sh`) serve apenas o **admin**.
 * Este spec exercita o **client**, então é **opt-in via env** e fica `skip`
 * por padrão — mesmo molde de `tests/client/family-access-by-unit.spec.ts` e
 * `tests/client/family-composition.spec.ts`.
 *
 * O que ele prova, e que nenhum teste de backend prova: que o campo do órgão
 * encaminhador APARECE E SOME na tela conforme a forma escolhida, contra o
 * cadastro REAL (`family_intake_forms.requires_referring_agency`). O Vitest
 * prova que o front obedece à propriedade — inclusive com formas invertidas;
 * aqui a prova é contra o dado semeado, de ponta a ponta.
 *
 * Cenário a semear (tenant Ativo, guard `client`):
 *  - OPERADOR com o add-on LGPD (`family_viewer`) e lotação VIGENTE na unidade
 *    de referência das famílias abaixo          → E2E_CLIENT_OPERADOR_*
 *  - família com prontuário ABERTO e SEM ingresso registrado (CA01/CA02/CA03)
 *                                               → E2E_CLIENT_FAMILY_INTAKE_PENDING_UUID
 *  - família com ingresso JÁ registrado (CA07)  → E2E_CLIENT_FAMILY_INTAKE_REGISTERED_UUID
 *  - família beneficiária do PBF pelo CadÚnico e com ao menos DOIS integrantes
 *    ativos (CA05/CA06)                         → E2E_CLIENT_FAMILY_PROGRAMS_UUID
 *
 * As duas formas usadas nos CA02/CA03 vêm do cadastro real e podem ser
 * sobrescritas por env, porque o Super Admin passou a poder editá-las sem
 * deploy (é exatamente o ponto da HU).
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:5174 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   E2E_CLIENT_FAMILY_INTAKE_PENDING_UUID=... \
 *   npx playwright test tests/client/family-intake.spec.ts
 */

const BASE = process.env.CLIENT_BASE_URL;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;

const FAMILY_PENDING = process.env.E2E_CLIENT_FAMILY_INTAKE_PENDING_UUID;
const FAMILY_REGISTERED = process.env.E2E_CLIENT_FAMILY_INTAKE_REGISTERED_UUID;
const FAMILY_PROGRAMS = process.env.E2E_CLIENT_FAMILY_PROGRAMS_UUID;

/** Formas do instrumento — o padrão é a semente (RN02). */
const FORM_WITH_AGENCY =
  process.env.E2E_CLIENT_INTAKE_FORM_WITH_AGENCY ?? 'Encaminhamento do Conselho Tutelar';
const FORM_WITHOUT_AGENCY =
  process.env.E2E_CLIENT_INTAKE_FORM_WITHOUT_AGENCY ?? 'Demanda espontânea';

const configured = Boolean(BASE && OPERADOR_CPF && OPERADOR_PASS);

/** Login por CPF + senha; seleciona o primeiro tenant quando solicitado. */
async function login(page: Page, cpf: string, password: string): Promise<void> {
  // Zera a sessão herdada do project `chromium-tenant` (storageState do
  // operador): sem isso o guard `redirectIfAuthenticated` desvia
  // /auth/login para /app e o formulário nunca aparece.
  await resetTenantSession(page);
  await page.locator('input#cpf, input[name="cpf"]').first().fill(cpf);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForLoadState('networkidle');

  if (page.url().includes('select-tenant')) {
    await page
      .getByRole('button', { name: /entrar|continuar|acessar|confirmar/i })
      .first()
      .click()
      .catch(() => {});
    await page.waitForLoadState('networkidle');
  }
}

/** Abre o prontuário direto na aba de ingresso (a aba é sincronizada com ?tab=). */
async function openIntakeTab(page: Page, uuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${uuid}?tab=ingresso`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('intake-block')).toBeVisible();
}

/** Escolhe a forma de ingresso no combobox (shadcn Select). */
async function chooseForm(page: Page, name: string): Promise<void> {
  await page.locator('#intake-form-select').click();
  await page.getByRole('option', { name, exact: true }).click();
}

test.describe('HU #10619 — ingresso e programas sociais no prontuário (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD em e2e/.env.e2e (client não é servido pela stack admin).',
  );

  test.use({ baseURL: BASE });

  test('CA03 — a forma que não é encaminhamento NÃO apresenta o órgão', async ({ page }) => {
    test.skip(!FAMILY_PENDING, 'Defina E2E_CLIENT_FAMILY_INTAKE_PENDING_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openIntakeTab(page, FAMILY_PENDING!);

    await chooseForm(page, FORM_WITHOUT_AGENCY);

    // Não é "escondido por CSS": o bloco não existe no DOM.
    await expect(page.getByTestId('intake-agency-fields')).toHaveCount(0);
    await expect(page.getByTestId('intake-agency-name')).toHaveCount(0);
  });

  test('CA02 — a forma de encaminhamento apresenta o órgão e o exige', async ({ page }) => {
    test.skip(!FAMILY_PENDING, 'Defina E2E_CLIENT_FAMILY_INTAKE_PENDING_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openIntakeTab(page, FAMILY_PENDING!);

    await chooseForm(page, FORM_WITH_AGENCY);
    await expect(page.getByTestId('intake-agency-fields')).toBeVisible();

    // Motivo preenchido, órgão em branco: o registro NÃO passa.
    await page.getByTestId('intake-reason').fill('Encaminhamento recebido para avaliação.');
    await page.getByTestId('intake-submit').click();

    await expect(page.getByTestId('intake-error-agency-name')).toBeVisible();
    await expect(page.getByTestId('intake-error-agency-contact')).toBeVisible();
    // Continua pendente: nada foi gravado.
    await expect(page.getByTestId('intake-pending-badge')).toBeVisible();

    await page.screenshot({ path: 'test-results/10619-ca02-orgao-obrigatorio.png', fullPage: true });
  });

  test('o campo do órgão aparece e SOME ao trocar a forma — a regra vem do cadastro', async ({
    page,
  }) => {
    test.skip(!FAMILY_PENDING, 'Defina E2E_CLIENT_FAMILY_INTAKE_PENDING_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openIntakeTab(page, FAMILY_PENDING!);

    await chooseForm(page, FORM_WITH_AGENCY);
    await expect(page.getByTestId('intake-agency-fields')).toBeVisible();

    await chooseForm(page, FORM_WITHOUT_AGENCY);
    await expect(page.getByTestId('intake-agency-fields')).toHaveCount(0);

    await chooseForm(page, FORM_WITH_AGENCY);
    await expect(page.getByTestId('intake-agency-fields')).toBeVisible();
  });

  test('CA04 — sem o motivo o registro não é salvo', async ({ page }) => {
    test.skip(!FAMILY_PENDING, 'Defina E2E_CLIENT_FAMILY_INTAKE_PENDING_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openIntakeTab(page, FAMILY_PENDING!);

    await chooseForm(page, FORM_WITHOUT_AGENCY);
    await page.getByTestId('intake-submit').click();

    await expect(page.getByTestId('intake-error-reason')).toBeVisible();
    await expect(page.getByTestId('intake-pending-badge')).toBeVisible();
  });

  test('CA01 — registra o ingresso por demanda espontânea, com autor e data', async ({ page }) => {
    test.skip(!FAMILY_PENDING, 'Defina E2E_CLIENT_FAMILY_INTAKE_PENDING_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openIntakeTab(page, FAMILY_PENDING!);

    await chooseForm(page, FORM_WITHOUT_AGENCY);
    await page
      .getByTestId('intake-reason')
      .fill('Família procurou a unidade após corte de energia; relata insegurança alimentar.');
    await page.getByTestId('intake-submit').click();

    // Gravado: o bloco passa a LEITURA, assinado e datado.
    await expect(page.getByTestId('intake-summary')).toBeVisible();
    await expect(page.getByTestId('intake-signature')).toContainText(/registrado por/i);
    await expect(page.getByTestId('intake-registered-badge')).toBeVisible();

    await page.screenshot({ path: 'test-results/10619-ca01-ingresso-registrado.png', fullPage: true });
  });

  test('CA07 — bloco já preenchido só oferece CORRIGIR, nunca um segundo ingresso', async ({
    page,
  }) => {
    test.skip(!FAMILY_REGISTERED, 'Defina E2E_CLIENT_FAMILY_INTAKE_REGISTERED_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openIntakeTab(page, FAMILY_REGISTERED!);

    const bloco = page.getByTestId('intake-block');
    await expect(page.getByTestId('intake-summary')).toBeVisible();
    await expect(page.getByTestId('intake-correct')).toHaveText(/corrigir registro/i);

    // Nenhuma porta para um segundo registro do primeiro atendimento.
    await expect(bloco).not.toContainText(/novo ingresso/i);
    await expect(page.getByTestId('intake-pending-badge')).toHaveCount(0);

    // A correção reabre o MESMO registro, já preenchido.
    await page.getByTestId('intake-correct').click();
    await expect(page.getByTestId('intake-submit')).toHaveText(/salvar correção/i);
    await expect(page.getByTestId('intake-reason')).not.toHaveValue('');

    await page.screenshot({ path: 'test-results/10619-ca07-correcao.png', fullPage: true });
  });

  test('CA05 — Bolsa Família aparece travado, com a origem CadÚnico declarada', async ({ page }) => {
    test.skip(!FAMILY_PROGRAMS, 'Defina E2E_CLIENT_FAMILY_PROGRAMS_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openIntakeTab(page, FAMILY_PROGRAMS!);

    const bloco = page.getByTestId('social-programs-block');
    await expect(bloco).toBeVisible();

    const pbf = page.getByTestId('social-program-pbf');
    // Visível (nunca escondido) e sem caminho de edição.
    await expect(pbf).toBeVisible();
    await expect(pbf).toBeDisabled();
    await expect(page.getByTestId('social-program-pbf-origin')).toContainText(/CadÚnico/i);

    await page.screenshot({ path: 'test-results/10619-ca05-pbf-travado.png', fullPage: true });
  });

  test('CA06 — declara DOIS beneficiários de BPC na mesma família', async ({ page }) => {
    test.skip(!FAMILY_PROGRAMS, 'Defina E2E_CLIENT_FAMILY_PROGRAMS_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openIntakeTab(page, FAMILY_PROGRAMS!);

    await page.getByTestId('social-program-checkbox-bpc').click();
    await expect(page.getByTestId('social-program-beneficiaries-bpc')).toBeVisible();

    // Primeiro beneficiário.
    await page.getByTestId('social-program-beneficiary-bpc-0').click();
    await page.getByRole('option').first().click();

    // Segundo beneficiário — o BPC admite mais de um por família (P5/CA06).
    await page.getByTestId('social-program-add-beneficiary-bpc').click();
    await page.getByTestId('social-program-beneficiary-bpc-1').click();
    await page.getByRole('option').nth(1).click();

    await page.getByTestId('social-programs-submit').click();

    // Sem erro de beneficiário e as duas linhas continuam na tela após a relê.
    await expect(page.getByTestId('social-program-error-bpc')).toHaveCount(0);
    await expect(page.getByTestId('social-program-beneficiary-bpc-1')).toBeVisible();

    await page.screenshot({ path: 'test-results/10619-ca06-dois-bpc.png', fullPage: true });
  });
});
