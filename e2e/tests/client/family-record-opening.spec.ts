import { expect, test, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * E2E da abertura do prontuário e da unidade de referência (HU #10618 —
 * CA01, CA02, CA03, CA05, CA06, CA07) no frontend do TENANT (client).
 *
 * ⚠️ HARNESS: a stack E2E padrão (`start-stack.sh`) serve apenas o **admin**.
 * Este spec exercita o **client**, então é **opt-in via env** e fica `skip`
 * por padrão — mesmo molde de `tests/client/family-access-by-unit.spec.ts` e
 * `tests/client/cadunico-imports.spec.ts`.
 *
 * O que ele prova (e que nenhum teste de backend prova): que o usuário LÊ os
 * dois avisos ANTES de confirmar — o da unidade sem número MDS (CA05, que
 * NÃO bloqueia) e o da perda de acesso da equipe anterior (CA06, que o
 * backend exige confirmar) — e que nenhuma unidade é sugerida (RN07/CA04).
 *
 * Cenário a semear (tenant Ativo, guard `client`):
 *  - OPERADOR com o add-on LGPD (`family_viewer`) e lotação VIGENTE em UMA
 *    unidade em atividade                      → E2E_CLIENT_OPERADOR_*
 *  - família SEM unidade de referência, cuja pessoa de referência tem nome
 *    conhecido                                 → E2E_CLIENT_PENDING_FAMILY_NAME
 *  - a unidade da lotação                      → E2E_CLIENT_UNIT_NAME
 *  - uma unidade em atividade SEM número MDS   → E2E_CLIENT_UNIT_WITHOUT_MDS_NAME
 *  - uma unidade em atividade FORA da lotação  → E2E_CLIENT_UNIT_NOT_ASSIGNED_NAME
 *  - MASTER + família já com unidade, para a troca
 *                                              → E2E_CLIENT_MASTER_*,
 *                                                E2E_CLIENT_FAMILY_IN_UNIT_UUID,
 *                                                E2E_CLIENT_CHANGE_TO_UNIT_NAME
 *
 * Rodar localmente (variáveis no arquivo de ambiente do e2e):
 *   CLIENT_BASE_URL=http://localhost:5174 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   E2E_CLIENT_PENDING_FAMILY_NAME="Ana Maria da Silva" \
 *   E2E_CLIENT_UNIT_NAME="CRAS Centro" \
 *   npx playwright test tests/client/family-record-opening.spec.ts
 */

const BASE = process.env.CLIENT_BASE_URL;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;
const PENDING_FAMILY_NAME = process.env.E2E_CLIENT_PENDING_FAMILY_NAME;
const UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME;
const UNIT_WITHOUT_MDS_NAME = process.env.E2E_CLIENT_UNIT_WITHOUT_MDS_NAME;
const UNIT_NOT_ASSIGNED_NAME = process.env.E2E_CLIENT_UNIT_NOT_ASSIGNED_NAME;
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF;
const MASTER_PASS = process.env.E2E_CLIENT_MASTER_PASSWORD;
const FAMILY_IN_UNIT = process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID;
const CHANGE_TO_UNIT_NAME = process.env.E2E_CLIENT_CHANGE_TO_UNIT_NAME;

const PENDING_LIST_PATH = '/app/cadastros/familias-sem-unidade';

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

async function openPendingList(page: Page): Promise<void> {
  await page.goto(PENDING_LIST_PATH);
  await page.waitForLoadState('networkidle');
}

/** Linha da relação identificada pelo NOME da pessoa de referência (CA02). */
function pendingRow(page: Page, name: string) {
  return page.getByTestId('families-without-unit-row').filter({ hasText: name });
}

/** Abre o drawer de abertura a partir da linha da família. */
async function openDrawerFor(page: Page, name: string): Promise<void> {
  await pendingRow(page, name).getByTestId('families-without-unit-open').first().click();
  await expect(page.getByTestId('open-record-drawer')).toBeVisible();
}

/** Escolhe a unidade no seletor (reka-ui: trigger → listbox). */
async function selectUnit(page: Page, triggerTestId: string, unitName: string): Promise<void> {
  await page.getByTestId(triggerTestId).click();
  await page
    .getByRole('option', { name: new RegExp(unitName, 'i') })
    .first()
    .click();
}

test.describe('HU #10618 — abertura do prontuário e unidade de referência (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD no ambiente do e2e (o client não é servido pela stack admin).',
  );

  test.use({ baseURL: BASE });

  test('CA02 — a relação lista as famílias sem unidade pela pessoa de referência', async ({
    page,
  }) => {
    test.skip(!PENDING_FAMILY_NAME, 'Defina E2E_CLIENT_PENDING_FAMILY_NAME.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openPendingList(page);

    await expect(page.getByRole('heading', { name: /famílias sem unidade/i })).toBeVisible();
    await expect(page.getByTestId('families-without-unit-summary')).toBeVisible();
    await expect(pendingRow(page, PENDING_FAMILY_NAME!)).toHaveCount(1);
    // Caminho DIRETO para a atribuição, na própria linha.
    await expect(
      pendingRow(page, PENDING_FAMILY_NAME!).getByTestId('families-without-unit-open'),
    ).toBeVisible();

    await page.screenshot({ path: 'test-results/10618-ca02-relacao.png', fullPage: true });
  });

  test('CA04/RN07 — nenhuma unidade é sugerida: o seletor abre vazio', async ({ page }) => {
    test.skip(!PENDING_FAMILY_NAME, 'Defina E2E_CLIENT_PENDING_FAMILY_NAME.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openPendingList(page);
    await openDrawerFor(page, PENDING_FAMILY_NAME!);

    // Placeholder, e não uma unidade "conveniente" já escolhida.
    await expect(page.getByTestId('open-record-unit-trigger')).toContainText(
      /selecione a unidade/i,
    );
    await expect(page.getByTestId('open-record-mds-warning')).toHaveCount(0);
  });

  test('CA07 — só as unidades da lotação são oferecidas', async ({ page }) => {
    test.skip(
      !(PENDING_FAMILY_NAME && UNIT_NAME && UNIT_NOT_ASSIGNED_NAME),
      'Defina E2E_CLIENT_PENDING_FAMILY_NAME + E2E_CLIENT_UNIT_NAME + E2E_CLIENT_UNIT_NOT_ASSIGNED_NAME.',
    );

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openPendingList(page);
    await openDrawerFor(page, PENDING_FAMILY_NAME!);

    await page.getByTestId('open-record-unit-trigger').click();

    await expect(page.getByRole('option', { name: new RegExp(UNIT_NAME!, 'i') })).toHaveCount(1);
    // A unidade fora da lotação NÃO é oferecida — nem desabilitada, nem oculta.
    await expect(
      page.getByRole('option', { name: new RegExp(UNIT_NOT_ASSIGNED_NAME!, 'i') }),
    ).toHaveCount(0);

    await page.screenshot({ path: 'test-results/10618-ca07-unidades.png', fullPage: true });
  });

  test('CA05 — unidade sem número MDS avisa ANTES de confirmar e NÃO bloqueia', async ({
    page,
  }) => {
    test.skip(
      !(PENDING_FAMILY_NAME && UNIT_WITHOUT_MDS_NAME),
      'Defina E2E_CLIENT_PENDING_FAMILY_NAME + E2E_CLIENT_UNIT_WITHOUT_MDS_NAME.',
    );

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openPendingList(page);
    await openDrawerFor(page, PENDING_FAMILY_NAME!);

    await selectUnit(page, 'open-record-unit-trigger', UNIT_WITHOUT_MDS_NAME!);

    const aviso = page.getByTestId('open-record-mds-warning');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText(/número mds/i);
    await expect(aviso).toContainText(/tce-al/i);
    // NÃO é bloqueio: o botão de abrir continua habilitado.
    await expect(page.getByTestId('open-record-submit')).toBeEnabled();

    await page.screenshot({ path: 'test-results/10618-ca05-aviso-mds.png', fullPage: true });
  });

  test('CA01/CA03 — abre o prontuário e a família some da relação', async ({ page }) => {
    test.skip(
      !(PENDING_FAMILY_NAME && UNIT_NAME),
      'Defina E2E_CLIENT_PENDING_FAMILY_NAME + E2E_CLIENT_UNIT_NAME.',
    );

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openPendingList(page);
    await openDrawerFor(page, PENDING_FAMILY_NAME!);

    // O número do prontuário e a pessoa de referência são LEITURA (já existem).
    await expect(page.getByTestId('open-record-responsible')).toContainText(PENDING_FAMILY_NAME!);
    const recordNumber = (await page.getByTestId('open-record-number').innerText()).trim();

    await selectUnit(page, 'open-record-unit-trigger', UNIT_NAME!);
    await page.getByTestId('open-record-submit').click();
    await page.waitForLoadState('networkidle');

    // CA03: a família sai da relação, sem recarregar a página.
    await expect(pendingRow(page, PENDING_FAMILY_NAME!)).toHaveCount(0);

    await page.screenshot({ path: 'test-results/10618-ca03-some-da-relacao.png', fullPage: true });

    // E continua fora da relação numa consulta nova (a pendência é calculada).
    await page.goto(PENDING_LIST_PATH);
    await page.waitForLoadState('networkidle');
    await expect(pendingRow(page, PENDING_FAMILY_NAME!)).toHaveCount(0);

    expect(recordNumber).not.toBe('');
  });

  test('CA01 — a capa mostra número, pessoa de referência, tipo e nome da unidade', async ({
    page,
  }) => {
    test.skip(
      !(MASTER_CPF && MASTER_PASS && FAMILY_IN_UNIT && UNIT_NAME),
      'Defina E2E_CLIENT_MASTER_CPF/PASSWORD + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_UNIT_NAME.',
    );

    await login(page, MASTER_CPF!, MASTER_PASS!);
    await page.goto(`/app/cadastros/familias/${FAMILY_IN_UNIT}`);
    await page.waitForLoadState('networkidle');

    const capa = page.getByTestId('family-record-cover');
    await expect(capa).toBeVisible();
    await expect(capa.getByTestId('family-record-responsible')).toBeVisible();
    // "TIPO · NOME" — o tipo vem do cadastro da unidade (RN04), nunca digitado.
    await expect(capa.getByTestId('family-reference-unit')).toContainText(/.+ · .+/);
    await expect(capa.getByTestId('family-reference-unit')).toContainText(
      new RegExp(UNIT_NAME!, 'i'),
    );
    await expect(capa.getByTestId('family-change-unit')).toBeVisible();

    await page.screenshot({ path: 'test-results/10618-ca01-capa.png', fullPage: true });
  });

  test('CA06 — a troca declara a perda de acesso da equipe anterior antes de confirmar', async ({
    page,
  }) => {
    test.skip(
      !(MASTER_CPF && MASTER_PASS && FAMILY_IN_UNIT && CHANGE_TO_UNIT_NAME),
      'Defina E2E_CLIENT_MASTER_CPF/PASSWORD + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_CHANGE_TO_UNIT_NAME.',
    );

    await login(page, MASTER_CPF!, MASTER_PASS!);
    await page.goto(`/app/cadastros/familias/${FAMILY_IN_UNIT}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('family-change-unit').click();
    await expect(page.getByTestId('change-reference-unit-dialog')).toBeVisible();

    // O aviso está na tela ANTES de qualquer escolha ou confirmação.
    const aviso = page.getByTestId('change-previous-unit-warning');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText(/deixará de enxergar/i);

    await selectUnit(page, 'change-unit-trigger', CHANGE_TO_UNIT_NAME!);
    await page.getByTestId('change-submit').click();
    await page.waitForLoadState('networkidle');

    // 1º clique NÃO grava: o backend devolve o aviso e a ação vira "confirmar".
    await expect(aviso).toContainText(/deixará de enxergar/i);
    await expect(page.getByTestId('change-submit')).toContainText(/confirmar a troca/i);

    await page.screenshot({ path: 'test-results/10618-ca06-aviso-troca.png', fullPage: true });

    await page.getByTestId('change-submit').click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('change-reference-unit-dialog')).toHaveCount(0);
    await expect(page.getByTestId('family-reference-unit')).toContainText(
      new RegExp(CHANGE_TO_UNIT_NAME!, 'i'),
    );
  });
});
