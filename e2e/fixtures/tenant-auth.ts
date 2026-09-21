import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import * as path from 'node:path';

/**
 * Utilitários da sessão de TENANT (frontend `client/`, porta 4174).
 *
 * O project `chromium-tenant` já entrega `page` autenticado como o
 * `E2E_CLIENT_OPERADOR_*` (ver `tests/tenant-auth.setup.ts`), então o caso
 * comum NÃO precisa de nada daqui: é só navegar para `/app/...`.
 *
 * Este módulo cobre os dois casos que sobram:
 *
 *  1. **Outro usuário do tenant** (master, sem lotação, sem add-on) —
 *     `loginAsTenantUser()`. Ele zera a sessão herdada ANTES de autenticar;
 *     sem isso, `page.goto('/auth/login')` seria redirecionado para `/app`
 *     pelo guard `redirectIfAuthenticated` e o formulário nunca apareceria.
 *  2. **Chamadas de API no escopo do tenant** — `createTenantApiClient()`,
 *     que reaproveita os cookies do setup e já manda o `X-Tenant-UUID`.
 */

export const TENANT_STORAGE_STATE = path.resolve(__dirname, '..', '.auth', 'tenant.json');
export const TENANT_API_STORAGE_STATE = path.resolve(
  __dirname,
  '..',
  '.auth',
  'tenant-api-client.json',
);

export const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL ?? 'http://localhost:4174';
export const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';

type StoredTenant = { uuid: string; trade_name?: string; legal_name?: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derruba a sessão herdada do storageState: cookies do contexto + as chaves
 * que o client persiste (`app-user`, `app-token`, `app-tenants`, `app-tenant`).
 * O `localStorage` só é acessível estando no origin, daí a navegação antes.
 */
export async function resetTenantSession(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/auth/login');
  await page.evaluate(() => window.localStorage.clear());
  await page.goto('/auth/login');
  await expect(page.locator('input#cpf')).toBeVisible();
}

/**
 * Autentica OUTRO usuário do tenant, reproduzindo o fluxo real do client:
 * login por CPF → lista de tenants → seleção quando há mais de um vínculo.
 */
export async function loginAsTenantUser(
  page: Page,
  cpf: string,
  password: string,
  options: { tenantUuid?: string } = {},
): Promise<void> {
  const wanted = options.tenantUuid ?? TENANT_UUID;

  await resetTenantSession(page);
  await page.locator('input#cpf').fill(cpf);
  await page.locator('input#password').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(app|auth\/select-tenant)(\/|$|\?)/, { timeout: 20_000 });

  if (!page.url().includes('/auth/select-tenant')) {
    return;
  }

  const tenants = await page.evaluate<StoredTenant[]>(() => {
    try {
      return JSON.parse(window.localStorage.getItem('app-tenants') ?? '[]') as StoredTenant[];
    } catch {
      return [];
    }
  });

  const target = tenants.find((t) => t.uuid === wanted) ?? tenants[0];
  const label = target?.trade_name ?? target?.legal_name;

  if (!label) {
    throw new Error('Tela de seleção de tenant sem nenhum vínculo utilizável para este usuário.');
  }

  await page
    .getByRole('button', { name: new RegExp(escapeRegExp(label), 'i') })
    .first()
    .click();
  await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 20_000 });
}

/**
 * `APIRequestContext` autenticado no guard `client` e já escopado no tenant.
 * Usa os cookies gravados por `tests/tenant-auth.setup.ts` — sem login extra
 * (as rotas `/auth/*` têm throttle de 6 req/min).
 */
export async function createTenantApiClient(
  tenantUuid: string = TENANT_UUID,
): Promise<APIRequestContext> {
  const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';

  return playwrightRequest.newContext({
    baseURL: apiBase,
    storageState: TENANT_API_STORAGE_STATE,
    extraHTTPHeaders: {
      Accept: 'application/json',
      Origin: CLIENT_BASE_URL,
      Referer: `${CLIENT_BASE_URL}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Tenant-UUID': tenantUuid,
    },
  });
}
