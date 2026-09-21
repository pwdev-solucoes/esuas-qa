import { expect, test, type Page } from '@playwright/test';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { captureFinalEvidence } from '../../helpers/evidence';

// Sessão: estes casos rodam no project `chromium-tenant`, que herda o
// storageState do `tenant-auth.setup` — o MESMO operador que eles usariam.
// Logar caso a caso, além de redundante, estourava o `throttle:6,1` da rota
// de login do client (api/routes/api/auth-client.php): do 7º login em diante
// a resposta era 429 e o teste morria esperando a navegação.

/**
 * US-CAPAC-03 (épico HU-UNID-CAPAC) — APURAÇÃO das ações de capacitação e
 * divulgação: os cinco números do leiaute 15.9 do SIAP, por unidade e mês, no
 * frontend do TENANT (`client/`, guard `client`).
 *
 * ⚠️ A apuração NÃO é uma aba da unidade (como a spec técnica chegou a supor):
 * virou **página própria**, em `/app/prestacao-contas/capacitacao`
 * (`client/src/router/index.ts` → `ApuracaoCapacitacaoPage.vue` →
 * `CapacitationTallyView.vue`). Faz sentido: a consulta padrão é do MUNICÍPIO
 * inteiro e a unidade é filtro opcional — o inverso da US-CAPAC-02, onde a
 * unidade é dona do registro e vem do segmento de rota.
 *
 * ⚠️ HARNESS: `scripts/start-stack.sh` serve o client em `:4174`, mas a suíte
 * não tem `auth.setup` de tenant (o storageState do projeto `chromium` é do
 * Super Admin). Como os specs irmãos de `tests/client/`, este faz o login do
 * tenant dentro do próprio caso e é **opt-in via env** (`CLIENT_BASE_URL` +
 * credenciais do operador) — `skip` por padrão.
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que o número CHEGA À TELA acompanhado do que ele significa. O Pest já prova a
 * aritmética das três formas de contagem; o que só o navegador mostra é se a
 * coluna de reuniões internas exibe "Conta eventos" ao lado do "2" — sem isso,
 * "2" na coluna de palestras (duas pessoas) e "2" na de reuniões internas (duas
 * reuniões) são indistinguíveis, e a conferência antes da remessa vira palpite.
 *
 * E prova a AUSÊNCIA que a HU exige (D09/RN03): em lugar nenhum da tela há
 * campo digitável ou botão de salvar, e nenhuma requisição de escrita parte
 * dela. Número digitado é número sem rastro — a única forma de mudar um
 * contador é corrigir o registro que o originou (o que o caso do CA07 exercita,
 * cancelando).
 *
 * ## Massa
 *
 * | origem                         | o que garante                                |
 * |--------------------------------|----------------------------------------------|
 * | `CapacitationActionTypeSeeder` | os 5 tipos do leiaute 15.9 (001…005)          |
 * | `E2EProntuarioSeeder`          | tenant Ativo, operador com lotação vigente em |
 * |                                | "E2E CRAS Centro" **e** "E2E CRAS Sem MDS"    |
 *
 * ⚠️ **Pendência de harness (a mesma dos dois specs irmãos):** o `E2ESeeder`
 * chamado pelo `start-stack.sh` **não** chama o `CapacitationActionTypeSeeder`.
 * Sem os cinco tipos não há coluna nenhuma para apurar; cada caso fica `skip`
 * com o comando exato, em vez de vermelho por falta de cadastro.
 *
 * As DUAS unidades do operador são o cenário inteiro: o CRAS Centro recebe a
 * massa de cada caso e o CRAS Sem MDS não recebe nada nunca — é ele o "ponto de
 * atenção" do CA09, sem precisar de usuário Master.
 *
 * ## Independência e idempotência
 *
 * As ações são criadas pela API do tenant (mesmo molde de `fixtures/api-client.ts`:
 * cookie de sessão do contexto do browser + `X-XSRF-TOKEN` + `X-Tenant-UUID`),
 * com título de sufixo único, e **canceladas no `afterEach`** — ação cancelada
 * não entra na apuração (`CapacitationTallyService::baseQuery`), então a base
 * volta ao estado anterior sem `DELETE`, que o recurso não tem por desenho
 * (D04). Além disso, toda asserção de valor é feita sobre um BASELINE lido da
 * própria API antes da massa: a suíte não exige base limpa e não colide com o
 * spec de `capacitation-actions.spec.ts`, que também escreve no CRAS Centro.
 *
 * Sem PII: a apuração devolve quantidade, e daqui só trafegam `uuid` de
 * profissional — nunca nome nem CPF.
 *
 * Rodar localmente:
 *   CLIENT_BASE_URL=http://localhost:4174 E2E_API_BASE_URL=http://localhost:8090 \
 *   E2E_CLIENT_OPERADOR_CPF=... E2E_CLIENT_OPERADOR_PASSWORD=... \
 *   npx playwright test tests/client/capacitation-tallies.spec.ts
 */

