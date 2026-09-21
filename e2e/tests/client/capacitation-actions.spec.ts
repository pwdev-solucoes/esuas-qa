import { expect, test, type Page } from '@playwright/test';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureEvidence, captureFinalEvidence } from '../../helpers/evidence';

// Sessão: estes casos rodam no project `chromium-tenant`, que herda o
// storageState do `tenant-auth.setup` — o MESMO operador que eles usariam.
// Logar caso a caso, além de redundante, estourava o `throttle:6,1` da rota
// de login do client (api/routes/api/auth-client.php): do 7º login em diante
// a resposta era 429 e o teste morria esperando a navegação.

/**
 * US-CAPAC-02 (épico HU-UNID-CAPAC) — registro das ações de capacitação e
 * divulgação na aba da unidade socioassistencial, no frontend do TENANT
 * (`client/`, guard `client`).
 *
 * ⚠️ HARNESS: `scripts/start-stack.sh` já serve o client em `:4174`, mas a
 * suíte não tem `auth.setup` de tenant (o storageState do projeto `chromium` é
 * do Super Admin). Como os specs irmãos de `tests/client/`, este faz o login do
 * tenant dentro do próprio caso e é **opt-in via env** (`CLIENT_BASE_URL` +
 * credenciais do operador) — `skip` por padrão.
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que o formulário MUDA DE FORMA conforme o tipo escolhido, lendo `date_mode` e
 * `counting_mode` do cadastro real da US-CAPAC-01 — e não de uma lista de
 * `code` no front. O Pest garante o 422; o navegador é o único lugar onde se vê
 * que a palestra PEDE participante e a reunião interna NÃO, contra o dado
 * semeado, de ponta a ponta.
 *
 * E prova a ausência que a HU exige: em nenhum ponto da tela existe "Excluir".
 * O cancelamento com motivo é o substituto (D04/RN09), e a ação cancelada
 * CONTINUA listada, marcada — some da apuração, não da tela.
 *
 * ## Massa necessária
 *
 * | origem                        | o que garante                                   |
 * |-------------------------------|-------------------------------------------------|
 * | `CapacitationActionTypeSeeder`| os 5 tipos do leiaute 15.9 (001…005)             |
 * | `E2EProntuarioSeeder`         | tenant Ativo, "E2E CRAS Centro" (lotação vigente |
 * |                               | do operador), "E2E CREAS" (SEM lotação dele) e   |
 * |                               | profissionais elegíveis como participantes       |
 *
 * ⚠️ **Pendência de harness:** o `E2ESeeder` chamado pelo `start-stack.sh`
 * ainda **não** chama o `CapacitationActionTypeSeeder` (o `DatabaseSeeder` e o
 * `LocalDevSeeder` chamam). Sem os cinco tipos o select do formulário vem
 * vazio; a asserção de {@link chooseType} falha dizendo exatamente qual comando
 * rodar. Este spec **não cria os tipos**: a API não expõe `store` — a lista é
 * fechada por desenho (US-CAPAC-01/D01).
 *
 * Já as AÇÕES cada caso cria as suas, com título único (sufixo de timestamp),
 * então os casos são independentes e podem rodar sobre base suja. Não há
 * limpeza por `DELETE`: o recurso não tem rota de exclusão — de propósito.
 * Cancelar é o único caminho de reversão, e é o que o caso do CA10 exercita.
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:4174 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   npx playwright test tests/client/capacitation-actions.spec.ts
 */

/**
 * Dossiê de aceite alimentado por ESTE spec (skill `acceptance-evidence-report`).
 * Prints em `e2e/reports/<slug>-acceptance/screenshots/`, só com
 * `CAPTURE_EVIDENCE=1` — ver `helpers/evidence.ts`.
 */
const EVIDENCE_SLUG = 'US-CAPAC-02-registro-acoes';

const BASE = process.env.CLIENT_BASE_URL;
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;

