import { expect, test, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * E2E do cadastro de família FORA do CadÚnico (HU #10661 — CA01, CA03, CA05,
 * CA06) no frontend do TENANT (client).
 *
 * ⚠️ HARNESS: a stack E2E padrão (`start-stack.sh`) serve apenas o **admin**.
 * Este spec exercita o **client**, então é **opt-in via env** e fica `skip`
 * por padrão — mesmo molde de `tests/client/family-access-by-unit.spec.ts` e
 * `tests/client/family-record-opening.spec.ts`.
 *
 * O que ele prova (e que nenhum teste de backend prova):
 *
 *  - o formulário é **PÁGINA** (`/app/cadastros/familias/nova`), e a busca de
 *    pessoa abre **sobre** ela — a regra página → drawer → modal;
 *  - **renda, per capita, Bolsa Família, código familiar e grupo populacional
 *    não existem na tela** (o lado de UI do CA07; o `prohibited` do Form
 *    Request é provado no backend);
 *  - o **número do prontuário** aparece só DEPOIS de cadastrar, e não há
 *    campo para digitá-lo (RN04/P3);
 *  - o aviso de endereço ausente **não bloqueia** o cadastro (CA05);
 *  - o responsável que já encabeça família leva a **abrir a existente** (CA06).
 *
 * ENVS (as três primeiras já usadas pelos specs de client existentes):
 *  - `CLIENT_BASE_URL` .................. URL do front do tenant (ex.: :5174)
 *  - `E2E_CLIENT_OPERADOR_CPF` .......... operador com add-on LGPD e lotação
 *  - `E2E_CLIENT_OPERADOR_PASSWORD` ..... vigente no "CRAS Centro"
 *  ── NOVAS nesta HU ────────────────────────────────────────────────────────
 *  - `E2E_MANUAL_FAMILY_CPF` ............ CPF válido e INEXISTENTE no
 *                                         repositório (o CA01 cadastra a
 *                                         pessoa e a família com ela)
 *  - `E2E_MANUAL_FAMILY_MOTHER_NAME` .... nome da mãe (obrigatório na #10660)
 *  - `E2E_MANUAL_FAMILY_RESPONSIBLE_WITH_FAMILY_CPF` ... CPF de pessoa que JÁ
 *                                         encabeça família do município (CA06)
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:5174 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   E2E_MANUAL_FAMILY_CPF=... E2E_MANUAL_FAMILY_MOTHER_NAME="Maria de Souza" \
 *   npx playwright test tests/client/manual-family-registration.spec.ts
 *
 * ⚠️ MASSA: o `E2EProntuarioSeeder` NÃO cobre o CA06 — as pessoas que ele cria
 * como responsáveis não têm CPF nem linha em `family_members`, então não são
 * alcançáveis pela busca da tela. O caso do CA06 é AUTORAL e ficou `skip`:
 * **não foi executado**.
 */

const BASE = process.env.CLIENT_BASE_URL;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;
const NEW_PERSON_CPF = process.env.E2E_MANUAL_FAMILY_CPF;
const NEW_PERSON_MOTHER = process.env.E2E_MANUAL_FAMILY_MOTHER_NAME ?? 'Maria de Souza E2E';
const RESPONSIBLE_WITH_FAMILY_CPF = process.env.E2E_MANUAL_FAMILY_RESPONSIBLE_WITH_FAMILY_CPF;

const configured = Boolean(BASE && OPERADOR_CPF && OPERADOR_PASS);

const FORM_PATH = '/app/cadastros/familias/nova';

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

async function openForm(page: Page): Promise<void> {
  await page.goto(FORM_PATH);
  await page.waitForLoadState('networkidle');
}

/** Escolhe a primeira unidade oferecida — a lista vem do backend. */
async function pickFirstUnit(page: Page): Promise<void> {
  await page.getByTestId('manual-family-unit-trigger').click();
  await page.getByRole('option').first().click();
}

test.describe('HU #10661 — cadastrar família fora do CadÚnico (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD (o client não é servido pela stack admin).',
  );

  test.use({ baseURL: BASE });

  test('a tela é PÁGINA e não oferece dado de prestação de contas (CA07/RN04/P4)', async ({
    page,
  }) => {
    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openForm(page);

    // PÁGINA: a URL é a do formulário, não um drawer sobre outra tela.
    expect(page.url()).toContain(FORM_PATH);
    await expect(page.getByTestId('manual-family-form')).toBeVisible();

    // Nenhum campo de snapshot do CadÚnico (RN09/CA07).
    const body = (await page.locator('body').innerText()).toLowerCase();
    for (const forbidden of [
      'renda',
      'per capita',
      'bolsa família',
      'grupo populacional',
      'especificidade',
    ]) {
      expect(body).not.toContain(forbidden);
    }

    // O número do prontuário é gerado: existe a explicação, não o campo.
    await expect(page.getByTestId('manual-family-number-hint')).toBeVisible();
    await expect(page.locator('input#manual-family-record-number')).toHaveCount(0);
    // Código familiar como "não se aplica" (CA04) — nunca editável.
    await expect(page.getByTestId('manual-family-code-hint')).toBeVisible();
    await expect(page.locator('input#manual-family-code')).toHaveCount(0);
    // P4: nenhum caminho de exclusão de família.
    expect(body).not.toContain('excluir família');
  });

  test('CA03 — sem responsável a família não é criada, com a mensagem no campo', async ({
    page,
  }) => {
    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openForm(page);

    await pickFirstUnit(page);
    await page.getByTestId('manual-family-submit').click();

    await expect(page.getByTestId('manual-family-responsible-error')).toBeVisible();
    // Continua no formulário: nada foi criado.
    await expect(page.getByTestId('manual-family-success')).toHaveCount(0);
    expect(page.url()).toContain(FORM_PATH);
  });

  test('CA01 + CA05 — cadastra com pessoa nova e sem endereço, com aviso não-bloqueante', async ({
    page,
  }) => {
    test.skip(
      !NEW_PERSON_CPF,
      'Defina E2E_MANUAL_FAMILY_CPF com um CPF válido e AINDA NÃO cadastrado.',
    );

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openForm(page);

    // Responsável: busca no repositório → não existe → cadastra (CA02/#10660).
    await page.getByTestId('manual-family-responsible-search').click();
    await page.getByTestId('manual-family-cpf-input').fill(NEW_PERSON_CPF!);
    await page.getByTestId('manual-family-cpf-submit').click();
    await page.getByTestId('manual-family-create-person').click();

    await page.locator('input#create-cpf').fill(NEW_PERSON_CPF!);
    await page.locator('input#create-full-name').fill('Ana Clara E2E Souza');
    await page.locator('input#create-birth-date').fill('1990-02-11');
    await page.locator('input#create-mother-name').fill(NEW_PERSON_MOTHER);
    await page.getByTestId('create-sex-trigger').click();
    await page.getByRole('option').first().click();
    await page.getByTestId('create-submit').click();

    await expect(page.getByTestId('manual-family-responsible-selected')).toBeVisible();

    // Unidade + data de abertura (a data já nasce com hoje).
    await pickFirstUnit(page);

    // CA05: o aviso de endereço aparece ANTES de salvar e NÃO desabilita nada.
    await expect(page.getByTestId('manual-family-address-notice')).toBeVisible();
    await expect(page.getByTestId('manual-family-submit')).toBeEnabled();

    await page.getByTestId('manual-family-submit').click();

    // CA01: número do prontuário GERADO, exibido só agora.
    await expect(page.getByTestId('manual-family-success')).toBeVisible();
    await expect(page.getByTestId('manual-family-record-number')).not.toBeEmpty();
    // CA04: código familiar vazio, declarado como "não se aplica".
    await expect(page.getByTestId('manual-family-family-code')).toContainText('—');
    // CA05: o aviso vem do backend, identificado por CÓDIGO estável.
    await expect(page.locator('[data-warning-code="family_without_address"]')).toBeVisible();
  });

  test('CA06 — responsável que já encabeça família leva a ABRIR a existente', async ({ page }) => {
    test.skip(
      !RESPONSIBLE_WITH_FAMILY_CPF,
      'Defina E2E_MANUAL_FAMILY_RESPONSIBLE_WITH_FAMILY_CPF — o seeder ainda não cria responsável com CPF alcançável pela busca. Teste AUTORAL, NÃO executado.',
    );

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openForm(page);

    await page.getByTestId('manual-family-responsible-search').click();
    await page.getByTestId('manual-family-cpf-input').fill(RESPONSIBLE_WITH_FAMILY_CPF!);
    await page.getByTestId('manual-family-cpf-submit').click();

    // A tela não oferece "cadastrar de novo": oferece o prontuário existente.
    const openExisting = page.getByTestId('manual-family-open-existing').first();
    await expect(openExisting).toBeVisible();
    await openExisting.click();

    await page.waitForLoadState('networkidle');
    expect(page.url()).toMatch(/\/app\/cadastros\/familias\/[0-9a-f-]{36}$/);
  });
});