/**
 * Dossiê de aceite alimentado por ESTE spec (skill `acceptance-evidence-report`).
 * Prints em `e2e/reports/<slug>-acceptance/screenshots/`, só com
 * `CAPTURE_EVIDENCE=1` — ver `helpers/evidence.ts`.
 */
const EVIDENCE_SLUG = 'US-CAPAC-03-apuracao-acoes';

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF;
const OPERADOR_PASS = process.env.E2E_CLIENT_OPERADOR_PASSWORD;

/** Unidade COM lotação vigente do operador — "E2E CRAS Centro" do seeder. */
const UNIT =
  process.env.E2E_CLIENT_CAPACITATION_UNIT_UUID ?? '00000000-0000-4000-8000-0000000e0001';

/**
 * Segunda unidade do operador — "E2E CRAS Sem MDS". Está na lotação dele (logo,
 * aparece na apuração) e nenhum spec registra ação nela: é a unidade sem
 * registro do CA09.
 */
const UNIT_WITHOUT_RECORDS =
  process.env.E2E_CLIENT_CAPACITATION_UNIT_EMPTY_UUID ?? '00000000-0000-4000-8000-0000000e0003';

/** Fallback do tenant E2E, caso o `app-tenant` não esteja no localStorage. */
const TENANT_UUID_FALLBACK =
  process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';

const configured = Boolean(BASE && OPERADOR_CPF && OPERADOR_PASS);

/** `code` dos tipos do leiaute (US-CAPAC-01 §6.3). */
const TYPE_PALESTRA = '001'; // participation · single_date · QuantidadePalestras
const TYPE_REUNIAO_INTERNA = '003'; // event         · single_date · QuantidadeReunioesInternas
const TYPE_DIVULGACAO = '004'; // participation · single_date · QuantidadeEventos
// O tipo '002' (QuantidadeReunioes) e o '005' (QuantidadeCursos) NÃO recebem
// massa de propósito: os dois contadores em delta 0 provam que a apuração não
// mistura os campos do leiaute.

/**
 * As cinco colunas na ordem do XML (`sort_order`), com a forma de contagem que
 * a tela precisa mostrar ao lado do número (RN02/CA02). Os rótulos são os de
 * `client/src/locales/pt-br/capacitation-tallies.json` — mudou o rótulo, muda a
 * prova.
 */
const LEIAUTE = [
  { siapField: 'QuantidadePalestras', counting: /Conta participações/i },
  { siapField: 'QuantidadeReunioes', counting: /Conta participações/i },
  { siapField: 'QuantidadeReunioesInternas', counting: /Conta eventos/i },
  { siapField: 'QuantidadeEventos', counting: /Conta participações/i },
  { siapField: 'QuantidadeCursos', counting: /Conta profissionais/i },
] as const;

