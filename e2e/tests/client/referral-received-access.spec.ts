import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { loginAsTenantUser } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureFinalEvidence } from '../../helpers/evidence';

/**
 * US-ACOMP-06 (épico HU-PRONT-ACOMP · GLPI #10888) — acesso ao prontuário pela
 * unidade que RECEBEU o encaminhamento, no Painel do Tenant (`client/`).
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que o prontuário ABRE e FECHA na tela conforme o encaminhamento, para um
 * profissional que não tem lotação na unidade de referência da família. O Pest
 * assevera o predicado e o `activity_log`; o que só o navegador mostra é que a
 * família deixa de ser um 403 genérico e passa a renderizar o prontuário
 * inteiro — e que, quando o acesso cessa, a negativa que o usuário lê declara
 * os três eixos SEM nomear unidade alguma (LGPD: a mensagem não pode revelar
 * onde a família é atendida a quem não tem acesso a ela).
 *
 * Fecha, também, a metade que o dossiê da US-ACOMP-07 (#10887) declarou
 * "pendente por design" no CA07: lá o `PATCH …/destination-unit` gravava a
 * unidade; aqui se vê o efeito prometido — a unidade de destino passa a
 * enxergar o prontuário.
 *
 * ## Triagem dos CAs (skill `e2e-testing`)
 *
 * Navegador (aqui): CA01, CA03, CA02, CA05, CA04/CA11.
 * Pest (`api/tests/Feature/Client/FamilyAccessReferralAxisTest.php`, 60 casos):
 * CA06 (FK nula), CA07 (cancelado), CA08 (outro CREAS), CA09 (add-on), CA10
 * (lotação encerrada), CA12 (as cinco vias na auditoria), CA13 e CA-extra-B
 * (isolamento entre municípios), CA-extra-A (pesquisa de pessoas), CA-extra-C
 * (reversão do desfecho) e CA-extra-D (domínio fechado, teste unitário).
 *
 * ## Massa (pré-condição) — direção INVERTIDA de propósito
 *
 * A narrativa da spec é CRAS → CREAS, mas a massa E2E **não tem ninguém lotado
 * no "E2E CREAS"**. O `E2EProntuarioSeeder` semeia, por isso, o inverso: a
 * família dedicada `…0f0014` é referenciada no **CREAS** e o encaminhamento
 * `…0e7002` é o código **14 (CREAS → CRAS)**, com destino no "E2E CRAS Centro"
 * — onde o operador do harness TEM lotação vigente. O eixo provado é o mesmo;
 * só o sentido do trânsito muda. O Pest cobre a direção literal da spec.
 *
 * ⚠️ HARNESS: **o login do Master derruba a sessão do operador** — fato já
 * registrado no `family-follow-up.spec.ts` ("os logins do Master, nos blocos
 * finais, a derrubam"). Como este spec PRECISA do Master (só ele cancela
 * acompanhamento de unidade onde não tem lotação e reabre o encaminhamento),
 * a `page` herdada do project `chromium-tenant` seria inútil: toda navegação
 * cairia na tela de login. Por isso o bloco monta a própria página e autentica
 * o operador **depois** da higiene do Master — o mesmo arranjo do bloco
 * US-ACOMP-04 daquele arquivo. São 2 logins por execução, dentro do throttle
 * de 6 req/min.
 *
 * ⚠️ RODANDO CONTRA A STACK DE DEV: passe
 * `E2E_CACHE_CLEAR_CMD="docker exec api-laravel.test-1 php artisan cache:clear"`,
 * senão o `globalSetup` tenta zerar o rate-limiter na stack E2E (offline) e o
 * segundo login da execução recebe 429.
 *
 * ⚠️ ESTADO: o acesso é vivo e o estado é persistente. O `beforeAll` devolve a
 * família ao ponto de partida (acompanhamento cancelado + encaminhamento
 * reaberto) e o `afterAll` a deixa inacessível de novo, para a próxima execução
 * partir do mesmo lugar por qualquer caminho.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';

/** Família referenciada no CREAS e encaminhada ao CRAS Centro (massa dedicada). */
const FAMILY_RECEIVED =
  process.env.E2E_CLIENT_FAMILY_RECEIVED_REFERRAL_UUID ??
  '00000000-0000-4000-8000-0000000f0014';
/** Encaminhamento "14" (CREAS → CRAS Centro), sem desfecho. */
const REFERRAL_RECEIVED =
  process.env.E2E_CLIENT_REFERRAL_RECEIVED_UUID ??
  '00000000-0000-4000-8000-0000000e7002';

const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? '52998224725';
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? 'senha123';
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF ?? '11144477735';
const OPERADOR_PASSWORD = process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? 'senha123';

/** Unidade de DESTINO do encaminhamento — a lotação do operador do harness. */
const DESTINATION_UNIT_NAME = process.env.E2E_CLIENT_UNIT_NAME ?? 'E2E CRAS Centro';

const configured = Boolean(BASE && FAMILY_RECEIVED && REFERRAL_RECEIVED);

