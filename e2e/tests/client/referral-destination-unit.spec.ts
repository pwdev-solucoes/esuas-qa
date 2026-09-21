import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createTenantApiClient } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureFinalEvidence } from '../../helpers/evidence';

/**
 * US-ACOMP-07 (épico HU-PRONT-ACOMP · GLPI #10887) — unidade de destino nos
 * códigos de TRÂNSITO INTERNO do encaminhamento (13/14), no Painel do Tenant
 * (`client/`, guard `client`).
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que o formulário MUDA DE FORMA conforme o código escolhido: no 13 o destino
 * deixa de ser texto livre e vira uma lista fechada de unidades — e a lista só
 * oferece o tipo que o código manda (CA02). O Pest prova que a API recusa uma
 * unidade de tipo errado; o que só o navegador mostra é se a interface chega a
 * oferecê-la, afordância que prometeria o que o sistema recusa.
 *
 * Prova também a redação que o servidor não controla: o aviso de que a unidade
 * de destino passará a enxergar o prontuário aparece ao ESCOLHER, é informativo
 * (`role=status`), NÃO há diálogo de confirmação, e o toast de sucesso repete o
 * aviso (CA04) — os três fatos que a RN05 pede e que nenhuma asserção de API
 * alcança. E que nos 34 códigos externos nada disso muda (CA05).
 *
 * Por fim, as duas afordâncias negativas: com desfecho lançado, a ação "Definir
 * unidade de destino" SOME da linha (CA08), e na correção o destino aparece
 * somente leitura, apontando a ação certa (CA-extra-C).
 *
 * Os CAs restantes da HU são de backend e ficam no Pest
 * (`api/tests/Feature/Api/Client/ReferralDestinationUnitTest.php`): CA03 (destino
 * ≠ origem, que exige duas unidades do mesmo tipo), CA06 (encaminhamento anterior
 * ao ajuste), CA12 (isolamento entre municípios) e CA-extra-B (403 para quem não
 * é autor nem Master).
 *
 * ## Massa (pré-condição)
 *
 * Do `E2EProntuarioSeeder`: a família de trabalho no "E2E CRAS Centro" e o
 * "E2E CREAS" como única unidade do tipo de destino do código 13. Os códigos
 * 13/14 vêm marcados pela migration de dados da US-ACOMP-07. O `beforeAll`
 * apenas CONFERE essas pré-condições pela API e falha dizendo o comando quando
 * faltam — não cria nada.
 *
 * ⚠️ HARNESS: o project `chromium-tenant` já entrega `page` autenticado como o
 * `E2E_CLIENT_OPERADOR_*` (lotado no "E2E CRAS Centro"). Nenhum cenário aqui faz
 * login — as rotas `/auth/*` têm throttle de 6 req/min.
 *
 * ⚠️ ESTADO: encaminhamento não se apaga (o cancelamento marca a linha). Cada
 * execução acrescenta um 13 e um 05 à família, e os cenários seguintes operam
 * sobre o que ESTA execução criou, nunca sobre o histórico — por isso o bloco é
 * `serial` e o uuid do registro criado no CA04 é guardado em memória.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_WORK =
  process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID ?? '00000000-0000-4000-8000-0000000f0001';
const ORIGIN_UNIT_UUID =
  process.env.E2E_CLIENT_UNIT_UUID ?? '00000000-0000-4000-8000-0000000e0001';
const ORIGIN_UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';
const DESTINATION_UNIT_NAME = process.env.E2E_CLIENT_UNIT_NOT_ASSIGNED_NAME ?? 'E2E CREAS';

const configured = Boolean(BASE && FAMILY_WORK);

/**
 * Dossiê de aceite alimentado por ESTE spec (só com `CAPTURE_EVIDENCE=1`).
 * Em minúsculas de propósito: é o nome da pasta que já existe em
 * `e2e/reports/` para a HU — em sistema de arquivos indiferente a maiúsculas,
 * um slug capitalizado cairia na MESMA pasta com outro nome, e o dossiê
 * passaria a ter duas famílias de arquivo para o mesmo critério.
 */
const EVIDENCE_SLUG = 'us-acomp-07-destino-encaminhamento';

const INTERNAL_CODE = '13';
const EXTERNAL_CODE = '05';