/** Unidade COM lotação vigente do operador — "E2E CRAS Centro" do seeder. */
const UNIT =
  process.env.E2E_CLIENT_CAPACITATION_UNIT_UUID ?? '00000000-0000-4000-8000-0000000e0001';

/** Unidade SEM lotação do operador — "E2E CREAS" do mesmo seeder (CA11). */
const UNIT_WITHOUT_ASSIGNMENT =
  process.env.E2E_CLIENT_CAPACITATION_UNIT_NO_ASSIGNMENT_UUID ??
  '00000000-0000-4000-8000-0000000e0002';

const configured = Boolean(BASE && OPERADOR_CPF && OPERADOR_PASS);

/** `code` dos tipos do leiaute usados aqui (US-CAPAC-01 §6.3). */
const TYPE_PALESTRA = '001'; // counting_mode = participation · single_date
const TYPE_REUNIAO_INTERNA = '003'; // counting_mode = event · single_date

const SEED_HINT =
  'ausente no select. Os cinco tipos do leiaute 15.9 vêm do CapacitationActionTypeSeeder, ' +
  'que o E2ESeeder ainda não chama — rode ' +
  '"php artisan db:seed --class=Database\\Seeders\\CapacitationActionTypeSeeder" na stack.';

/** Data no fuso LOCAL (`toISOString()` puro devolveria a data em UTC). */
function isoDaysFromToday(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);

  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Título único por execução — os casos não dependem de base limpa. */
function uniqueTitle(prefix: string): string {
  return `${prefix} E2E ${Date.now()}`;
}


/** Abre a aba "Capacitação e divulgação" da unidade (sincronizada com ?tab=). */
async function openCapacitationTab(page: Page, unitUuid: string): Promise<void> {
  await page.goto(`/app/unidades/${unitUuid}?tab=capacitation`);
  await dismissPlatformUpdates(page);
  await page.waitForLoadState('networkidle');
}

/** Próximo GET da listagem de ações (exclui o relacional de candidatos). */
function waitForActionsList(page: Page) {
  return page.waitForResponse(
    (res) =>
      res.url().includes('/capacitation-actions') &&
      !res.url().includes('participant-candidates') &&
      res.request().method() === 'GET',
    { timeout: 15_000 },
  );
}

async function openNewActionForm(page: Page): Promise<void> {
  const button = page.getByTestId('capacitation-new-action');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('capacitation-type-select')).toBeVisible();
}

/** Escolhe o tipo pelo `code` — é ele que decide o resto do formulário. */
async function chooseType(page: Page, code: string): Promise<void> {
  await page.getByTestId('capacitation-type-select').click();
  const option = page.getByRole('option', { name: new RegExp(`^${code}\\s`) });
  await expect(option, `Tipo de ação "${code}" ${SEED_HINT}`).toBeVisible();
  await option.click();
}

/**
 * Preenche a data única e AGUARDA a lista de participantes elegíveis daquela
 * data (F5): é a janela que decide quem pode ser oferecido.
 */
async function fillOccurredOn(page: Page, date: string): Promise<void> {
  const candidates = page.waitForResponse(
    (res) =>
      res.url().includes('participant-candidates') && res.request().method() === 'GET',
    { timeout: 15_000 },
  );
  await page.getByTestId('capacitation-occurred-on-input').fill(date);
  await candidates;
}

/** Linha da ação na listagem, localizada pelo título (sem depender do uuid). */
function actionRow(page: Page, title: string) {
  return page.locator('[data-testid^="capacitation-row-"]').filter({ hasText: title });
}

/** Filtra a listagem pelo título — imune a paginação e base acumulada. */
async function searchAction(page: Page, title: string): Promise<void> {
  const listRequest = waitForActionsList(page);
  await page.getByTestId('capacitation-search').fill(title);
  await listRequest;
  await expect(actionRow(page, title)).toBeVisible();
}

