import { expect, test, type Locator, type Page } from '@playwright/test';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence, captureFinalEvidence } from '../../helpers/evidence';

// Sessão: estes casos rodam no project `chromium-tenant`, que herda o
// storageState do `tenant-auth.setup` — o MESMO operador que eles usariam.
// Nenhum login aqui: as rotas `/auth/*` têm `throttle:6,1` e um login a mais
// por caso derruba a suíte inteira (ver irmãos `family-follow-up.spec.ts` e
// `capacitation-actions.spec.ts`).

/**
 * US-BENEF-02 — registro da CONCESSÃO de benefício eventual no prontuário da
 * família (aba "Benefícios eventuais", bloco 12 do instrumento), no frontend
 * do TENANT (`client/`, porta 4174).
 *
 * ## O que este spec prova — e que nenhum teste de backend prova
 *
 *  1. CA01 — a cesta básica registrada pela TELA aparece no bloco com data,
 *     tipo, unidade e a assinatura (autor + data do lançamento);
 *  2. CA02/CA03 — os dois campos condicionais (registro de nascimento no
 *     Auxílio Natalidade; CPF da pessoa falecida no Auxílio Funeral) são
 *     recusados NO CAMPO quando ausentes — não um erro genérico de rodapé;
 *  3. CA05 — o CORAÇÃO da HU na UI: o campo condicional muda de FORMA
 *     conforme o tipo escolhido, ao vivo no mesmo formulário — aparece ao
 *     escolher Auxílio Funeral e SOME ao trocar para Aluguel social, sem
 *     que nenhum dos dois campos condicionais sobre na tela;
 *  4. CA06 — a mesma cesta básica pode ser concedida mais de uma vez no
 *     mesmo mês: nada na tela bloqueia ou avisa duplicidade (RN04/D05);
 *  5. CA07 — data futura é recusada, com a mesma régua do 422 já no cliente;
 *  6. CA10 — cancelar não é excluir: exige motivo, a linha CONTINUA visível
 *     marcada como cancelada, e não existe ação de excluir em lugar nenhum
 *     da linha.
 *
 * ## O que fica de fora, e por quê (não force, não invente)
 *
 *  - **CA08 (aviso de remessa do mês já gerada)**: o banner
 *    `eventual-benefit-remittance-warning` só aparece quando existe uma
 *    remessa SIAP gerada para o mês da concessão. A massa do `E2ESeeder`
 *    disponível a este spec não inclui uma remessa gerada, e gerar uma aqui
 *    seria inventar estado que a US-BENEF-02 não pede para montar. O
 *    backend já cobre o aviso (`EventualBenefitReportServiceTest` e a
 *    suíte de 71 testes citada no spawn).
 *
 * ## Achado ao ler o código (fora do escopo deste spec, registrado para o
 * relatório): `FamilyEventualBenefitResource::toArray()` (api/) NÃO devolve
 * `cancelled_at`/`cancelled_by`/`cancel_reason` — só `status`. O template de
 * `BeneficiosEventuaisTab.vue` foi escrito para exibir motivo e autor do
 * cancelamento na linha expandida (RN09), mas como a API nunca manda esses
 * três campos, esse bloco da UI nunca é preenchido de verdade (fica com
 * "autor não identificado" e sem a linha do motivo). Por isso o cenário do
 * CA10 abaixo verifica APENAS o que a HU pede aqui — motivo obrigatório no
 * diálogo, linha marcada como cancelada, sem excluir — e não afirma que o
 * motivo/autor aparecem na linha expandida, porque hoje eles não aparecem.
 *
 * ## PII — regra dura deste spec
 *
 * O CPF da pessoa falecida (Auxílio Funeral) é dado de TERCEIRO. Nenhum
 * cenário abaixo precisa digitar ou exibir um CPF: CA02/CA03 prova a
 * recusa do campo VAZIO (sem digitar nada) e CA05 prova só o
 * aparecer/sumir do campo (sem preenchê-lo). Por isso este spec nunca
 * importa `helpers/cpf.ts` — não há CPF, real ou gerado, em nenhum ponto.
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:4174 \
 *   npx playwright test tests/client/eventual-benefit-grant.spec.ts
 */

const EVIDENCE_SLUG = 'us-benef-02-registrar-concessao';

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_WORK = process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID;
const UNIT_UUID = process.env.E2E_CLIENT_UNIT_UUID;
const UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';