const SEED_HINT =
  `A massa da US-ACOMP-07 não está na base: o código ${INTERNAL_CODE} precisa estar marcado como ` +
  `trânsito interno e o município precisa de uma unidade do tipo de destino ("${DESTINATION_UNIT_NAME}"). ` +
  `Rode "php artisan migrate --force" e "php artisan db:seed --class=Database\\Seeders\\E2ESeeder --force" ` +
  `no container da API e repita.`;

let api: APIRequestContext;
/** uuid do encaminhamento criado no CA04 — pré-requisito do CA08 e do CA-extra-C. */
let createdReferralUuid = '';

type Options = {
  data: {
    codes: Array<{ uuid: string; code: string; destination_unit_type_uuid: string | null }>;
    destination_units: Array<{ uuid: string; name: string; type_uuid: string }>;
  };
};

test.beforeAll(async () => {
  if (!configured) return;

  api = await createTenantApiClient();

  // ⚠️ O `social_unit_uuid` não é opcional aqui: os códigos de trânsito interno
  // são restritos pelo TIPO da unidade de ORIGEM, e sem ela o 13 nem aparece na
  // lista de códigos selecionáveis.
  const response = await api.get(
    `/api/client/families/${FAMILY_WORK}/referrals/options?social_unit_uuid=${ORIGIN_UNIT_UUID}`,
  );
  expect(response.status(), 'options de encaminhamento').toBe(200);

  const { data } = (await response.json()) as Options;

  const internal = data.codes.find((item) => item.code === INTERNAL_CODE);
  expect(internal?.destination_unit_type_uuid, SEED_HINT).toBeTruthy();

  const destinations = data.destination_units.map((unit) => unit.name);
  expect(destinations, SEED_HINT).toContain(DESTINATION_UNIT_NAME);
});

test.afterAll(async () => {
  await api?.dispose();
});

