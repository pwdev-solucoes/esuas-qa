import { expect, test, type Page } from '@playwright/test';
import { resetTenantSession } from '../../fixtures/tenant-auth';

/**
 * E2E da COMPOSIÇÃO FAMILIAR EDITÁVEL (HU #10620 · US-PRONT-04 —
 * CA01/CA02/CA03/CA04/CA05/CA06/CA07/CA08/CA09/CA10) no frontend do TENANT.
 *
 * ⚠️ HARNESS: a stack E2E padrão (`start-stack.sh`) serve apenas o **admin**.
 * Este spec exercita o **client**, então é **opt-in via env** e fica `skip`
 * por padrão — mesmo molde de `tests/client/family-access-by-unit.spec.ts`.
 *
 * O que ele prova, e que nenhum teste de backend prova: a REDAÇÃO e as
 * AFORDÂNCIAS da tela. Em especial as três que esta HU não pode errar:
 *
 *  1. a ação oferecida é **Desvincular**, jamais "Excluir", e a tela declara
 *     que a pessoa continua existindo (CA03);
 *  2. no conflito do CA04 a tela **informa e conduz** ao desvínculo anterior
 *     — não existe botão que desvincule por conta própria;
 *  3. o perfil etário é **exibido** e não tem um único campo digitável (CA08).
 *
 * Cenário a semear (tenant Ativo, guard `client`):
 *  - OPERADOR com o add-on LGPD (`family_viewer`) e lotação VIGENTE      → E2E_CLIENT_OPERADOR_*
 *  - família acessível, com integrante além da pessoa de referência      → E2E_CLIENT_FAMILY_IN_UNIT_UUID
 *  - pessoa (CPF) que JÁ integra OUTRA família do município (CA04)       → E2E_CLIENT_PERSON_IN_OTHER_FAMILY_CPF
 *  - pessoa do município SEM família, para a inclusão do CA01            → E2E_CLIENT_PERSON_FREE_CPF
 *  - família com integrante desvinculado no histórico (CA02)             → E2E_CLIENT_FAMILY_WITH_HISTORY_UUID
 *  - família com divergência de importação em aberto (CA10)              → E2E_CLIENT_FAMILY_WITH_DIVERGENCE_UUID
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:5174 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   E2E_CLIENT_FAMILY_IN_UNIT_UUID=... \
 *   npx playwright test tests/client/family-composition.spec.ts
 */

const BASE = process.env.CLIENT_BASE_URL;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;
const FAMILY_UUID = process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID;
const FAMILY_WITH_HISTORY = process.env.E2E_CLIENT_FAMILY_WITH_HISTORY_UUID ?? FAMILY_UUID;
const FAMILY_WITH_DIVERGENCE = process.env.E2E_CLIENT_FAMILY_WITH_DIVERGENCE_UUID;
const PERSON_IN_OTHER_FAMILY_CPF = process.env.E2E_CLIENT_PERSON_IN_OTHER_FAMILY_CPF;
const PERSON_FREE_CPF = process.env.E2E_CLIENT_PERSON_FREE_CPF;

const configured = Boolean(BASE && OPERADOR_CPF && OPERADOR_PASS && FAMILY_UUID);

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

