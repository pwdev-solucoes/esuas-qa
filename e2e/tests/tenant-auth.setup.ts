import { expect, test as setup } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Setup de autenticação do frontend do TENANT (`client/`, porta 4174).
 *
 * Contraparte de `tests/auth.setup.ts` (Super Admin no `admin/`, porta 4173).
 * Sem ele, cada spec de `tests/client/` precisava fazer login à mão e ficava
 * `test.skip` por padrão — o TODO registrado em
 * `tests/client/unit-professionals.spec.ts`.
 *
 * ## O fluxo reproduzido (o real, do `client/`)
 *
 *  1. `GET /auth/login` — a navegação pela UI dispara `ensureCsrfCookie()`
 *     ANTES do POST de login (sem isso o Laravel devolveria 419).
 *  2. `POST /api/client/auth/login` (guard `client`) — via formulário.
 *  3. `GET /api/client/auth/tenants` — o store lista os vínculos do usuário.
 *  4. Bifurcação (ver `client/src/stores/auth.ts::resolveTenantRedirect`):
 *       - 1 tenant  → `setActiveTenant()` automático e `push('/app')`;
 *       - N tenants → `push({ name: 'select-tenant' })` e a escolha é do
 *         usuário na tela `SelectTenantPage`.
 *     Este setup cobre OS DOIS casos: se cair em `/auth/select-tenant`, ele
 *     escolhe o tenant de `E2E_TENANT_UUID` (fallback: o primeiro da lista).
 *  5. A seleção grava `localStorage['app-tenant']`, e a partir daí o
 *     interceptor do Axios envia `X-Tenant-UUID` em toda chamada que não seja
 *     `client/auth/*` (ver `client/src/services/http/interceptors.ts`).
 *     É por isso que o storageState precisa carregar COOKIES **e**
 *     localStorage: só o cookie de sessão não basta — sem `app-tenants`/
 *     `app-tenant` o guard `requireActiveTenant` derruba a sessão.
 *
 * ## Artefatos gerados
 *
 *  - `.auth/tenant.json`            → storageState completo (project `chromium-tenant`)
 *  - `.auth/tenant-api-client.json` → só os cookies, para `APIRequestContext`
 *
 * ## Massa de teste
 *
 * O usuário default é o `E2E_CLIENT_OPERADOR_*` — Operacional do tenant E2E,
 * com o add-on LGPD `family_viewer` e lotação VIGENTE no "CRAS Centro"
 * (semeado por `api/database/seeders/E2EProntuarioSeeder.php`). É o usuário
 * mais usado pelos specs de `tests/client/`. Os defaults abaixo espelham os
 * do seeder — massa de teste fictícia versionada em código, não segredo.
 */

const STORAGE_DIR = path.resolve(__dirname, '..', '.auth');
const TENANT_STATE = path.join(STORAGE_DIR, 'tenant.json');
const TENANT_API_STATE = path.join(STORAGE_DIR, 'tenant-api-client.json');

const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL ?? 'http://localhost:4174';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';

/** Defaults = `E2EProntuarioSeeder::DEFAULT_OPERADOR_CPF` / `E2ESeeder`. */
const TENANT_CPF = process.env.E2E_CLIENT_OPERADOR_CPF ?? '11144477735';
const TENANT_PASSWORD = process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? 'senha123';
const TENANT_UUID = process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';

