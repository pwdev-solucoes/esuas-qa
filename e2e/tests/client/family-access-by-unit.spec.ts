import { expect, test, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * E2E do recorte do prontuário pela unidade de referência (HU #10617,
 * CA01/CA02/CA04/CA06) no frontend do TENANT (client).
 *
 * ⚠️ HARNESS: a stack E2E padrão (`start-stack.sh`) serve apenas o **admin**.
 * Este spec exercita o **client**, então é **opt-in via env** e fica `skip`
 * por padrão — mesmo molde de `tests/client/cadunico-imports.spec.ts` e
 * `tests/client/unit-professionals.spec.ts`.
 *
 * O que ele prova (e que nenhum teste de backend prova): a REDAÇÃO da tela.
 * O 404 da família de outra unidade tem de renderizar o texto IDÊNTICO ao de
 * um uuid inexistente — é a última superfície de vazamento do corte.
 *
 * Cenário a semear (tenant Ativo, guard `client`):
 *  - OPERADOR com o add-on LGPD (`family_viewer`) e lotação VIGENTE no
 *    "CRAS Centro"                                  → E2E_CLIENT_OPERADOR_*
 *  - família referenciada no "CRAS Centro"           → E2E_CLIENT_FAMILY_IN_UNIT_UUID
 *  - família referenciada em OUTRA unidade ("CREAS") → E2E_CLIENT_FAMILY_OTHER_UNIT_UUID
 *  - OPERADOR com o add-on e lotação ENCERRADA       → E2E_CLIENT_NO_ASSIGNMENT_*
 *  - OPERADOR lotado no "CRAS Centro" SEM o add-on   → E2E_CLIENT_NO_ADDON_*
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:5174 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   E2E_CLIENT_FAMILY_IN_UNIT_UUID=... E2E_CLIENT_FAMILY_OTHER_UNIT_UUID=... \
 *   npx playwright test tests/client/family-access-by-unit.spec.ts
 */

const BASE = process.env.CLIENT_BASE_URL;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;
const FAMILY_IN_UNIT = process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID;
const FAMILY_OTHER_UNIT = process.env.E2E_CLIENT_FAMILY_OTHER_UNIT_UUID;
const NO_ASSIGNMENT_CPF = process.env.E2E_CLIENT_NO_ASSIGNMENT_CPF;
const NO_ASSIGNMENT_PASS = process.env.E2E_CLIENT_NO_ASSIGNMENT_PASSWORD;
const NO_ADDON_CPF = process.env.E2E_CLIENT_NO_ADDON_CPF;
const NO_ADDON_PASS = process.env.E2E_CLIENT_NO_ADDON_PASSWORD;

/** uuid válido em forma, inexistente na base — o comparativo do CA02. */
const NONEXISTENT_UUID =
  process.env.E2E_CLIENT_FAMILY_NONEXISTENT_UUID ?? '00000000-0000-4000-8000-000000000000';

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

async function openRecord(page: Page, uuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${uuid}`);
  await page.waitForLoadState('networkidle');
}

/** Normaliza espaços para comparar dois textos de tela literalmente. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

test.describe('HU #10617 — acesso ao prontuário por unidade de referência (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD em e2e/.env.e2e (client não é servido pela stack admin).',
  );

  test.use({ baseURL: BASE });

  test('CA01 — profissional lotado na unidade de referência abre o prontuário', async ({
    page,
  }) => {
    test.skip(!FAMILY_IN_UNIT, 'Defina E2E_CLIENT_FAMILY_IN_UNIT_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openRecord(page, FAMILY_IN_UNIT!);

    await expect(page.getByRole('heading', { name: /visualizar família/i })).toBeVisible();
    await expect(page.getByText(/código familiar/i).first()).toBeVisible();
    await expect(page.getByTestId('family-not-found')).toHaveCount(0);
    await expect(page.getByTestId('family-access-denied')).toHaveCount(0);
    await expect(page.getByTestId('family-no-active-assignment')).toHaveCount(0);
  });

  test('CA02 — família de outra unidade é INDISTINGUÍVEL de um registro inexistente', async ({
    page,
  }) => {
    test.skip(!FAMILY_OTHER_UNIT, 'Defina E2E_CLIENT_FAMILY_OTHER_UNIT_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);

    await openRecord(page, FAMILY_OTHER_UNIT!);
    const outraUnidade = page.getByTestId('family-not-found');
    await expect(outraUnidade).toBeVisible();
    const textoOutraUnidade = squash(await outraUnidade.innerText());

    await openRecord(page, NONEXISTENT_UUID);
    const inexistente = page.getByTestId('family-not-found');
    await expect(inexistente).toBeVisible();
    const textoInexistente = squash(await inexistente.innerText());

    // O CRITÉRIO da HU: mesmo texto, mesma caixa, mesma tela.
    expect(textoOutraUnidade).toBe(textoInexistente);

    // E nenhuma pista do motivo real — nem unidade, nem permissão, nem PII.
    expect(textoOutraUnidade).not.toMatch(/unidade|cras|creas|lotaç|permiss|restrit/i);

    await page.screenshot({
      path: 'test-results/10617-ca02-outra-unidade.png',
      fullPage: true,
    });
  });

  test('CA04 — sem lotação vigente: nenhum prontuário, com o motivo declarado', async ({ page }) => {
    test.skip(
      !(NO_ASSIGNMENT_CPF && NO_ASSIGNMENT_PASS && FAMILY_IN_UNIT),
      'Defina E2E_CLIENT_NO_ASSIGNMENT_CPF/PASSWORD + E2E_CLIENT_FAMILY_IN_UNIT_UUID.',
    );

    await login(page, NO_ASSIGNMENT_CPF!, NO_ASSIGNMENT_PASS!);
    await openRecord(page, FAMILY_IN_UNIT!);

    const bloco = page.getByTestId('family-no-active-assignment');
    await expect(bloco).toBeVisible();
    await expect(bloco).toContainText(/lotação vigente em unidade socioassistencial/i);
    // Diz o que fazer, e NÃO fala em permissão (mandaria o profissional ao lugar errado).
    await expect(bloco).toContainText(/master/i);
    expect(squash(await bloco.innerText())).not.toMatch(/permiss|acesso restrito|lgpd/i);

    await page.screenshot({
      path: 'test-results/10617-ca04-sem-lotacao.png',
      fullPage: true,
    });
  });

  test('CA06 — sem o add-on LGPD continua no alerta "Acesso restrito" (403)', async ({ page }) => {
    test.skip(
      !(NO_ADDON_CPF && NO_ADDON_PASS && FAMILY_IN_UNIT),
      'Defina E2E_CLIENT_NO_ADDON_CPF/PASSWORD + E2E_CLIENT_FAMILY_IN_UNIT_UUID.',
    );

    await login(page, NO_ADDON_CPF!, NO_ADDON_PASS!);
    await openRecord(page, FAMILY_IN_UNIT!);

    const bloco = page.getByTestId('family-access-denied');
    await expect(bloco).toBeVisible();
    await expect(bloco).toContainText(/acesso restrito/i);
    // A lotação na unidade NÃO substitui o add-on: continua sendo 403, não 404.
    await expect(page.getByTestId('family-not-found')).toHaveCount(0);
    await expect(page.getByTestId('family-no-active-assignment')).toHaveCount(0);

    await page.screenshot({
      path: 'test-results/10617-ca06-sem-addon.png',
      fullPage: true,
    });
  });
});
