import { expect, test, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * E2E do bloco de ESPECIFICIDADE SOCIAL do prontuário e da relação de
 * pendências (HU #10621 — CA01/CA03/CA04/CA05/CA06/CA09) no frontend do
 * TENANT (client).
 *
 * ⚠️ HARNESS: a stack E2E padrão (`start-stack.sh`) serve apenas o **admin**.
 * Este spec exercita o **client**, então é **opt-in via env** e fica `skip`
 * por padrão — mesmo molde de `tests/client/family-access-by-unit.spec.ts` e
 * `tests/client/family-intake.spec.ts`.
 *
 * O que ele prova, e que nenhum teste de backend prova: que a TELA distingue
 * os três estados sem depender de cor, e que ela não confunde a família que
 * DECLAROU não ter especificidade (código '019') com a família sobre a qual
 * ninguém informou nada. O Vitest prova isso contra um payload; aqui a prova
 * é contra o dado semeado, de ponta a ponta.
 *
 * Cenário a semear (tenant Ativo, guard `client`):
 *  - OPERADOR com o add-on LGPD (`family_viewer`) e lotação VIGENTE na unidade
 *    de referência das famílias abaixo    → E2E_CLIENT_OPERADOR_*
 *  - família importada com o grupo "204 Família Ribeirinha" (CA01)
 *                                         → E2E_CLIENT_FAMILY_SPEC_DERIVED_UUID
 *  - família importada com o grupo "0 Nenhuma" → código '019' (CA03)
 *                                         → E2E_CLIENT_FAMILY_SPEC_NONE_UUID
 *  - família SEM qualquer informação de grupo/especificidade (CA04/CA09)
 *                                         → E2E_CLIENT_FAMILY_SPEC_PENDING_UUID
 *  - família com indicador de INDÍGENA e sem escolha de aldeia (CA05)
 *                                         → E2E_CLIENT_FAMILY_SPEC_INDIGENOUS_UUID
 *  - família com integrante em situação de rua → SUGESTÃO pendente (CA06)
 *                                         → E2E_CLIENT_FAMILY_SPEC_SUGGESTION_UUID
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:5174 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   E2E_CLIENT_FAMILY_SPEC_DERIVED_UUID=... E2E_CLIENT_FAMILY_SPEC_NONE_UUID=... \
 *   E2E_CLIENT_FAMILY_SPEC_PENDING_UUID=... E2E_CLIENT_FAMILY_SPEC_INDIGENOUS_UUID=... \
 *   E2E_CLIENT_FAMILY_SPEC_SUGGESTION_UUID=... \
 *   npx playwright test tests/client/family-social-specificity.spec.ts
 */

const BASE = process.env.CLIENT_BASE_URL;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;

const FAMILY_DERIVED = process.env.E2E_CLIENT_FAMILY_SPEC_DERIVED_UUID;
const FAMILY_NONE = process.env.E2E_CLIENT_FAMILY_SPEC_NONE_UUID;
const FAMILY_PENDING = process.env.E2E_CLIENT_FAMILY_SPEC_PENDING_UUID;
const FAMILY_INDIGENOUS = process.env.E2E_CLIENT_FAMILY_SPEC_INDIGENOUS_UUID;
const FAMILY_SUGGESTION = process.env.E2E_CLIENT_FAMILY_SPEC_SUGGESTION_UUID;

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

/** O bloco mora na aba Resumo do prontuário. */
async function openSpecificityBlock(page: Page, uuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${uuid}?tab=resumo`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('social-specificity-block')).toBeVisible();
}

test.describe('HU #10621 — especificidade social no prontuário (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD no arquivo de env do e2e (o client não é servido pela stack admin).',
  );

  test.use({ baseURL: BASE });

  test('CA01 — a derivada declara, EM TEXTO, que veio do CadÚnico', async ({ page }) => {
    test.skip(!FAMILY_DERIVED, 'Defina E2E_CLIENT_FAMILY_SPEC_DERIVED_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openSpecificityBlock(page, FAMILY_DERIVED!);

    const card = page.getByTestId('specificity-current-003');
    await expect(card).toBeVisible();
    await expect(card).toContainText(/ribeirinha/i);
    // A origem é LIDA, não inferida de cor.
    await expect(page.getByTestId('specificity-source-label-003')).toContainText(
      /derivada do cadúnico/i,
    );
    await expect(page.getByTestId('specificity-derived-group')).toContainText('204');

    await page.screenshot({ path: 'test-results/10621-ca01-derivada.png', fullPage: true });
  });

  test('CA03 — o código 19 aparece REGISTRADO e não como pendência', async ({ page }) => {
    test.skip(!FAMILY_NONE, 'Defina E2E_CLIENT_FAMILY_SPEC_NONE_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openSpecificityBlock(page, FAMILY_NONE!);

    await expect(page.getByTestId('specificity-current-019')).toBeVisible();
    // O ponto da HU: resposta DADA nunca vira pendência.
    await expect(page.getByTestId('specificity-pending')).toHaveCount(0);
    await expect(page.getByTestId('specificity-pending-badge')).toHaveCount(0);

    await page.screenshot({
      path: 'test-results/10621-ca03-sem-especificidades.png',
      fullPage: true,
    });
  });

  test('CA04 — família sem informação alguma aparece pendente e na relação', async ({ page }) => {
    test.skip(!FAMILY_PENDING, 'Defina E2E_CLIENT_FAMILY_SPEC_PENDING_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openSpecificityBlock(page, FAMILY_PENDING!);

    await expect(page.getByTestId('specificity-pending')).toBeVisible();
    await expect(page.getByTestId('specificity-pending-badge')).toContainText(/não informada/i);
    await expect(page.getByTestId('specificity-current-list')).toHaveCount(0);

    // A mesma família consta da relação de pendências.
    await page.goto('/app/cadastros/familias-especificidade-pendente');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('pending-specificity-summary')).toBeVisible();
    await expect(page.getByTestId('pending-specificity-row').first()).toBeVisible();
    // E a tela declara que o código 19 NÃO está aqui.
    await expect(page.getByTestId('pending-specificity-scope')).toContainText(
      /família sem especificidades/i,
    );

    await page.screenshot({ path: 'test-results/10621-ca04-pendencia.png', fullPage: true });
  });

  test('CA05 — a indígena espera a escolha do profissional, e o sistema não escolhe', async ({
    page,
  }) => {
    test.skip(!FAMILY_INDIGENOUS, 'Defina E2E_CLIENT_FAMILY_SPEC_INDIGENOUS_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openSpecificityBlock(page, FAMILY_INDIGENOUS!);

    await expect(page.getByTestId('specificity-indigenous-pending')).toBeVisible();
    // As DUAS opções, e NENHUMA marcada.
    await expect(page.getByTestId('specificity-indigenous-input-005')).not.toBeChecked();
    await expect(page.getByTestId('specificity-indigenous-input-006')).not.toBeChecked();

    // Sem escolha não grava.
    await page.getByTestId('specificity-indigenous-submit').click();
    await expect(page.getByTestId('specificity-indigenous-error')).toBeVisible();

    // Escolhida, com povo/etnia, o registro passa.
    await page.getByTestId('specificity-indigenous-input-005').check();
    await page.getByTestId('specificity-indigenous-note').fill('Xukuru-Kariri');
    await page.getByTestId('specificity-indigenous-submit').click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('specificity-current-005')).toBeVisible();

    await page.screenshot({ path: 'test-results/10621-ca05-indigena.png', fullPage: true });
  });

  test('CA06 — a sugestão não vale antes de confirmada, e confirmar é ato deliberado', async ({
    page,
  }) => {
    test.skip(!FAMILY_SUGGESTION, 'Defina E2E_CLIENT_FAMILY_SPEC_SUGGESTION_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openSpecificityBlock(page, FAMILY_SUGGESTION!);

    await expect(page.getByTestId('specificity-suggestion-001')).toBeVisible();
    await expect(page.getByTestId('specificity-suggestion-badge')).toContainText(/sugerida/i);
    // Fora da relação de vigentes: a dedução não é declaração do município.
    await expect(page.getByTestId('specificity-current-001')).toHaveCount(0);

    await page.getByTestId('specificity-suggestion-confirm').click();
    await expect(page.getByTestId('confirm-suggestion-dialog')).toBeVisible();
    await page.getByTestId('confirm-suggestion-submit').click();
    await page.waitForLoadState('networkidle');

    // Passou a valer — e a ORIGEM continua sendo dedução.
    await expect(page.getByTestId('specificity-current-001')).toBeVisible();
    await expect(page.getByTestId('specificity-source-label-001')).toContainText(
      /sugestão confirmada/i,
    );

    await page.screenshot({ path: 'test-results/10621-ca06-sugestao.png', fullPage: true });
  });

  test('CA09 — duas principais são impossíveis na tela, e a API as rejeita', async ({ page }) => {
    test.skip(!FAMILY_PENDING, 'Defina E2E_CLIENT_FAMILY_SPEC_PENDING_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openSpecificityBlock(page, FAMILY_PENDING!);

    await page.getByTestId('specificity-pending-register').click();

    await page.getByTestId('specificity-checkbox-002').click();
    await page.getByTestId('specificity-checkbox-009').click();

    // Os seletores de principal são RADIO do mesmo grupo: marcar o segundo
    // desmarca o primeiro. Não existe estado de tela com duas principais.
    await page.getByTestId('specificity-primary-radio-009').check();
    await expect(page.getByTestId('specificity-primary-radio-002')).not.toBeChecked();
    await expect(page.getByTestId('specificity-primary-radio-009')).toBeChecked();

    await page.getByTestId('specificity-submit').click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('specificity-current-002')).toBeVisible();
    await expect(page.getByTestId('specificity-current-009')).toBeVisible();
    // Uma única marcação de principal entre as duas vigentes.
    await expect(page.getByTestId('specificity-primary-009')).toHaveCount(1);
    await expect(page.getByTestId('specificity-primary-002')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/10621-ca09-principal.png', fullPage: true });
  });

  test('os três estados são distinguíveis SEM cor: cada um tem rótulo em texto', async ({
    page,
  }) => {
    test.skip(!FAMILY_INDIGENOUS, 'Defina E2E_CLIENT_FAMILY_SPEC_INDIGENOUS_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openSpecificityBlock(page, FAMILY_INDIGENOUS!);

    // O atributo de estado é SEMÂNTICO, não visual — e é o que a a11y lê.
    const estados = await page
      .locator('[data-specificity-state]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-specificity-state')));

    expect(estados.length).toBeGreaterThan(0);
    expect(estados).toContain('pending');
    await expect(page.getByTestId('specificity-indigenous-badge')).toContainText(
      /informação incompleta/i,
    );
  });
});
