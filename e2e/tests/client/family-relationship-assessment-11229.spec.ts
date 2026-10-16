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
 * US-CONV-02 (HU #11229) — avaliação técnica das relações intrafamiliares na
 * aba Convivência do prontuário (`client/`). Spec MANUAL multiusuário: cobre o
 * que os cenários declarativos E2E-022 (CREAS registra e lê) e E2E-023
 * (CRAS Centro sem acesso; Master sem a ação) não alcançam.
 *
 * ## Triagem
 *
 * Aqui: CA03 (relação conjugal "Não se aplica" e fora do formulário, família
 * sem cônjuge) e CA04 pela API (Master sem lotação: `can_register = false`,
 * `reason = assessment_requires_conducting_unit`). CA01/CA02/CA07 estão no
 * E2E-022; CA05/CA06 e o CA04 na tela, no E2E-023; CA08/CA09 e CT01–CT11, no Pest.
 *
 * ## Arranjo (⚠️ sessão única)
 *
 * O login de um usuário derruba a sessão do outro. Ordem fixa: o Master, em
 * contexto de API PRÓPRIO, confere o CA04 e SÓ ENTÃO o operador do CRAS Centro
 * loga pela interface (CA03).
 *
 * ## Massa (E2ERelationshipAssessmentSeeder)
 *
 * - `…0f0501`: família do CREAS (cônjuge e dois filhos);
 * - `…0f0502`: família referenciada no CRAS Centro, SEM cônjuge.
 *
 * Nunca registra nem imprime CPF, nome ou resultado de avaliação em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';

const FAMILY_WITH_SPOUSE = '00000000-0000-4000-8000-0000000f0501';
const FAMILY_NO_SPOUSE = '00000000-0000-4000-8000-0000000f0502';

const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? '52998224725';
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? 'senha123';
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF ?? '11144477735';
const OPERADOR_PASSWORD = process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? 'senha123';

const configured = Boolean(BASE);

const EVIDENCE_SLUG = '11229-avaliacao-tecnica-relacoes-intrafamiliares';

type AssessmentOptions = {
  can_register: boolean;
  reason: string | null;
  units: unknown[];
};

let operatorPage: Page;
let masterOptions: AssessmentOptions;

async function openMasterApi(): Promise<{ api: APIRequestContext; xsrf: string }> {
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

test.beforeAll(async ({ browser }) => {
  if (!configured) return;

  // CA04 (API): o Master, ANTES do login do operador (sessão única).
  const { api } = await openMasterApi();
  try {
    const res = await api.get(`/api/client/families/${FAMILY_WITH_SPOUSE}/relationship-assessments/options`);
    expect(res.status(), 'options da avaliação (Master)').toBe(200);
    masterOptions = (await res.json()).data as AssessmentOptions;
  } finally {
    await api.dispose();
  }

  // SÓ AGORA o operador do CRAS Centro entra: o login do Master derrubaria a sessão dele.
  operatorPage = await browser.newPage({ baseURL: BASE, locale: 'pt-BR' });
  await loginAsTenantUser(operatorPage, OPERADOR_CPF, OPERADOR_PASSWORD, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(operatorPage);
});

test.afterAll(async () => {
  await operatorPage?.close();
});

test.describe('US-CONV-02 — avaliação técnica das relações intrafamiliares (client)', () => {
  test.skip(!configured, 'Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.');

  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: BASE, locale: 'pt-BR' });

  test.afterEach(async ({}, testInfo) => {
    if (operatorPage) await captureFinalEvidence(operatorPage, testInfo, EVIDENCE_SLUG);
  });

  test('CA03 — a relação conjugal de família sem cônjuge mostra "Não se aplica" e não é oferecida no formulário', async () => {
    await operatorPage.goto(`/app/cadastros/familias/${FAMILY_NO_SPOUSE}?tab=convivencia`);
    await dismissPlatformUpdates(operatorPage);

    const section = operatorPage.getByTestId('relationship-assessments-section');
    await expect(section).toBeVisible({ timeout: 15_000 });

    const conjugal = operatorPage.getByTestId('relationship-card-conjugal');
    await expect(conjugal.getByTestId('relationship-not-applicable')).toContainText(
      'Não se aplica — família sem cônjuge ou companheiro(a)',
    );
    await expect(conjugal.getByTestId('relationship-empty')).toHaveCount(0);

    // Se o operador puder registrar nesta família, a relação conjugal não é oferecida.
    const register = operatorPage.getByTestId('relationship-assessments-register');
    if (await register.isVisible().catch(() => false)) {
      await register.click();
      await operatorPage.getByTestId('relationship-relation-select').click();
      await expect(
        operatorPage.getByRole('option', { name: 'Relações conjugais', exact: true }),
      ).toHaveCount(0);
      await operatorPage.keyboard.press('Escape');
    }
  });

  test('CA04 — o Master sem lotação recebe can_register falso e o motivo "assessment_requires_conducting_unit" pela API', async () => {
    expect(masterOptions.can_register).toBe(false);
    expect(masterOptions.reason).toBe('assessment_requires_conducting_unit');
    expect(masterOptions.units).toHaveLength(0);
  });
});
