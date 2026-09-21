import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createTenantApiClient } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureFinalEvidence } from '../../helpers/evidence';

/**
 * HU #10713 (US-ENCAM-02, épico HU-ENCAM · fase F2) — registrar o encaminhamento
 * e emitir o formulário do cidadão, no Painel do Tenant (`client/`).
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que o FORMULÁRIO conduz quem registra: a lista de códigos não oferece o que a
 * regra proíbe (CA05), o campo de pessoa aparece e explica-se quando o código
 * conta indivíduos (CA02), os campos obrigatórios do código livre são cobrados
 * na própria tela (CA06) e a data futura é barrada antes de virar requisição
 * (CA09). O Pest garante que a API recusa; só o navegador mostra se a interface
 * chega a OFERECER o caminho proibido — afordância que promete o que o sistema
 * nega.
 *
 * Prova também as duas afordâncias negativas do ciclo de vida: cancelado
 * permanece no prontuário marcado e deixa de oferecer correção (CA12/CA15), e
 * família sem unidade de referência não oferece a ação de registrar (CA17).
 *
 * E a redação que o backend controla mas o usuário lê: a negativa de acesso não
 * nomeia unidade alguma (CA13). Do CA07, prova a metade que é da tela — a
 * emissão entrega mesmo um PDF ao profissional; a metade sensível (o objetivo
 * NÃO viajar no papel do cidadão) fica no Pest, pela razão explicada no caso.
 *
 * ## Triagem dos CAs (skill `e2e-testing`)
 *
 * Navegador (aqui): CA01, CA02, CA05, CA06, CA09, CA12/CA15, CA13, CA17 e a
 * emissão do CA07.
 * Pest (`api/tests/Feature/Api/Client/Referral*Test.php`): CA03 e CA04 (regra de
 * contagem), CA08 (reemissão auditada), CA10 e CA12b (avisos de remessa, que
 * exigem remessa gerada no período), CA11 (trilha sem expor conteúdo), CA14
 * (isolamento entre municípios) e CA16 (a edição revalida a exigência de pessoa).
 *
 * ## Massa (pré-condição)
 *
 * Tudo do `E2EProntuarioSeeder`, sem massa nova: família referenciada na unidade
 * do operador (`…0f0001`), família referenciada em OUTRA unidade (`…0f0002`,
 * usada só para a negativa do CA13 — nada é criado nela) e família SEM unidade
 * de referência (`…0f0003`). Os códigos vêm do `ReferralCodeSeeder`: "09" exige
 * pessoa, "85" é livre, "13" é restrito à origem CRAS e "14" à origem CREAS.
 *
 * ⚠️ HARNESS: o project `chromium-tenant` entrega `page` autenticado como o
 * `E2E_CLIENT_OPERADOR_*` (lotado no "E2E CRAS Centro"). Nenhum cenário faz
 * login — as rotas `/auth/*` têm throttle de 6 req/min.
 *
 * ⚠️ ESTADO: encaminhamento não se apaga (cancelar marca a linha). Cada execução
 * acrescenta registros à família de trabalho e os cenários seguintes operam
 * sobre o que ESTA execução criou — por isso o bloco é `serial` e os uuids
 * criados ficam em memória. Nada é semeado e nada precisa de limpeza.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_WORK =
  process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID ?? '00000000-0000-4000-8000-0000000f0001';
const FAMILY_OTHER_UNIT =
  process.env.E2E_CLIENT_FAMILY_OTHER_UNIT_UUID ?? '00000000-0000-4000-8000-0000000f0002';
const FAMILY_NO_UNIT =
  process.env.E2E_CLIENT_FAMILY_NO_UNIT_UUID ?? '00000000-0000-4000-8000-0000000f0003';

const ORIGIN_UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';

const configured = Boolean(BASE && FAMILY_WORK);

/** Dossiê de aceite alimentado por este spec (só com `CAPTURE_EVIDENCE=1`). */
const EVIDENCE_SLUG = 'hu-10713-registrar-encaminhamento';

/** Códigos do instrumento usados aqui — o estável é o `code`, nunca o uuid. */
const CODE_BPC = '09'; // exige pessoa identificada (conta indivíduos)
const CODE_FREE = '85'; // código livre: destino e objetivo obrigatórios
const CODE_FROM_CRAS = '13'; // restrito à origem CRAS
const CODE_FROM_CREAS = '14'; // restrito à origem CREAS — NÃO pode ser oferecido aqui

let api: APIRequestContext;
/** Encaminhamento criado no CA01 — pré-requisito do CA07 e do CA12/CA15. */
let createdUuid = '';

const SEED_HINT =
  `A massa de encaminhamento não está na base: o catálogo precisa dos códigos ${CODE_BPC}, ` +
  `${CODE_FREE}, ${CODE_FROM_CRAS} e ${CODE_FROM_CREAS}. Rode ` +
  `"php artisan db:seed --class=Database\\Seeders\\E2ESeeder --force" no container da API e repita.`;