type StoredTenant = { uuid: string; trade_name?: string; legal_name?: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Diagnóstico compartilhado pelas mensagens de falha — sem PII nem senha. */
function troubleshooting(): string {
  return [
    `  client:  ${CLIENT_BASE_URL} (CLIENT_BASE_URL)`,
    `  api:     ${API_BASE_URL} (E2E_API_BASE_URL)`,
    `  usuário: E2E_CLIENT_OPERADOR_CPF (${process.env.E2E_CLIENT_OPERADOR_CPF ? 'do ambiente' : 'default do seeder'})`,
    `  tenant:  ${TENANT_UUID} (E2E_TENANT_UUID)`,
    '',
    'Checklist:',
    '  1. A stack E2E está no ar? (e2e/scripts/start-stack.sh — admin 4173, client 4174, api 8090)',
    '  2. O banco foi semeado com E2ESeeder (que chama E2EProntuarioSeeder)?',
    '     php artisan migrate:fresh --seed --seeder=Database\\\\Seeders\\\\E2ESeeder',
    '  3. A porta do client está em SANCTUM_STATEFUL_DOMAINS/FRONTEND_URL_CLIENT da API?',
  ].join('\n');
}

setup.use({ baseURL: CLIENT_BASE_URL });

setup('autentica usuário do tenant (client) e propaga cookies para o api-client', async ({
  page,
}) => {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

  // 1) Login pela UI — a navegação garante o cookie XSRF antes do POST.
  await page.goto('/auth/login');
  await expect(page.locator('input#cpf')).toBeVisible();
  await page.locator('input#cpf').fill(TENANT_CPF);
  await page.locator('input#password').fill(TENANT_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // 2) O client bifurca entre /app (tenant único) e /auth/select-tenant (N).
  try {
    await page.waitForURL(/\/(app|auth\/select-tenant)(\/|$|\?)/, { timeout: 20_000 });
  } catch {
    const error = await page
      .getByTestId('login-error')
      .textContent()
      .catch(() => null);

    throw new Error(
      [
        'Login do TENANT falhou — o client não saiu de /auth/login.',
        error ? `Mensagem da tela: "${error.trim()}"` : 'A tela não exibiu mensagem de erro.',
        '',
        troubleshooting(),
      ].join('\n'),
    );
  }

  // 3) Seleção de tenant (SelectTenantPage) — só acontece com N vínculos.
  if (page.url().includes('/auth/select-tenant')) {
    const tenants = await page.evaluate<StoredTenant[]>(() => {
      try {
        return JSON.parse(window.localStorage.getItem('app-tenants') ?? '[]') as StoredTenant[];
      } catch {
        return [];
      }
    });

    if (tenants.length === 0) {
      throw new Error(
        [
          'O usuário caiu em /auth/select-tenant sem nenhum tenant na lista.',
          'GET /api/client/auth/tenants devolveu vazio — o vínculo user×tenant',
          '(user_tenant_roles) não existe ou o tenant não está Ativo.',
          '',
          troubleshooting(),
        ].join('\n'),
      );
    }

    const target = tenants.find((t) => t.uuid === TENANT_UUID) ?? tenants[0];
    const label = target.trade_name ?? target.legal_name;

    if (!label) {
      throw new Error(
        `Tenant ${target.uuid} veio sem trade_name/legal_name — impossível clicar no card.`,
      );
    }

    await page
      .getByRole('button', { name: new RegExp(escapeRegExp(label), 'i') })
      .first()
      .click();
    await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 20_000 });
  }

  // 4) Sessão de tenant efetiva: o UUID ativo persistido é o que vira o
  //    header X-Tenant-UUID de todas as requests seguintes.
  const activeTenant = await page.evaluate(() => window.localStorage.getItem('app-tenant'));

  if (!activeTenant) {
    throw new Error(
      [
        'Autenticou, mas nenhum tenant ficou ativo (localStorage["app-tenant"] vazio).',
        'Sem ele o guard requireActiveTenant desvia toda a área /app.',
        '',
        troubleshooting(),
      ].join('\n'),
    );
  }

  if (activeTenant !== TENANT_UUID) {
    // Não é erro fatal (o usuário pode ter só um vínculo, em outro tenant),
    // mas os UUIDs de massa dos specs são do tenant E2E — avisa alto.
    console.warn(
      `[tenant-auth.setup] tenant ativo (${activeTenant}) != E2E_TENANT_UUID (${TENANT_UUID}).`,
    );
  }

  // 5) Prova de ponta a ponta: a sessão vale na API, no guard `client`.
  const me = await page.request.get(`${API_BASE_URL}/api/client/auth/me`, {
    headers: {
      Accept: 'application/json',
      Origin: CLIENT_BASE_URL,
      Referer: `${CLIENT_BASE_URL}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Tenant-UUID': activeTenant,
    },
  });

  expect(
    me.status(),
    `GET /api/client/auth/me devolveu ${me.status()} com a sessão recém-criada.\n${troubleshooting()}`,
  ).toBe(200);

  // 6) storageState completo (cookies + localStorage) para o project
  //    `chromium-tenant`.
  await page.context().storageState({ path: TENANT_STATE });

  // 7) Só os cookies, no formato aceito por `request.newContext()` — evita um
  //    segundo login dedicado (throttle 6/min nas rotas /auth/*).
  const browserState = await page.context().storageState();
  const apiState = {
    cookies: browserState.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
    origins: [],
  };
  fs.writeFileSync(TENANT_API_STATE, JSON.stringify(apiState, null, 2));

  console.log(`[tenant-auth.setup] sessão de tenant pronta em ${TENANT_STATE}`);
});