const configured = Boolean(BASE && FAMILY_WORK && UNIT_UUID);

/**
 * `code` dos tipos do bloco 12 (`EventualBenefitTypeSeeder`), ancorados pelo
 * CÓDIGO — o select rotula `código — nome` (`typeLabel`), e o código é a
 * parte ESTÁVEL (o nome é editável no Painel Global).
 */
const TYPE_BIRTH_ASSISTANCE = /^1\s*—/; // Auxílio Natalidade — pede registro de nascimento
const TYPE_FUNERAL_ASSISTANCE = /^2\s*—/; // Auxílio Funeral — pede CPF da pessoa falecida
const TYPE_FOOD_BASKET = /^4\s*—/; // Cesta Básica — nenhum campo condicional
const TYPE_SOCIAL_RENT = /^5\s*—/; // Aluguel social — nenhum campo condicional

type EventualBenefitRow = {
  uuid: string;
  status: 'registered' | 'cancelled';
  type: { uuid: string; code: string | null; name: string | null } | null;
};

/** Data no fuso LOCAL (`toISOString()` puro devolveria a data em UTC). */
function isoDaysFromToday(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);

  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Abre o prontuário já na aba "Benefícios eventuais" (`?tab=beneficios`). */
async function openBenefitsTab(page: Page, familyUuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=beneficios`);
  await page.waitForLoadState('networkidle');
  // O modal "Novidades da versão" põe aria-hidden no fundo e cega getByRole.
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId('eventual-benefit-block')).toBeVisible();
}

/** Abre o Sheet de registro e espera o primeiro carregamento de `options`. */
async function openRegisterSheet(page: Page): Promise<Locator> {
  const optionsLoaded = page.waitForResponse(
    (response) =>
      response.url().includes('/eventual-benefits/options') &&
      response.request().method() === 'GET',
  );
  await page.getByTestId('eventual-benefit-register-action').click();
  const sheet = page.getByTestId('eventual-benefit-form-sheet');
  await expect(sheet).toBeVisible();
  await optionsLoaded;

  return sheet;
}

/** Escolhe uma opção do Select (Reka UI). */
async function pick(page: Page, testId: string, option: RegExp): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: option }).first().click();
}

/** Envia o formulário e devolve a linha criada, do próprio corpo do 201. */
async function submitAndGetCreated(page: Page, sheet: Locator): Promise<EventualBenefitRow> {
  const created = page.waitForResponse(
    (response) =>
      response.url().includes('/eventual-benefits') &&
      !response.url().includes('/options') &&
      response.request().method() === 'POST',
  );
  await sheet.getByTestId('eventual-benefit-form-submit').click();
  const response = await created;
  expect(response.status(), 'registro da concessão').toBe(201);

  return ((await response.json()) as { data: EventualBenefitRow }).data;
}

test.describe('US-BENEF-02 — registro de concessão de benefício eventual (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_FAMILY_IN_UNIT_UUID + E2E_CLIENT_UNIT_UUID no arquivo de env do e2e.',
  );

  test.use({ baseURL: BASE, locale: 'pt-BR' });

  // Evidência do estado FINAL de cada caso aprovado. Sem `CAPTURE_EVIDENCE=1`
  // o corpo retorna na primeira linha e a suíte roda exatamente como antes.
  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA01 — registra uma cesta básica, com data, tipo, unidade e assinatura', async ({
    page,
  }, testInfo) => {
    await openBenefitsTab(page, FAMILY_WORK!);
    const sheet = await openRegisterSheet(page);

    await pick(page, 'eventual-benefit-form-unit', new RegExp(UNIT_NAME, 'i'));
    await pick(page, 'eventual-benefit-form-type', TYPE_FOOD_BASKET);
    await sheet.getByTestId('eventual-benefit-form-date').fill(isoDaysFromToday(0));

    const created = await submitAndGetCreated(page, sheet);
    await expect(sheet).toBeHidden();

    // A linha entra no bloco, com data, tipo e unidade.
    const row = page.getByTestId(`eventual-benefit-row-${created.uuid}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(/4\s*—\s*Cesta Básica/);
    await expect(row).toContainText(UNIT_NAME);
    await expect(page.getByTestId(`eventual-benefit-status-${created.uuid}`)).toHaveAttribute(
      'data-status',
      'registered',
    );

    // Expandida, a linha traz a assinatura: autor e data do lançamento (RN12).
    await page.getByTestId(`eventual-benefit-expand-${created.uuid}`).click();
    const details = page.getByTestId(`eventual-benefit-details-${created.uuid}`);
    await expect(details).toBeVisible();
    await expect(details).toContainText(/registrado por/i);
    await expect(details).not.toContainText('autor não identificado');

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'concessao-registrada');
  });

  test('CA02/CA03 — os campos condicionais são exigidos, com erro no campo', async ({
    page,
  }, testInfo) => {
    await openBenefitsTab(page, FAMILY_WORK!);

    // --- Auxílio Natalidade sem o registro de nascimento ---
    const birthSheet = await openRegisterSheet(page);
    await pick(page, 'eventual-benefit-form-unit', new RegExp(UNIT_NAME, 'i'));
    await pick(page, 'eventual-benefit-form-type', TYPE_BIRTH_ASSISTANCE);
    await birthSheet.getByTestId('eventual-benefit-form-date').fill(isoDaysFromToday(0));
    await birthSheet.getByTestId('eventual-benefit-form-submit').click();

    // A recusa é LOCAL (nenhuma requisição de escrita) e aponta o campo.
    await expect(birthSheet.getByText('Informe o registro de nascimento.')).toBeVisible();
    await expect(birthSheet, 'nada foi gravado — o Sheet continua aberto').toBeVisible();

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'erro-natalidade-sem-registro');
    await page.keyboard.press('Escape');
    await expect(birthSheet).toBeHidden();

    // --- Auxílio Funeral sem o CPF da pessoa falecida ---
    const funeralSheet = await openRegisterSheet(page);
    await pick(page, 'eventual-benefit-form-unit', new RegExp(UNIT_NAME, 'i'));
    await pick(page, 'eventual-benefit-form-type', TYPE_FUNERAL_ASSISTANCE);
    await funeralSheet.getByTestId('eventual-benefit-form-date').fill(isoDaysFromToday(0));
    await funeralSheet.getByTestId('eventual-benefit-form-submit').click();

    await expect(funeralSheet.getByText('Informe o CPF da pessoa falecida.')).toBeVisible();
    await expect(funeralSheet, 'nada foi gravado — o Sheet continua aberto').toBeVisible();

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'erro-funeral-sem-cpf');
    await page.keyboard.press('Escape');
  });

  test('CA05 — o campo condicional aparece no funeral e some no aluguel social', async ({
    page,
  }, testInfo) => {
    await openBenefitsTab(page, FAMILY_WORK!);
    const sheet = await openRegisterSheet(page);

    // Nenhum tipo escolhido ainda: nenhum dos dois campos condicionais existe.
    await expect(sheet.getByTestId('eventual-benefit-form-deceased-cpf')).toHaveCount(0);
    await expect(sheet.getByTestId('eventual-benefit-form-birth-registration')).toHaveCount(0);

    // Escolhe Auxílio Funeral: o campo de CPF APARECE — e só ele.
    await pick(page, 'eventual-benefit-form-type', TYPE_FUNERAL_ASSISTANCE);
    await expect(sheet.getByTestId('eventual-benefit-form-deceased-cpf')).toBeVisible();
    await expect(sheet.getByTestId('eventual-benefit-form-birth-registration')).toHaveCount(0);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'campo-cpf-aparece-no-funeral');

    // Troca para Aluguel social: o campo de CPF SOME — a transição é o que
    // este critério exige provar, não só o estado final.
    await pick(page, 'eventual-benefit-form-type', TYPE_SOCIAL_RENT);
    await expect(sheet.getByTestId('eventual-benefit-form-deceased-cpf')).toHaveCount(0);
    await expect(sheet.getByTestId('eventual-benefit-form-birth-registration')).toHaveCount(0);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'sem-campos-condicionais-no-aluguel');
  });

  test('CA06 — repetir a mesma cesta básica no mesmo mês não é bloqueado', async ({ page }) => {
    await openBenefitsTab(page, FAMILY_WORK!);

    async function registerFoodBasket(): Promise<EventualBenefitRow> {
      const sheet = await openRegisterSheet(page);
      await pick(page, 'eventual-benefit-form-unit', new RegExp(UNIT_NAME, 'i'));
      await pick(page, 'eventual-benefit-form-type', TYPE_FOOD_BASKET);
      await sheet.getByTestId('eventual-benefit-form-date').fill(isoDaysFromToday(0));
      const created = await submitAndGetCreated(page, sheet);
      await expect(sheet).toBeHidden();

      return created;
    }

    const first = await registerFoodBasket();
    const second = await registerFoodBasket();

    // Duas linhas independentes — nem aviso, nem bloqueio, nem substituição.
    expect(second.uuid, 'o segundo lançamento é uma linha NOVA').not.toBe(first.uuid);
    await expect(page.getByTestId(`eventual-benefit-row-${first.uuid}`)).toBeVisible();
    await expect(page.getByTestId(`eventual-benefit-row-${second.uuid}`)).toBeVisible();
    await expect(page.getByTestId(`eventual-benefit-status-${first.uuid}`)).toHaveAttribute(
      'data-status',
      'registered',
    );
    await expect(page.getByTestId(`eventual-benefit-status-${second.uuid}`)).toHaveAttribute(
      'data-status',
      'registered',
    );
  });

  test('CA07 — data futura é recusada', async ({ page }, testInfo) => {
    await openBenefitsTab(page, FAMILY_WORK!);
    const sheet = await openRegisterSheet(page);

    const date = sheet.getByTestId('eventual-benefit-form-date');
    // O bloqueio começa no campo: o seletor nativo não passa de hoje.
    await expect(date).toHaveAttribute('max', isoDaysFromToday(0));

    await pick(page, 'eventual-benefit-form-unit', new RegExp(UNIT_NAME, 'i'));
    await pick(page, 'eventual-benefit-form-type', TYPE_FOOD_BASKET);
    await date.fill(isoDaysFromToday(1));
    await sheet.getByTestId('eventual-benefit-form-submit').click();

    await expect(sheet.getByText('A data da concessão não pode ser futura.')).toBeVisible();
    await expect(sheet, 'nada foi gravado — o Sheet continua aberto').toBeVisible();

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'erro-data-futura');
  });

  test('CA10 — cancelar exige motivo, mantém a linha marcada, e não existe excluir', async ({
    page,
  }, testInfo) => {
    await openBenefitsTab(page, FAMILY_WORK!);
    const sheet = await openRegisterSheet(page);

    await pick(page, 'eventual-benefit-form-unit', new RegExp(UNIT_NAME, 'i'));
    await pick(page, 'eventual-benefit-form-type', TYPE_FOOD_BASKET);
    await sheet.getByTestId('eventual-benefit-form-date').fill(isoDaysFromToday(0));
    const created = await submitAndGetCreated(page, sheet);
    await expect(sheet).toBeHidden();

    const row = page.getByTestId(`eventual-benefit-row-${created.uuid}`);
    await expect(row).toBeVisible();

    // Não existe ação de excluir em lugar nenhum da linha — só corrigir/cancelar.
    await expect(row.getByRole('button', { name: /excluir|remover|apagar/i })).toHaveCount(0);
    await expect(page.locator('[data-testid^="eventual-benefit-delete-"]')).toHaveCount(0);

    await row.getByTestId(`eventual-benefit-cancel-${created.uuid}`).click();
    const dialog = page.getByTestId('cancel-eventual-benefit-dialog');
    await expect(dialog).toBeVisible();

    // Motivo é obrigatório: confirmar sem ele não cancela nada.
    await dialog.getByTestId('cancel-eventual-benefit-confirm').click();
    await expect(dialog.getByTestId('cancel-eventual-benefit-error')).toBeVisible();

    await dialog
      .getByTestId('cancel-eventual-benefit-reason')
      .fill('Registro lançado na família errada — cancelamento do cenário E2E.');
    await dialog.getByTestId('cancel-eventual-benefit-confirm').click();
    await expect(dialog).toBeHidden();

    // CANCELAR NÃO APAGA: a linha continua visível, agora marcada.
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`eventual-benefit-status-${created.uuid}`)).toHaveAttribute(
      'data-status',
      'cancelled',
    );
    // E, mesmo cancelada, a linha segue sem qualquer ação de excluir.
    await expect(row.getByRole('button', { name: /excluir|remover|apagar/i })).toHaveCount(0);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'concessao-cancelada');
  });
});