/** Abre o prontuário já na aba Composição (a aba sincroniza com `?tab=`). */
async function openComposition(page: Page, uuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${uuid}?tab=composicao`);
  await page.waitForLoadState('networkidle');
}

/** Primeiro integrante que NÃO é a pessoa de referência (RN01). */
async function firstUnlinkableRow(page: Page) {
  const action = page.locator('[data-testid^="member-unlink-"]').first();
  await expect(action).toBeVisible();
  return action;
}

test.describe('HU #10620 — composição familiar editável (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD + E2E_CLIENT_FAMILY_IN_UNIT_UUID no arquivo de ambiente do e2e (o client não é servido pela stack admin).',
  );

  test.use({ baseURL: BASE });

  test('CA02/CA03 — a ação é DESVINCULAR, exige data e motivo, e declara que a pessoa continua existindo', async ({
    page,
  }) => {
    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openComposition(page, FAMILY_UUID!);

    const unlink = await firstUnlinkableRow(page);
    await expect(unlink).toHaveText(/desvincular/i);

    // O rótulo destrutivo não pode existir na aba: o backend mantém
    // `deleted_at` NULL e a pessoa continua existindo.
    await expect(page.getByRole('button', { name: /^excluir$/i })).toHaveCount(0);

    await unlink.click();

    await expect(page.getByTestId('unlink-member-dialog')).toBeVisible();
    await expect(page.getByTestId('unlink-not-deletion-notice')).toContainText(
      /não exclui a pessoa/i,
    );
    await expect(page.getByTestId('unlink-not-deletion-notice')).toContainText(
      /continua existindo/i,
    );

    // Data e motivo são obrigatórios: sem eles, nada é gravado.
    await page.getByTestId('unlink-date-input').fill('');
    await page.getByTestId('unlink-confirm').click();
    await expect(page.getByTestId('unlink-error')).toBeVisible();

    await page.screenshot({
      path: 'test-results/10620-ca02-desvincular.png',
      fullPage: true,
    });
  });

  test('CA02 — integrantes desvinculados aparecem no HISTÓRICO, com data e motivo', async ({
    page,
  }) => {
    test.skip(!FAMILY_WITH_HISTORY, 'Defina E2E_CLIENT_FAMILY_WITH_HISTORY_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openComposition(page, FAMILY_WITH_HISTORY!);

    const historico = page.getByTestId('composition-history');
    await expect(historico).toBeVisible();
    await expect(historico).toContainText(/integrantes desvinculados/i);
    // A promessa dita na própria tela: ninguém é excluído da composição.
    await expect(historico).toContainText(/ninguém é excluído/i);
    await expect(historico.locator('[data-testid^="history-row-"]').first()).toBeVisible();
  });

  test('CA01/CA09 — incluir integrante pela busca da #10660, com o parentesco do instrumento', async ({
    page,
  }) => {
    test.skip(!PERSON_FREE_CPF, 'Defina E2E_CLIENT_PERSON_FREE_CPF.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openComposition(page, FAMILY_UUID!);

    await page.getByTestId('composition-add-member').click();
    await expect(page.getByTestId('add-member-drawer')).toBeVisible();

    await page.getByTestId('add-member-cpf-input').fill(PERSON_FREE_CPF!);
    await page.getByTestId('add-member-cpf-submit').click();
    await page.waitForLoadState('networkidle');

    await page.getByTestId('add-member-select-person').first().click();
    await expect(page.getByTestId('add-member-selected')).toBeVisible();

    // CA09 — o parentesco é sempre EM RELAÇÃO à pessoa de referência.
    await expect(page.getByTestId('add-member-drawer')).toContainText(
      /parentesco com a pessoa de referência/i,
    );
    await page.getByTestId('add-member-kinship-trigger').click();
    await page.getByRole('option').first().click();

    await page.getByTestId('add-member-submit').click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('add-member-drawer')).toHaveCount(0);
  });

  test('CA04 — pessoa já em outra família: a tela INFORMA e CONDUZ, sem desvincular sozinha', async ({
    page,
  }) => {
    test.skip(!PERSON_IN_OTHER_FAMILY_CPF, 'Defina E2E_CLIENT_PERSON_IN_OTHER_FAMILY_CPF.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openComposition(page, FAMILY_UUID!);

    await page.getByTestId('composition-add-member').click();
    await page.getByTestId('add-member-cpf-input').fill(PERSON_IN_OTHER_FAMILY_CPF!);
    await page.getByTestId('add-member-cpf-submit').click();
    await page.waitForLoadState('networkidle');

    await page.getByTestId('add-member-select-person').first().click();
    await page.getByTestId('add-member-kinship-trigger').click();
    await page.getByRole('option').first().click();
    await page.getByTestId('add-member-submit').click();
    await page.waitForLoadState('networkidle');

    const conflito = page.getByTestId('member-conflict-dialog');
    await expect(conflito).toBeVisible();
    await expect(page.getByTestId('conflict-requires-unlink')).toContainText(
      /registre primeiro o desvínculo/i,
    );
    await expect(page.getByTestId('conflict-requires-unlink')).toContainText(
      /não desvincula por conta própria/i,
    );

    // O CRITÉRIO da CA04: não existe, aqui, ação alguma que desvincule.
    await expect(conflito.getByRole('button', { name: /desvincular/i })).toHaveCount(0);
    await expect(conflito.getByRole('button', { name: /excluir/i })).toHaveCount(0);

    await page.screenshot({
      path: 'test-results/10620-ca04-conflito.png',
      fullPage: true,
    });
  });

  test('CA08 — perfil etário é EXIBIDO e não tem campo digitável', async ({ page }) => {
    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openComposition(page, FAMILY_UUID!);

    const perfil = page.getByTestId('age-profile-card');
    await expect(perfil).toBeVisible();
    await expect(page.getByTestId('age-profile-total')).toBeVisible();
    await expect(perfil).toContainText(/calculado a partir das datas de nascimento/i);

    // Nenhuma afordância de escrita: o número não é digitado, é derivado.
    await expect(perfil.locator('input')).toHaveCount(0);
    await expect(perfil.locator('textarea')).toHaveCount(0);

    await page.screenshot({
      path: 'test-results/10620-ca08-perfil-etario.png',
      fullPage: true,
    });
  });

  test('CA05/CA06/CA07 — documentação a providenciar e nome da mãe (editável só quando vazio)', async ({
    page,
  }) => {
    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openComposition(page, FAMILY_UUID!);

    await page.locator('[data-testid^="member-details-"]').first().click();

    // CA05 — a lista de documentação civil vem do lookup global.
    const documentos = page.getByTestId('pending-documents-block').first();
    await expect(documentos).toBeVisible();
    await expect(documentos).toContainText(/documentação a providenciar/i);

    // CA06/CA07 — o nome da mãe existe em UMA das duas formas: editável
    // (veio vazio) ou apresentado sem edição (já preenchido).
    const editavel = page.locator('[data-testid^="member-mother-name-input-"]');
    const somenteLeitura = page.locator('[data-testid^="member-mother-name-readonly-"]');
    expect((await editavel.count()) + (await somenteLeitura.count())).toBeGreaterThan(0);

    // Quando é apresentado, NÃO há campo de edição para a mesma pessoa.
    if ((await somenteLeitura.count()) > 0) {
      const uuid = (await somenteLeitura.first().getAttribute('data-testid'))!.replace(
        'member-mother-name-readonly-',
        '',
      );
      await expect(page.getByTestId(`member-mother-name-input-${uuid}`)).toHaveCount(0);
      await expect(page.getByTestId(`member-mother-name-save-${uuid}`)).toHaveCount(0);
    }

    await page.screenshot({
      path: 'test-results/10620-ca05-ca07-documentacao-nome-mae.png',
      fullPage: true,
    });
  });

  test('CA10 — divergência da importação é apresentada com o caminho de resolução', async ({
    page,
  }) => {
    test.skip(!FAMILY_WITH_DIVERGENCE, 'Defina E2E_CLIENT_FAMILY_WITH_DIVERGENCE_UUID.');

    await login(page, OPERADOR_CPF!, OPERADOR_PASS!);
    await openComposition(page, FAMILY_WITH_DIVERGENCE!);

    const painel = page.getByTestId('import-divergences-panel');
    await expect(painel).toBeVisible();
    await expect(painel).toContainText(/nada foi alterado automaticamente/i);
    await expect(painel).toContainText(/não altera a composição/i);
    await expect(painel.locator('[data-testid^="divergence-resolve-"]').first()).toBeVisible();

    await page.screenshot({
      path: 'test-results/10620-ca10-divergencia.png',
      fullPage: true,
    });
  });
});