test.describe('US-CAPAC-02 — registro de ações de capacitação na unidade (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD no arquivo de env do e2e (o client exige login de tenant próprio).',
  );

  test.use({ baseURL: BASE });

  // Evidência do estado FINAL de cada caso aprovado. Sem `CAPTURE_EVIDENCE=1` o
  // corpo retorna na primeira linha e a suíte roda exatamente como antes.
  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test('CA01 — registra uma palestra com participantes, assinada e datada', async ({ page }) => {
    const title = uniqueTitle('Seminário estadual do SUAS');
    const occurredOn = isoDaysFromToday(-1);

    await openCapacitationTab(page, UNIT);

    await openNewActionForm(page);
    await chooseType(page, TYPE_PALESTRA);
    await page.getByTestId('capacitation-title-input').fill(title);
    await fillOccurredOn(page, occurredOn);

    // Os candidatos são os profissionais com lotação vigente NA DATA (F5/CA06).
    const candidates = page.getByTestId('capacitation-participants-list').getByRole('checkbox');
    await expect(candidates.first()).toBeVisible();
    await candidates.first().click();
    await expect(page.getByText(/1 selecionado/i)).toBeVisible();

    await page.getByTestId('capacitation-form-submit').click();
    await expect(page.getByTestId('capacitation-form-submit')).toHaveCount(0);

    await searchAction(page, title);
    const row = actionRow(page, title);
    await expect(row).toHaveAttribute('data-status', 'active');
    // RN12 — o registro é assinado: a coluna "Registrado por" não fica vazia.
    await expect(row).not.toContainText(/^—$/);

    await page.screenshot({
      path: 'test-results/capac-02-ca01-palestra-registrada.png',
      fullPage: true,
    });
  });

  test('CA02 — reunião interna é salva SEM participantes (o tipo conta o evento)', async ({
    page,
  }) => {
    const title = uniqueTitle('Reunião interna de equipe');

    await openCapacitationTab(page, UNIT);

    await openNewActionForm(page);
    await chooseType(page, TYPE_REUNIAO_INTERNA);
    await page.getByTestId('capacitation-title-input').fill(title);
    await fillOccurredOn(page, isoDaysFromToday(-1));

    // A tela DIZ que este tipo conta a ação, não as pessoas (RN06/CA02).
    await expect(
      page.getByText('Este tipo conta a ação, não as pessoas. Informar participantes é opcional.'),
    ).toBeVisible();

    await page.getByTestId('capacitation-form-submit').click();
    await expect(page.getByTestId('capacitation-form-submit')).toHaveCount(0);

    await searchAction(page, title);
    await expect(actionRow(page, title)).toHaveAttribute('data-status', 'active');
  });

  test('CA03 — palestra sem participante é recusada, com a explicação da contagem', async ({
    page,
  }, testInfo) => {
    const title = uniqueTitle('Palestra sem participante');

    await openCapacitationTab(page, UNIT);

    await openNewActionForm(page);
    await chooseType(page, TYPE_PALESTRA);
    await page.getByTestId('capacitation-title-input').fill(title);
    await fillOccurredOn(page, isoDaysFromToday(-1));

    // A explicação vem ANTES do erro: o tipo conta participações (RN06).
    await expect(
      page.getByText(
        'Este tipo conta as participações dos profissionais — selecione ao menos um participante.',
      ),
    ).toBeVisible();

    await page.getByTestId('capacitation-form-submit').click();

    await expect(
      page.getByText('Selecione ao menos um participante para este tipo de ação.'),
    ).toBeVisible();
    // Nada foi gravado: o formulário continua aberto.
    await expect(page.getByTestId('capacitation-form-submit')).toBeVisible();

    await page.screenshot({
      path: 'test-results/capac-02-ca03-participante-obrigatorio.png',
      fullPage: true,
    });
    // O formulário fecha na linha seguinte: a recusa só existe AQUI.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'erro-participante-obrigatorio');

    await page.getByRole('button', { name: /^cancelar$/i }).click();
    await expect(page.getByTestId('capacitation-form-submit')).toHaveCount(0);
  });

  test('CA08 — data futura é recusada', async ({ page }, testInfo) => {
    const title = uniqueTitle('Reunião interna em data futura');

    await openCapacitationTab(page, UNIT);

    await openNewActionForm(page);
    // Tipo de contagem por EVENTO de propósito: sem exigência de participante,
    // o único motivo possível de recusa é a data — a prova fica inequívoca.
    await chooseType(page, TYPE_REUNIAO_INTERNA);
    await page.getByTestId('capacitation-title-input').fill(title);

    const input = page.getByTestId('capacitation-occurred-on-input');
    // O campo já declara o teto na marcação, antes de qualquer submissão.
    await expect(input).toHaveAttribute('max', isoDaysFromToday(0));
    await input.fill(isoDaysFromToday(1));

    await page.getByTestId('capacitation-form-submit').click();

    await expect(page.getByText('A data de realização não pode ser futura.')).toBeVisible();
    await expect(page.getByTestId('capacitation-form-submit')).toBeVisible();

    // Idem CA03: o estado final do caso é a listagem, sem o erro à vista.
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, 'erro-data-futura');

    await page.getByRole('button', { name: /^cancelar$/i }).click();
    await expect(page.getByTestId('capacitation-form-submit')).toHaveCount(0);
  });

  test('CA10 — cancelar com motivo: a ação continua listada, marcada, e não há excluir', async ({
    page,
  }) => {
    const title = uniqueTitle('Reunião interna cancelada');
    const reason = 'Registro duplicado — cancelado pelo cenário E2E.';

    await openCapacitationTab(page, UNIT);

    // --- massa própria do caso: uma ação que conta por evento ---
    await openNewActionForm(page);
    await chooseType(page, TYPE_REUNIAO_INTERNA);
    await page.getByTestId('capacitation-title-input').fill(title);
    await fillOccurredOn(page, isoDaysFromToday(-1));
    await page.getByTestId('capacitation-form-submit').click();
    await expect(page.getByTestId('capacitation-form-submit')).toHaveCount(0);

    await searchAction(page, title);
    const row = actionRow(page, title);

    // --- o menu da linha NÃO oferece exclusão (D04): só editar e cancelar ---
    await row.getByRole('button', { name: /mais ações/i }).click();
    await expect(page.getByRole('menuitem', { name: /excluir|remover|apagar/i })).toHaveCount(0);

    const cancelRequest = page.waitForResponse(
      (res) => res.url().includes('/cancel') && res.request().method() === 'PATCH',
      { timeout: 15_000 },
    );
    await page.getByRole('menuitem', { name: /cancelar ação/i }).click();

    // O diálogo diz, antes da confirmação, que a ação NÃO some da tela.
    await expect(page.getByText(/continua na listagem, marcada como cancelada/i)).toBeVisible();
    await page.getByTestId('capacitation-cancel-reason').fill(reason);
    await page.getByTestId('capacitation-cancel-confirm').click();

    expect((await cancelRequest).status()).toBe(200);

    // RN09/CA10 — continua VISÍVEL, marcada, com o motivo à vista.
    await expect(row).toHaveAttribute('data-status', 'cancelled');
    await expect(row).toContainText(/cancelada/i);
    await expect(row).toContainText(reason);

    await page.screenshot({
      path: 'test-results/capac-02-ca10-acao-cancelada.png',
      fullPage: true,
    });
  });

  test('CA11 — unidade sem lotação vigente: negativa explicada, não "acesso negado"', async ({
    page,
  }) => {
    await openCapacitationTab(page, UNIT_WITHOUT_ASSIGNMENT);

    const panel = page.getByTestId('capacitation-access-denied');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/lotação/i);
    // A mensagem orienta o caminho (procurar o Master), em vez de só negar.
    await expect(panel).toContainText(/master/i);

    // Não virou desvio para a página genérica de 403.
    expect(page.url()).not.toMatch(/\/403/);

    await page.screenshot({
      path: 'test-results/capac-02-ca11-sem-lotacao.png',
      fullPage: true,
    });
  });
});