const SEED_HINT =
  'Os cinco tipos do leiaute 15.9 não estão na base. O E2ESeeder ainda não chama o ' +
  'CapacitationActionTypeSeeder — rode ' +
  '"php artisan db:seed --class=Database\\Seeders\\CapacitationActionTypeSeeder" na stack ' +
  '(ou inclua-o no E2ESeeder) e rode a suíte de novo.';

/** Data de HOJE no fuso LOCAL (`toISOString()` puro devolveria a data em UTC). */
function todayIso(): string {
  const date = new Date();

  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/**
 * Período consultado: o mês corrente, que é o padrão da tela (o composable
 * inicializa `exercise`/`month` com a data de hoje). A massa usa a data de HOJE
 * — nunca "ontem", que na virada do mês cairia no período anterior e faria o
 * número aparecer numa apuração que a tela não está mostrando.
 */
function currentPeriod(): { exercise: number; month: number; date: string } {
  const now = new Date();

  return { exercise: now.getFullYear(), month: now.getMonth() + 1, date: todayIso() };
}

/** Título único por execução — os casos não dependem de base limpa. */
function uniqueTitle(prefix: string): string {
  return `${prefix} E2E ${Date.now()}`;
}

// ─── API do tenant ───────────────────────────────────────────────────────────

interface TypeOption {
  uuid: string;
  code: string;
  siap_field: string | null;
}

interface TallyCounter {
  siap_field: string;
  counting_mode: string;
  value: number;
}

interface TallyRow {
  social_unit: { uuid: string; name: string };
  has_no_records: boolean;
  counters: TallyCounter[];
}

interface TallyResponse {
  data: TallyRow[];
  meta: { exercise: number; month: number; units_without_records: number };
}

interface ActionPayload {
  capacitation_action_type_uuid: string;
  title: string;
  occurred_on: string;
  participants?: string[];
}

/**
 * Cliente HTTP do guard `client` montado sobre o CONTEXTO DO BROWSER
 * (`page.request` compartilha o cookie jar), no molde de
 * `fixtures/api-client.ts` — que não serve aqui porque autentica o Super Admin
 * (guard `manager`) e não carrega o `X-Tenant-UUID` que o `EnsureTenantScope`
 * exige.
 *
 * `Origin`/`Referer` são obrigatórios: sem eles o Sanctum não reconhece a
 * requisição como vinda do frontend stateful e ignora a sessão (401).
 */
class TenantApi {
  private constructor(
    private readonly page: Page,
    private readonly tenantUuid: string,
  ) {}

  static async from(page: Page): Promise<TenantApi> {
    const tenantUuid =
      (await page.evaluate(() => window.localStorage.getItem('app-tenant'))) ??
      TENANT_UUID_FALLBACK;

    return new TenantApi(page, tenantUuid);
  }

  /** GET dos cinco contadores — o BASELINE contra o qual os deltas são medidos. */
  async tally(exercise: number, month: number): Promise<TallyResponse> {
    return this.send<TallyResponse>('GET', '/api/client/capacitation-tallies', undefined, {
      exercise: String(exercise),
      month: String(month),
    });
  }

  /** Os cinco tipos do leiaute (lookup global, guard `client`). */
  async types(): Promise<TypeOption[]> {
    const res = await this.send<{ data: TypeOption[] }>(
      'GET',
      '/api/relationals/capacitation-action-types',
      undefined,
      { per_page: '100' },
    );

    return res.data ?? [];
  }

  /** Profissionais elegíveis como participantes NAQUELA data (F5/CA06). */
  async participantCandidates(unitUuid: string, date: string): Promise<string[]> {
    const res = await this.send<{ data: Array<{ uuid: string | null }> }>(
      'GET',
      `/api/client/social-units/${unitUuid}/capacitation-actions/participant-candidates`,
      undefined,
      { date },
    );

    return (res.data ?? [])
      .map((candidate) => candidate.uuid)
      .filter((uuid): uuid is string => typeof uuid === 'string' && uuid !== '');
  }

  /** Registra a ação e devolve o `uuid` — a massa do caso. */
  async createAction(unitUuid: string, payload: ActionPayload): Promise<string> {
    const res = await this.send<{ data: { uuid: string } }>(
      'POST',
      `/api/client/social-units/${unitUuid}/capacitation-actions`,
      payload,
    );

    return res.data.uuid;
  }

  /** Cancelamento com motivo — substitui a exclusão (D04) e é a limpeza daqui. */
  async cancelAction(unitUuid: string, actionUuid: string, reason: string): Promise<void> {
    await this.send(
      'PATCH',
      `/api/client/social-units/${unitUuid}/capacitation-actions/${actionUuid}/cancel`,
      { cancellation_reason: reason },
    );
  }

  async findAction(unitUuid: string, actionUuid: string): Promise<{ status: string | null }> {
    const res = await this.send<{ data: { status: string | null } }>(
      'GET',
      `/api/client/social-units/${unitUuid}/capacitation-actions/${actionUuid}`,
    );

    return res.data;
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    data?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = `${API_BASE}${path}`;
    const headers = await this.headers();

    const res =
      method === 'GET'
        ? await this.page.request.get(url, { headers, params })
        : method === 'POST'
          ? await this.page.request.post(url, { headers, data })
          : await this.page.request.patch(url, { headers, data });

    if (!res.ok()) {
      throw new Error(`${method} ${path} falhou: ${res.status()} — ${await res.text()}`);
    }

    return (await res.json()) as T;
  }

  /** O XSRF é relido a cada chamada: o cookie rotaciona entre requisições. */
  private async headers(): Promise<Record<string, string>> {
    const cookies = await this.page.context().cookies();
    const xsrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value;

    return {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Tenant-UUID': this.tenantUuid,
      Origin: BASE!,
      Referer: `${BASE}/app`,
      ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
    };
  }
}

/** Valor de um contador na resposta da API — ausente conta como 0. */
function counterValue(tally: TallyResponse, unitUuid: string, siapField: string): number {
  const row = tally.data.find((item) => item.social_unit.uuid === unitUuid);

  return row?.counters.find((counter) => counter.siap_field === siapField)?.value ?? 0;
}

function unitRow(tally: TallyResponse, unitUuid: string): TallyRow | undefined {
  return tally.data.find((item) => item.social_unit.uuid === unitUuid);
}

// ─── Navegação / leitura da tela ─────────────────────────────────────────────


/** Próxima leitura da apuração — encadeie ANTES da ação que a dispara. */
function waitForTally(page: Page) {
  return page.waitForResponse(
    (res) =>
      res.url().includes('/capacitation-tallies') && res.request().method() === 'GET',
    { timeout: 15_000 },
  );
}

/** A apuração é PÁGINA PRÓPRIA (não aba da unidade) — §Divergências do relatório. */
async function openTallies(page: Page): Promise<void> {
  const request = waitForTally(page);
  await page.goto('/app/prestacao-contas/capacitacao');
  await dismissPlatformUpdates(page);
  const response = await request;
  expect(response.status(), 'GET /client/capacitation-tallies não respondeu 200').toBe(200);
  await expect(page.getByTestId('capacitation-tally-view')).toBeVisible();
}

/** Recarrega pelo botão da tela — a apuração é derivada a cada consulta (RN07). */
async function refreshTallies(page: Page): Promise<void> {
  const request = waitForTally(page);
  await page.getByTestId('capacitation-tally-refresh').click();
  await request;
  await expect(page.getByTestId('capacitation-tally-table')).toBeVisible();
}

/** O número EXIBIDO na célula (unidade × campo do leiaute). */
async function cellValue(page: Page, unitUuid: string, siapField: string): Promise<number> {
  const cell = page.getByTestId(`capacitation-tally-value-${unitUuid}-${siapField}`);
  await expect(cell).toBeVisible();

  return Number((await cell.innerText()).trim());
}

test.describe('US-CAPAC-03 — apuração de capacitação e divulgação (client)', () => {
  test.skip(
    !configured,
    'Defina CLIENT_BASE_URL + E2E_CLIENT_OPERADOR_CPF/PASSWORD no arquivo de env do e2e (o client exige login de tenant próprio).',
  );

  test.use({ baseURL: BASE });

  /**
   * Massa criada pelo caso corrente. O `afterEach` CANCELA cada ação — a
   * cancelada sai da apuração, então a base volta ao que era sem precisar de um
   * `DELETE` que o recurso não tem (D04).
   */
  let created: Array<{ unitUuid: string; actionUuid: string }> = [];

  test.beforeEach(() => {
    created = [];
  });

  /**
   * Evidência do estado FINAL de cada caso aprovado — declarada ANTES do
   * `afterEach` de limpeza de propósito: a tela fotografada é a que o caso
   * deixou, ainda com os números que ele asseverou. (A limpeza cancela via API,
   * sem recarregar a página, então não altera o que está na tela; a ordem aqui é
   * garantia, não conserto.) Sem `CAPTURE_EVIDENCE=1` o corpo retorna na
   * primeira linha.
   */
  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test.afterEach(async ({ page }) => {
    if (created.length === 0) return;

    const api = await TenantApi.from(page);

    for (const { unitUuid, actionUuid } of created) {
      await api
        .cancelAction(unitUuid, actionUuid, 'Massa do cenário E2E da apuração — cancelada.')
        .catch(() => {
          // Já cancelada pelo próprio caso (CA07): 422 esperado, nada a fazer.
        });
    }

    created = [];
  });

  test('CA01/CA02 — os cinco contadores do período, cada um com a sua forma de contagem', async ({
    page,
  }) => {
    const period = currentPeriod();

    await openTallies(page);

    const api = await TenantApi.from(page);
    const types = await api.types();
    test.skip(types.length !== 5, SEED_HINT);

    const uuidOf = (code: string): string => {
      const type = types.find((item) => item.code === code);
      expect(type, `Tipo "${code}" ausente no lookup do leiaute`).toBeTruthy();

      return type!.uuid;
    };

    // BASELINE: a apuração é do município e a base é acumulada — o que se prova
    // é o DELTA que esta massa produz, nunca um valor absoluto.
    const before = await api.tally(period.exercise, period.month);
    expect(
      unitRow(before, UNIT),
      'A unidade da massa não está na apuração do operador — confira a lotação vigente do seeder.',
    ).toBeTruthy();

    // --- massa do caso, toda no MESMO dia e na MESMA unidade ---
    const candidates = await api.participantCandidates(UNIT, period.date);
    expect(
      candidates.length,
      'Nenhum profissional elegível como participante no CRAS Centro nesta data.',
    ).toBeGreaterThan(0);

    const seminarParticipants = candidates.slice(0, 2);

    created.push({
      unitUuid: UNIT,
      actionUuid: await api.createAction(UNIT, {
        capacitation_action_type_uuid: uuidOf(TYPE_PALESTRA),
        title: uniqueTitle('Seminário estadual do SUAS'),
        occurred_on: period.date,
        participants: seminarParticipants,
      }),
    });

    // Duas reuniões internas SEM participante nenhum: é o contraste que dá
    // sentido ao rótulo — elas contam 2 (eventos), não 0 (pessoas).
    for (const index of [1, 2]) {
      created.push({
        unitUuid: UNIT,
        actionUuid: await api.createAction(UNIT, {
          capacitation_action_type_uuid: uuidOf(TYPE_REUNIAO_INTERNA),
          title: uniqueTitle(`Reunião interna de equipe ${index}`),
          occurred_on: period.date,
        }),
      });
    }

    created.push({
      unitUuid: UNIT,
      actionUuid: await api.createAction(UNIT, {
        capacitation_action_type_uuid: uuidOf(TYPE_DIVULGACAO),
        title: uniqueTitle('Evento de divulgação do serviço'),
        occurred_on: period.date,
        participants: candidates.slice(0, 1),
      }),
    });

    await refreshTallies(page);

    // --- as cinco colunas, na ordem do XML, cada uma dizendo o que soma ---
    const headers = page.locator('[data-testid^="capacitation-tally-column-"]');
    await expect(headers).toHaveCount(LEIAUTE.length);

    const renderedFields = await headers.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')?.replace('capacitation-tally-column-', '')),
    );
    expect(renderedFields).toEqual(LEIAUTE.map((column) => column.siapField));

    for (const column of LEIAUTE) {
      await expect(
        page.getByTestId(`capacitation-tally-mode-${column.siapField}`),
      ).toHaveText(column.counting);
    }

    // A legenda explica as TRÊS formas de contagem presentes nas colunas.
    const legend = page.getByTestId('capacitation-tally-legend');
    await expect(legend).toContainText(/participações/i);
    await expect(legend).toContainText(/eventos/i);
    await expect(legend).toContainText(/profissionais/i);

    // --- os números: cada contador somou a SUA coisa ---
    const expected: Array<[string, number]> = [
      // participação: as pessoas do seminário
      ['QuantidadePalestras', seminarParticipants.length],
      // nada foi registrado neste tipo: o contador não pode ter se mexido
      ['QuantidadeReunioes', 0],
      // evento: DUAS reuniões internas, ZERO participantes — conta 2
      ['QuantidadeReunioesInternas', 2],
      // participação: uma pessoa no evento de divulgação
      ['QuantidadeEventos', 1],
      // tipo de PERÍODO (curso), intocado por esta massa de data única
      ['QuantidadeCursos', 0],
    ];

    for (const [siapField, delta] of expected) {
      expect(
        await cellValue(page, UNIT, siapField),
        `Contador ${siapField} fora do esperado (baseline + ${delta})`,
      ).toBe(counterValue(before, UNIT, siapField) + delta);
    }

    await page.screenshot({
      path: 'test-results/capac-03-ca01-apuracao-do-periodo.png',
      fullPage: true,
    });
  });

  test('CA07 — ação cancelada deixa de somar: o contador cai na consulta seguinte', async ({
    page,
  }) => {
    const period = currentPeriod();

    await openTallies(page);

    const api = await TenantApi.from(page);
    const types = await api.types();
    test.skip(types.length !== 5, SEED_HINT);

    const reuniaoInterna = types.find((type) => type.code === TYPE_REUNIAO_INTERNA);
    expect(reuniaoInterna, `Tipo "${TYPE_REUNIAO_INTERNA}" ausente no lookup`).toBeTruthy();

    const baseline = await cellValue(page, UNIT, 'QuantidadeReunioesInternas');

    // Tipo de contagem por EVENTO de propósito: sem participante no meio, a
    // única causa possível da variação do número é a ação em si.
    const actionUuid = await api.createAction(UNIT, {
      capacitation_action_type_uuid: reuniaoInterna!.uuid,
      title: uniqueTitle('Reunião interna a cancelar'),
      occurred_on: period.date,
    });
    created.push({ unitUuid: UNIT, actionUuid });

    await refreshTallies(page);
    expect(await cellValue(page, UNIT, 'QuantidadeReunioesInternas')).toBe(baseline + 1);

    // --- cancelamento com motivo (RN09/D04): o substituto da exclusão ---
    await api.cancelAction(
      UNIT,
      actionUuid,
      'Registro duplicado — cancelado pelo cenário E2E da apuração.',
    );

    await refreshTallies(page);
    expect(
      await cellValue(page, UNIT, 'QuantidadeReunioesInternas'),
      'A ação cancelada continuou somando na apuração',
    ).toBe(baseline);

    // E o registro NÃO sumiu: some da apuração, não da história (RN09).
    expect((await api.findAction(UNIT, actionUuid)).status).toBe('cancelled');

    await page.screenshot({
      path: 'test-results/capac-03-ca07-cancelada-nao-soma.png',
      fullPage: true,
    });
  });

  test('CA09 — unidade sem nenhum registro no período aparece sinalizada, com os cinco zeros', async ({
    page,
  }) => {
    const period = currentPeriod();

    await openTallies(page);

    const api = await TenantApi.from(page);
    test.skip((await api.types()).length !== 5, SEED_HINT);

    const tally = await api.tally(period.exercise, period.month);
    const row = unitRow(tally, UNIT_WITHOUT_RECORDS);
    expect(
      row,
      'A unidade "sem registro" não está na apuração do operador — confira a segunda lotação do seeder.',
    ).toBeTruthy();
    test.skip(
      row!.has_no_records === false,
      'A unidade reservada ao CA09 recebeu ação de capacitação neste período (base suja): ' +
        'nenhum spec deve registrar no "E2E CRAS Sem MDS".',
    );

    // --- o aviso da coordenação, ANTES da remessa (RN08) ---
    const attention = page.getByTestId('capacitation-tally-attention');
    await expect(attention).toBeVisible();
    await expect(attention).toContainText(/não registr/i);
    await expect(attention).toContainText(/zero nos campos obrigatórios/i);
    await expect(attention).toContainText(String(period.exercise));

    // --- e a linha da unidade, marcada, com os cinco contadores zerados ---
    const line = page.getByTestId(`capacitation-tally-row-${UNIT_WITHOUT_RECORDS}`);
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('data-no-records', 'true');
    await expect(
      page.getByTestId(`capacitation-tally-no-records-${UNIT_WITHOUT_RECORDS}`),
    ).toContainText(/sem registro no período/i);

    for (const column of LEIAUTE) {
      expect(
        await cellValue(page, UNIT_WITHOUT_RECORDS, column.siapField),
        `A unidade sem registro deveria declarar 0 em ${column.siapField}`,
      ).toBe(0);
    }

    await page.screenshot({
      path: 'test-results/capac-03-ca09-unidade-sem-registro.png',
      fullPage: true,
    });
  });

  test('RN03/D09 — nenhum contador é editável: sem campo, sem salvar, sem escrita', async ({
    page,
  }) => {
    // Toda requisição de escrita que partir da tela é registrada — a prova da
    // ausência não pode depender só do que se vê.
    const writes: string[] = [];
    page.on('request', (request) => {
      if (
        request.url().includes('/capacitation') &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
      ) {
        writes.push(`${request.method()} ${request.url()}`);
      }
    });

    await openTallies(page);

    const api = await TenantApi.from(page);
    test.skip((await api.types()).length !== 5, SEED_HINT);

    const view = page.getByTestId('capacitation-tally-view');

    // A tela DIZ por que não há o que digitar, em vez de só não oferecer.
    await expect(page.getByTestId('capacitation-tally-readonly-notice')).toContainText(
      /nenhum destes números é digitável/i,
    );

    await refreshTallies(page);

    // Nenhuma célula da matriz é um campo — nem input, nem contenteditable.
    await expect(
      page
        .getByTestId('capacitation-tally-table')
        .locator('input, textarea, select, [contenteditable="true"]'),
    ).toHaveCount(0);

    // E não há afordância de escrita em lugar nenhum da tela: o que existe é
    // período consultado (dois selects) e "Atualizar apuração".
    await expect(
      view.getByRole('button', {
        name: /salvar|gravar|aplicar|confirmar|editar|excluir|remover|nov[oa]\b|adicionar/i,
      }),
    ).toHaveCount(0);

    // A leitura recarregada não disparou uma única escrita.
    expect(writes, `A tela de apuração disparou escrita: ${writes.join(' | ')}`).toEqual([]);

    await page.screenshot({
      path: 'test-results/capac-03-rn03-somente-leitura.png',
      fullPage: true,
    });
  });
});