test.beforeAll(async () => {
  if (!configured) return;

  api = await createTenantApiClient();

  // Guarda de integridade: sem os códigos certos, os cenários mediriam outra coisa.
  const options = await api.get(`/api/client/families/${FAMILY_WORK}/referrals/options`);
  expect(options.status(), 'options de encaminhamento').toBe(200);

  const codes = ((await options.json()).data.codes ?? []) as Array<{ code: string }>;
  const available = codes.map((item) => item.code);

  expect(available, SEED_HINT).toEqual(expect.arrayContaining([CODE_BPC, CODE_FREE]));
});

test.afterAll(async () => {
  await api?.dispose();
});

async function openReferralsTab(page: Page, familyUuid = FAMILY_WORK): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=encaminhamentos`);
  await dismissPlatformUpdates(page);
}

/** Abre o formulário já com a unidade de origem escolhida. */
async function openSheet(page: Page): Promise<void> {
  await page.getByTestId('referral-register-action').click();
  await expect(page.getByTestId('referral-form-sheet')).toBeVisible();

  // ⚠️ ORDEM: os códigos restritos só são ofertados depois da unidade de origem.
  await page.getByTestId('referral-form-unit').click();
  await page.getByRole('option', { name: ORIGIN_UNIT_NAME }).click();
}

async function chooseCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('referral-form-code').click();
  await page.getByRole('option', { name: new RegExp(`^${code} —`) }).click();
}

test.describe('HU #10713 — registrar encaminhamento no prontuário (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL (+ E2E_CLIENT_FAMILY_IN_UNIT_UUID) em e2e/.env.e2e.',
  );

  // O registro do CA01 é pré-requisito do CA07 e do CA12/CA15.
  test.describe.configure({ mode: 'serial' });

  // `locale` não é cosmético: as mensagens 409/422 exibidas vêm do backend.
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA05 — a lista de códigos respeita o tipo da unidade de origem', async ({ page }) => {
    await openReferralsTab(page);
    await openSheet(page);

    await page.getByTestId('referral-form-code').click();
    const offered = (await page.getByRole('option').allInnerTexts()).map((text) => text.trim());

    // Partindo de um CRAS: o código que SAI do CRAS é oferecido…
    expect(offered.some((text) => text.startsWith(`${CODE_FROM_CRAS} —`))).toBe(true);
    // …e o que sai do CREAS, não.
    expect(offered.some((text) => text.startsWith(`${CODE_FROM_CREAS} —`))).toBe(false);

    await page.keyboard.press('Escape');
    await page.getByTestId('referral-form-sheet').press('Escape');
  });

  test('CA02 — o código que conta indivíduos exige a pessoa, e a tela explica por quê', async ({
    page,
  }) => {
    await openReferralsTab(page);
    await openSheet(page);
    await chooseCode(page, CODE_BPC);

    // A tela ANTECIPA a regra, em vez de deixar o usuário descobrir no erro.
    await expect(page.getByTestId('referral-person-required-hint')).toBeVisible();
    await expect(page.getByTestId('referral-person-required-hint')).toContainText(/indiv[íi]duos/i);

    await page.getByTestId('referral-form-objective').fill('Encaminhamento ao BPC (E2E)');
    await page.getByTestId('referral-form-submit').click();

    // Sem pessoa, nada é salvo: a sheet continua aberta e o campo é cobrado.
    await expect(page.getByTestId('referral-form-sheet')).toBeVisible();
    await expect(page.getByTestId('referral-form-person')).toBeVisible();

    await page.getByTestId('referral-form-sheet').press('Escape');
  });

  test('CA06 — o código livre cobra destino e objetivo na própria tela', async ({ page }) => {
    await openReferralsTab(page);
    await openSheet(page);
    await chooseCode(page, CODE_FREE);

    // Código livre volta ao destino em texto — e ele é obrigatório.
    await expect(page.getByTestId('referral-form-destination')).toBeVisible();

    await page.getByTestId('referral-form-submit').click();

    await expect(page.getByTestId('referral-form-sheet')).toBeVisible();
    await expect(page.getByTestId('referral-form-destination')).toBeVisible();
    await expect(page.getByTestId('referral-form-objective')).toBeVisible();

    await page.getByTestId('referral-form-sheet').press('Escape');
  });

  test('CA09 — data futura é barrada no próprio formulário', async ({ page }) => {
    await openReferralsTab(page);
    await openSheet(page);

    // O campo declara o teto; é o que impede a requisição de sair.
    const today = new Date().toISOString().slice(0, 10);
    await expect(page.getByTestId('referral-form-date')).toHaveAttribute('max', today);
  });

  test('CA01 — registrar encaminhamento chega ao prontuário com responsável e autor', async ({
    page,
  }) => {
    await openReferralsTab(page);
    await openSheet(page);
    await chooseCode(page, CODE_FREE);

    await page.getByTestId('referral-form-destination').fill('Unidade Básica de Saúde (E2E)');
    await page.getByTestId('referral-form-objective').fill('Avaliação clínica de rotina (E2E)');

    const created = page.waitForResponse(
      (res) =>
        res.url().includes(`/families/${FAMILY_WORK}/referrals`) &&
        res.request().method() === 'POST',
    );
    await page.getByTestId('referral-form-submit').click();
    const response = await created;
    expect(response.status(), 'POST do encaminhamento').toBe(201);

    createdUuid = (await response.json()).data.uuid as string;
    expect(createdUuid, 'uuid do encaminhamento criado').not.toBe('');

    // A linha chega ao prontuário, com o destino informado…
    await expect(page.getByTestId(`referral-destination-${createdUuid}`)).toHaveText(
      'Unidade Básica de Saúde (E2E)',
    );

    // …e o registro guarda responsável e autor (dupla prova, pela API).
    const listing = await api.get(`/api/client/families/${FAMILY_WORK}/referrals`);
    const row = ((await listing.json()).data as Array<Record<string, unknown>>).find(
      (item) => item.uuid === createdUuid,
    );
    expect(row?.responsible_professional, 'responsável técnico').toBeTruthy();
    expect(row?.created_by, 'autor do registro').toBeTruthy();
  });

  test('CA07 — a emissão do formulário do cidadão entrega um PDF pela tela', async ({
    page,
  }, testInfo) => {
    test.skip(createdUuid === '', 'Depende do encaminhamento criado no CA01.');

    await openReferralsTab(page);
    await page.getByTestId(`referral-expand-${createdUuid}`).click();

    const download = page.waitForEvent('download');
    await page.getByTestId(`referral-emit-form-${createdUuid}`).click();
    const file = await (await download).path();

    expect(file, 'PDF do formulário emitido').toBeTruthy();

    const bytes = await readFile(file!);

    // Controle POSITIVO: é um PDF de verdade, não um erro salvo com extensão.
    expect(bytes.subarray(0, 5).toString('latin1'), 'assinatura do arquivo').toBe('%PDF-');
    expect(bytes.byteLength, 'tamanho do PDF').toBeGreaterThan(10_000);

    // O arquivo vai para o relatório do Playwright como evidência do critério.
    await testInfo.attach('formulario-encaminhamento.pdf', {
      path: file!,
      contentType: 'application/pdf',
    });

    // ⚠️ O QUE ESTE CASO **NÃO** PROVA: que o objetivo registrado no prontuário
    // fica fora do formulário — a metade sensível do CA07. Buscar o texto nos
    // bytes do PDF seria uma asserção VAZIA: o conteúdo vive em streams
    // comprimidos, e nem o texto que comprovadamente está no documento aparece
    // numa busca crua (verificado). A ausência é provada onde o texto ainda é
    // legível, no HTML que origina o PDF:
    // `api/tests/Feature/Referral/ReferralFormPdfTest.php` — "renders the RN08
    // items and NEVER the objective, the uuid nor the internal code".
  });

  test('CA12/CA15 — cancelar mantém a linha marcada e tira a correção', async ({ page }) => {
    test.skip(createdUuid === '', 'Depende do encaminhamento criado no CA01.');

    await openReferralsTab(page);
    await page.getByTestId(`referral-cancel-${createdUuid}`).click();

    await expect(page.getByTestId('cancel-referral-dialog')).toBeVisible();
    await page.getByTestId('cancel-referral-reason').fill('Registro feito por engano (E2E).');

    const cancelled = page.waitForResponse(
      (res) => res.url().includes(`/referrals/${createdUuid}`) && res.request().method() === 'DELETE',
    );
    await page.getByTestId('cancel-referral-confirm').click();
    expect((await cancelled).status(), 'cancelamento').toBe(200);

    // CA12: permanece no prontuário, marcado — não some.
    await expect(page.getByTestId(`referral-row-${createdUuid}`)).toBeVisible();
    await expect(page.getByTestId(`referral-cancelled-badge-${createdUuid}`)).toBeVisible();

    // CA15: cancelado não é editável — a afordância de correção desaparece.
    await expect(page.getByTestId(`referral-correct-${createdUuid}`)).toHaveCount(0);
  });

  test('CA17 — família sem unidade de referência não oferece a ação de registrar', async ({
    page,
  }) => {
    await openReferralsTab(page, FAMILY_NO_UNIT);

    await expect(page.getByTestId('referral-no-unit-hint')).toBeVisible();
    await expect(page.getByTestId('referral-register-action')).toHaveCount(0);
  });

  test('CA13 — a negativa por unidade declara o motivo sem nomear unidade alguma', async ({
    page,
  }) => {
    // Família referenciada em OUTRA unidade: nada é criado aqui, só a leitura
    // da negativa (o spec `family-follow-up` depende de ela seguir inacessível).
    await page.goto(`/app/cadastros/familias/${FAMILY_OTHER_UNIT}`);
    await dismissPlatformUpdates(page);

    const denied = page.getByTestId('family-access-denied');
    await expect(denied).toBeVisible();

    const message = (await denied.innerText()).toLowerCase();
    expect(message).toContain('referenciada');
    expect(message).toContain('master');
    expect(message).not.toContain('creas');
    expect(message).not.toContain('cras');
    expect(message).not.toContain(':unit');
  });
});