/** Dossiê da HU (minúsculas: é o nome da pasta em `e2e/reports/`). */
const EVIDENCE_SLUG = 'us-acomp-06-acesso-encaminhamento';

const SEED_HINT =
  `A massa da US-ACOMP-06 não está no estado esperado: a família ${FAMILY_RECEIVED} precisa ter o ` +
  `encaminhamento ${REFERRAL_RECEIVED} (código 14, destino "${DESTINATION_UNIT_NAME}") em ` +
  `registered/awaiting_return. Rode "php artisan migrate --force" e ` +
  `"php artisan db:seed --class=Database\\Seeders\\E2ESeeder --force" no container da API e repita.`;

let masterApi: APIRequestContext;
let masterXsrf = '';
/** Página do OPERADOR, autenticada depois da higiene do Master (ver ⚠️ HARNESS). */
let operatorPage: Page;

/** Sessão de API do Master em contexto PRÓPRIO (molde do bloco US-ACOMP-04). */
async function openMasterSession(): Promise<{ api: APIRequestContext; xsrf: string }> {
  const api = await playwrightRequest.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: {
      Accept: 'application/json',
      Origin: BASE!,
      Referer: `${BASE}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Tenant-UUID': TENANT_UUID,
    },
  });

  await api.get('/sanctum/csrf-cookie');
  const readXsrf = async (): Promise<string> =>
    decodeURIComponent(
      (await api.storageState()).cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value ?? '',
    );

  const login = await api.post('/api/client/auth/login', {
    headers: { 'X-XSRF-TOKEN': await readXsrf() },
    data: { cpf: MASTER_CPF, password: MASTER_PASSWORD, tenant_uuid: TENANT_UUID },
  });
  expect(login.status(), 'login do Master via API').toBe(200);

  return { api, xsrf: await readXsrf() };
}

/** Cancela, pelo Master, todo acompanhamento vigente da família de trabalho. */
async function cancelActiveFollowUps(): Promise<void> {
  const listing = await masterApi.get(`/api/client/families/${FAMILY_RECEIVED}/follow-ups`);
  expect(listing.status(), 'listagem de acompanhamentos').toBe(200);

  const rows = ((await listing.json()).data ?? []) as Array<{ uuid: string; status: string }>;

  for (const row of rows.filter((item) => item.status === 'active')) {
    const cancelled = await masterApi.delete(
      `/api/client/families/${FAMILY_RECEIVED}/follow-ups/${row.uuid}`,
      {
        headers: { 'X-XSRF-TOKEN': masterXsrf },
        data: { cancel_reason: 'Higiene do spec E2E da US-ACOMP-06.' },
      },
    );
    expect([200, 409], 'cancelamento do acompanhamento').toContain(cancelled.status());
  }
}

/** Lê o encaminhamento da massa (status + desfecho). */
async function readReferral(): Promise<{ status: string; outcome: string }> {
  const listing = await masterApi.get(`/api/client/families/${FAMILY_RECEIVED}/referrals`);
  expect(listing.status(), 'listagem de encaminhamentos').toBe(200);

  const rows = ((await listing.json()).data ?? []) as Array<{
    uuid: string;
    status: string;
    outcome: string;
  }>;
  const referral = rows.find((row) => row.uuid === REFERRAL_RECEIVED);
  expect(referral, SEED_HINT).toBeTruthy();

  return { status: referral!.status, outcome: referral!.outcome };
}

/** Devolve o encaminhamento a "aguardando retorno" — só quando preciso (D07). */
async function reopenReferral(): Promise<void> {
  const { status, outcome } = await readReferral();

  // Cancelado não volta por API: só o seeder restaura.
  expect(status, SEED_HINT).not.toBe('cancelled');

  if (outcome === 'awaiting_return') return;

  const reopened = await masterApi.patch(
    `/api/client/families/${FAMILY_RECEIVED}/referrals/${REFERRAL_RECEIVED}/outcome`,
    {
      headers: { 'X-XSRF-TOKEN': masterXsrf },
      data: { outcome: 'awaiting_return' },
    },
  );
  expect(reopened.status(), 'reabertura do encaminhamento (D07)').toBe(200);
}

async function openRecord(tab?: string): Promise<void> {
  const suffix = tab === undefined ? '' : `?tab=${tab}`;
  await operatorPage.goto(`/app/cadastros/familias/${FAMILY_RECEIVED}${suffix}`);
  await dismissPlatformUpdates(operatorPage);
}

test.beforeAll(async ({ browser }) => {
  if (!configured) return;

  const session = await openMasterSession();
  masterApi = session.api;
  masterXsrf = session.xsrf;

  // Ponto de partida: sem acompanhamento e com o encaminhamento aberto — é o
  // único estado em que o eixo desta HU é o que concede.
  await cancelActiveFollowUps();
  await reopenReferral();

  // SÓ AGORA o operador entra: o login do Master acima derrubou a sessão
  // herdada do project, e uma página criada antes disto veria a tela de login.
  operatorPage = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
  await loginAsTenantUser(operatorPage, OPERADOR_CPF, OPERADOR_PASSWORD, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(operatorPage);
});

test.afterAll(async () => {
  await operatorPage?.close();
  await masterApi?.dispose();
});

test.describe('US-ACOMP-06 — acesso ao prontuário pela unidade que recebeu o encaminhamento (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL (+ E2E_TENANT_UUID e as credenciais do tenant) em e2e/.env.e2e.',
  );

  // O estado é acumulativo: o ingresso do CA02 é pré-requisito do CA05, e o
  // CA04/CA11 só pode ser medido depois que os dois eixos fecham.
  test.describe.configure({ mode: 'serial' });

  // `locale` não é cosmético: a negativa que a tela exibe vem do BACKEND.
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.afterEach(async ({}, testInfo) => {
    await captureFinalEvidence(operatorPage, testInfo, EVIDENCE_SLUG);
  });

  test('CA01 — a unidade de destino abre o prontuário da família referenciada em outra unidade', async () => {
    await openRecord();

    await expect(operatorPage.getByRole('heading', { name: /visualizar família/i })).toBeVisible();
    await expect(operatorPage.getByTestId('family-access-denied')).toHaveCount(0);
    await expect(operatorPage.getByTestId('family-not-found')).toHaveCount(0);
    await expect(operatorPage.getByTestId('family-no-active-assignment')).toHaveCount(0);
  });

  test('CA03 — o acesso é ao prontuário INTEIRO, incluindo o que a unidade de origem registrou', async () => {
    await openRecord('composicao');
    await expect(operatorPage.getByTestId('family-access-denied')).toHaveCount(0);

    await openRecord('encaminhamentos');
    // O encaminhamento foi registrado pela ORIGEM (CREAS) e é visível aqui.
    await expect(operatorPage.getByTestId(`referral-destination-${REFERRAL_RECEIVED}`)).toHaveText(
      DESTINATION_UNIT_NAME,
    );
    await expect(operatorPage.getByTestId(`referral-outcome-badge-${REFERRAL_RECEIVED}`)).toHaveText(
      /aguardando retorno/i,
    );
  });

  test('CA02 — o ingresso no acompanhamento passa a ser possível SEM o Master', async () => {
    await openRecord('acompanhamento');

    await operatorPage.getByTestId('follow-up-register-action').click();
    await expect(operatorPage.getByTestId('follow-up-form-sheet')).toBeVisible();

    await operatorPage.getByTestId('follow-up-form-unit').click();
    await operatorPage.getByRole('option', { name: DESTINATION_UNIT_NAME }).click();

    await operatorPage.getByTestId('follow-up-form-service').click();
    await operatorPage.getByRole('option', { name: /PAIF/ }).first().click();

    const created = operatorPage.waitForResponse(
      (res) => res.url().includes('/follow-ups') && res.request().method() === 'POST',
    );
    await operatorPage.getByTestId('follow-up-form-submit').click();
    expect((await created).status(), 'POST do ingresso').toBe(201);

    await expect(operatorPage.getByTestId('follow-up-active')).toContainText(DESTINATION_UNIT_NAME);
  });

  test('CA05 — quem assumiu o caso continua acessando depois do desfecho', async () => {
    await openRecord('encaminhamentos');

    await operatorPage.getByTestId(`referral-expand-${REFERRAL_RECEIVED}`).click();

    const outcome = operatorPage.waitForResponse(
      (res) => res.url().includes('/outcome') && res.request().method() === 'PATCH',
    );
    await operatorPage.getByTestId(`referral-outcome-select-${REFERRAL_RECEIVED}`).click();
    // `exact` é obrigatório: sem ele, "Atendido" casa também com "Não atendido".
    await operatorPage.getByRole('option', { name: 'Atendido', exact: true }).click();
    expect((await outcome).status(), 'PATCH do desfecho').toBe(200);

    // O eixo do encaminhamento fechou; o acompanhamento do CA02 sustenta o acesso.
    await openRecord();
    await expect(operatorPage.getByRole('heading', { name: /visualizar família/i })).toBeVisible();
    await expect(operatorPage.getByTestId('family-access-denied')).toHaveCount(0);
  });

  test('CA04/CA11 — sem acompanhamento e com o desfecho lançado, a negativa declara os três eixos sem nomear unidade', async () => {
    // O Master fecha o último eixo aberto — o acompanhamento do CA02.
    await cancelActiveFollowUps();
    expect((await readReferral()).outcome, 'desfecho lançado no CA05').not.toBe('awaiting_return');

    await openRecord();

    const denied = operatorPage.getByTestId('family-access-denied');
    await expect(denied).toBeVisible();

    const message = (await denied.innerText()).toLowerCase();
    expect(message).toContain('referenciada');
    expect(message).toContain('acompanhada');
    expect(message).toContain('encaminhada');
    expect(message).toContain('master');

    // LGPD: a negativa não revela ONDE a família é atendida.
    expect(message).not.toContain('creas');
    expect(message).not.toContain('cras');
    expect(message).not.toContain(':unit');
  });
});