/** Abre o prontuário direto na aba de encaminhamentos (a aba segue o `?tab=`). */
async function openReferralsTab(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY_WORK}?tab=encaminhamentos`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId('referral-register-action')).toBeVisible();
}

/** Escolhe uma opção de um Select (shadcn) pelo testid do gatilho. */
async function choose(page: Page, triggerTestId: string, optionName: string | RegExp) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole('option', { name: optionName }).click();
}

/** Abre o formulário de registro já com a origem e o código escolhidos. */
async function openSheetWith(page: Page, codeLabel: RegExp): Promise<void> {
  await page.getByTestId('referral-register-action').click();
  await expect(page.getByTestId('referral-form-sheet')).toBeVisible();

  // ⚠️ ORDEM: o código só é ofertado depois da unidade de origem — os códigos
  // internos são restritos pelo TIPO da origem (13 sai de CRAS).
  await choose(page, 'referral-form-unit', ORIGIN_UNIT_NAME);
  await choose(page, 'referral-form-code', codeLabel);
}

test.describe('US-ACOMP-07 — unidade de destino no encaminhamento de trânsito interno (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL (+ E2E_CLIENT_FAMILY_IN_UNIT_UUID) em e2e/.env.e2e.',
  );

  // O registro do CA04 é pré-requisito do CA08 e do CA-extra-C.
  test.describe.configure({ mode: 'serial' });

  // `locale` não é cosmético: as mensagens 409/422 exibidas na tela vêm do
  // backend, pelo Accept-Language.
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA02 — no código de trânsito interno o destino vira lista, e só do tipo exigido', async ({
    page,
  }) => {
    await openReferralsTab(page);
    await openSheetWith(page, new RegExp(`^${INTERNAL_CODE} —`));

    // O input de texto livre dá lugar ao select de unidade.
    await expect(page.getByTestId('referral-form-destination')).toHaveCount(0);
    await expect(page.getByTestId('referral-form-destination-unit')).toBeVisible();

    await page.getByTestId('referral-form-destination-unit').click();
    const offered = await page.getByRole('option').allInnerTexts();

    expect(offered.map((text) => text.trim())).toEqual([DESTINATION_UNIT_NAME]);
    // A própria origem nunca é ofertada — aqui o filtro de tipo já a exclui.
    expect(offered.join(' ')).not.toContain(ORIGIN_UNIT_NAME);

    await page.keyboard.press('Escape');
    await page.getByTestId('referral-form-sheet').press('Escape');
  });

  test('CA04 — o aviso do efeito no acesso aparece ao escolher, e o toast o repete', async ({
    page,
  }) => {
    await openReferralsTab(page);
    await openSheetWith(page, new RegExp(`^${INTERNAL_CODE} —`));

    // Antes de escolher a unidade não há aviso: ele é consequência da escolha.
    await expect(page.getByTestId('referral-destination-access-notice')).toHaveCount(0);

    await choose(page, 'referral-form-destination-unit', DESTINATION_UNIT_NAME);

    const notice = page.getByTestId('referral-destination-access-notice');
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice).toContainText(
      new RegExp(`${DESTINATION_UNIT_NAME}.*enxergar o prontuário`, 'i'),
    );

    await page
      .getByTestId('referral-form-objective')
      .fill('Avaliacao para eventual acompanhamento (E2E)');

    const created = page.waitForResponse(
      (res) =>
        res.url().includes(`/families/${FAMILY_WORK}/referrals`) &&
        res.request().method() === 'POST',
    );
    await page.getByTestId('referral-form-submit').click();
    const response = await created;
    expect(response.status(), 'POST do encaminhamento').toBe(201);

    createdReferralUuid = (await response.json()).data.uuid as string;
    expect(createdReferralUuid, 'uuid do encaminhamento criado').not.toBe('');

    // RN05: informa, não pede autorização — nenhum diálogo de confirmação.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    const toasts = page.locator('[data-sonner-toast]');
    await expect(toasts.filter({ hasText: /enxergar o prontuário/i })).toBeVisible();

    // O snapshot do nome é escrito pelo SERVIDOR (o formulário não manda texto).
    await expect(page.getByTestId(`referral-destination-${createdReferralUuid}`)).toHaveText(
      DESTINATION_UNIT_NAME,
    );
  });

  test('CA05 — nos códigos externos o destino continua em texto livre, sem aviso', async ({
    page,
  }) => {
    await openReferralsTab(page);
    await openSheetWith(page, new RegExp(`^${EXTERNAL_CODE} —`));

    await expect(page.getByTestId('referral-form-destination')).toBeVisible();
    await expect(page.getByTestId('referral-form-destination-unit')).toHaveCount(0);
    await expect(page.getByTestId('referral-destination-access-notice')).toHaveCount(0);

    await page.getByTestId('referral-form-sheet').press('Escape');
  });

  test('CA08 — com desfecho lançado, a ação de definir a unidade some da linha', async ({
    page,
  }) => {
    test.skip(createdReferralUuid === '', 'Depende do encaminhamento criado no CA04.');

    await openReferralsTab(page);

    // Enquanto está sem desfecho, a ação existe (é o contraste que dá sentido ao caso).
    await expect(
      page.getByTestId(`referral-assign-destination-${createdReferralUuid}`),
    ).toBeVisible();

    await page.getByTestId(`referral-expand-${createdReferralUuid}`).click();

    const outcome = page.waitForResponse(
      (res) => res.url().includes('/outcome') && res.request().method() === 'PATCH',
    );
    await choose(page, `referral-outcome-select-${createdReferralUuid}`, 'Não atendido');
    expect((await outcome).status(), 'PATCH do desfecho').toBe(200);

    await expect(page.getByTestId(`referral-outcome-badge-${createdReferralUuid}`)).toHaveText(
      /não atendido/i,
    );
    await expect(
      page.getByTestId(`referral-assign-destination-${createdReferralUuid}`),
    ).toHaveCount(0);
  });

  // ⚠️ O título começa por `D08` (e não por "CA-extra-C") porque o extrator de
  // evidência só reconhece `CA|RN|D` + DOIS dígitos: "CA-extra-C" viraria um
  // print `sem-criterio`. O critério da spec fica citado no fim do título.
  test('D08 — na correção o destino é somente leitura e aponta a ação certa (CA-extra-C)', async ({
    page,
  }) => {
    test.skip(createdReferralUuid === '', 'Depende do encaminhamento criado no CA04.');

    await openReferralsTab(page);
    await page.getByTestId(`referral-correct-${createdReferralUuid}`).click();
    await expect(page.getByTestId('referral-form-sheet')).toBeVisible();

    await expect(page.getByTestId('referral-form-destination-readonly')).toHaveValue(
      DESTINATION_UNIT_NAME,
    );
    await expect(page.getByTestId('referral-form-destination-readonly-hint')).toContainText(
      /definir unidade de destino/i,
    );

    // D08: a correção não troca a CLASSE do código — nenhum externo é ofertado.
    await page.getByTestId('referral-form-code').click();
    const codes = await page.getByRole('option').allInnerTexts();
    expect(codes.join(' ')).not.toContain(`${EXTERNAL_CODE} —`);
  });
});
