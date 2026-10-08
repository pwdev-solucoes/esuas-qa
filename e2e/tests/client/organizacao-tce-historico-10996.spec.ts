import { test, expect, request as playwrightRequest, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import * as path from 'node:path';
import { createTenantApiClient, loginAsTenantUser, CLIENT_BASE_URL, TENANT_UUID } from '../../fixtures/tenant-auth';
import { OrganizacaoPage } from '../../pages/client/OrganizacaoPage';

/**
 * HU #10996 · US-10996-03 — Parâmetros TCE/AL (identificador curto, CNPJ da UG)
 * e trilha de auditoria da organização (aba Histórico).
 *
 * Sessão: a do project chromium-tenant (E2ESeeder, operador puro). O E2E não
 * faz login próprio (throttle:6,1). O estado original do CARDUG é restaurado.
 */

const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const ADMIN_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const ADMIN_API_STATE = path.resolve(__dirname, '..', '..', '.auth', 'api-client.json');

type Res = { status: number; body: any };

async function xsrf(api: APIRequestContext): Promise<string> {
  const s = await api.storageState();

  return decodeURIComponent(s.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
}

async function call(api: APIRequestContext, method: 'GET' | 'PUT', url: string, data?: unknown): Promise<Res> {
  const res = await api.fetch(url, { method, data, headers: { 'X-XSRF-TOKEN': await xsrf(api), 'X-Locale': 'pt_BR' } });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  return { status: res.status(), body };
}

function evidencePath(name: string): string {
  const dir = process.env.E2E_EVIDENCE_DIR;

  return dir ? path.join(dir, name) : test.info().outputPath(name);
}

test.describe.configure({ mode: 'serial' });

test.describe('US-10996-03 — Parâmetros TCE/AL e Histórico da organização', () => {
  let api: APIRequestContext;
  let original: any = {};

  let masterCtx: BrowserContext;
  let masterPage: Page;

  /** Chamada de API como Master (sessão do navegador do Master). */
  async function masterCall(method: 'GET' | 'PUT', endpoint: string, data?: unknown): Promise<Res> {
    const cookies = await masterCtx.cookies(API_BASE);
    const token = decodeURIComponent(cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
    const res = await masterCtx.request.fetch(`${API_BASE}${endpoint}`, {
      method,
      data,
      headers: {
        Accept: 'application/json',
        Origin: CLIENT_BASE_URL,
        Referer: `${CLIENT_BASE_URL}/app`,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Locale': 'pt_BR',
        'X-Tenant-UUID': TENANT_UUID,
        'X-XSRF-TOKEN': token,
      },
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }

    return { status: res.status(), body };
  }

  const tce = (data: Record<string, unknown>) =>
    masterCall('PUT', '/api/client/tenant-tce-parameters', { confirm_identifier_change: true, ...data });

  test.beforeAll(async ({ browser }) => {
    api = await createTenantApiClient();
    masterCtx = await browser.newContext({ baseURL: CLIENT_BASE_URL });
    masterPage = await masterCtx.newPage();
    await loginAsTenantUser(masterPage, process.env.E2E_CLIENT_MASTER_CPF!, process.env.E2E_CLIENT_MASTER_PASSWORD!);
    const cur = await masterCall('GET', '/api/client/tenant-tce-parameters');
    expect([200, 201]).toContain(cur.status);
    original = cur.body?.data ?? {};
  });

  test.afterAll(async () => {
    await tce({
      cardug_identifier: original.cardug_identifier ?? null,
      managing_unit_cnpj: original.managing_unit_cnpj ?? null,
      managing_unit: original.managing_unit ?? null,
      autonomous_unit_code: original.autonomous_unit_code ?? null,
    }).catch(() => undefined);
    await api.dispose();
    await masterCtx.close();
  });

  test('C-CA01 / C-CA02 — Identificador "20", "1" e "123456" são aceitos e devolvidos como salvos', async () => {
    for (const value of ['20', '1', '123456']) {
      const put = await tce({ cardug_identifier: value });
      expect([200, 201], `PUT ${value}`).toContain(put.status);
      const get = await masterCall('GET', '/api/client/tenant-tce-parameters');
      expect(get.body.data.cardug_identifier).toBe(value);
    }
  });

  test('C-CA03 / C-CA04 / C-CA04b — "1234567", "2A", "20-1", "0" e "000000" são recusados (422)', async () => {
    for (const value of ['1234567', '2A', '20-1', '0', '000000']) {
      const put = await tce({ cardug_identifier: value });
      expect(put.status, `PUT ${value}`).toBe(422);
      expect(put.body.errors.cardug_identifier?.length, `mensagem ${value}`).toBeGreaterThan(0);
    }
  });

  test('C-CA07 / C-CA08 / C-CA09 — CNPJ da UG numérico e alfanumérico válidos; DV errado recusado', async () => {
    expect([200, 201]).toContain((await tce({ managing_unit_cnpj: '11222333000181' })).status);
    expect([200, 201]).toContain((await tce({ managing_unit_cnpj: '12ABC34501DE35' })).status);
    const bad = await tce({ managing_unit_cnpj: '11222333000182' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.managing_unit_cnpj[0]).toMatch(/CNPJ da Unidade Gestora informado é inválido/i);
  });

  test('C-CA09 — Drawer aponta "CNPJ inválido" antes de salvar', async () => {
    const page = masterPage;
    const org = new OrganizacaoPage(page);
    await org.openTceEditor();
    await org.cnpjInput.fill('11222333000182');
    await org.cnpjInput.blur();
    await expect(org.tceDrawer.getByText(/CNPJ inválido/i)).toBeVisible();
    await page.screenshot({ path: evidencePath('C-CA09-cnpj-invalido.png') });
  });

  test('C-CA10 — Trilha mostra o Identificador 20 → 21 com autor e data', async () => {
    const page = masterPage;
    expect([200, 201]).toContain((await tce({ cardug_identifier: '20' })).status);
    const org = new OrganizacaoPage(page);
    await org.saveCardug('21');
    await org.openHistory();
    const entry = org.entriesOf(/Parâmetros d?o? ?TCE/i).first();
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('20');
    await expect(entry).toContainText('21');
    await expect(entry).toContainText(/\d{2}\/\d{2}\/\d{4}/);
    await page.screenshot({ path: evidencePath('C-CA10-historico-cardug.png') });
  });

  test('C-CA11 — Alteração feita pelo Global aparece como "Administração da plataforma"', async () => {
    const admin = await playwrightRequest.newContext({
      baseURL: API_BASE,
      storageState: ADMIN_API_STATE,
      extraHTTPHeaders: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: ADMIN_URL,
        Referer: `${ADMIN_URL}/app`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    const uuid = TENANT_UUID;
    const t = await call(admin, 'GET', `/api/tenants/by-uuid/${uuid}`);
    expect(t.status).toBe(200);
    const tenant = t.body.data;
    const novo = `${tenant.trade_name} E2E`;
    const put = await call(admin, 'PUT', `/api/tenants/${tenant.id}`, { ...tenant, trade_name: novo });
    try {
      expect(put.status, JSON.stringify(put.body).slice(0, 300)).toBe(200);
      const audits = await masterCall('GET', '/api/client/tenant-settings/audits');
      expect(audits.status).toBe(200);
      const found = (audits.body.data as any[]).find((a) => a.causer?.name === 'Administração da plataforma');
      expect(found, 'item do Global na trilha').toBeTruthy();
      expect(JSON.stringify(found)).not.toMatch(/@/);
    } finally {
      await call(admin, 'PUT', `/api/tenants/${tenant.id}`, { ...tenant, trade_name: tenant.trade_name });
      await admin.dispose();
    }
  });

  test('C-CA12 — Operador lê a trilha (200) e a aba Histórico não tem ação de editar ou apagar', async ({ page }) => {
    const audits = await call(api, 'GET', '/api/client/tenant-settings/audits');
    expect(audits.status).toBe(200);
    // Operador puro não grava parâmetros TCE (a API recusa), mesmo vendo o botão "Editar" no cartão.
    const write = await call(api, 'PUT', '/api/client/tenant-tce-parameters', { cardug_identifier: '99' });
    expect(write.status).toBe(403);
    const org = new OrganizacaoPage(page);
    await org.openHistory();
    await expect(org.history.getByRole('button', { name: /editar|excluir|apagar|remover/i })).toHaveCount(0);
    await page.screenshot({ path: evidencePath('C-CA12-operador-historico.png') });
  });

  test('C-CA13 — Trilha só traz registros da organização (sem pessoas/profissionais)', async () => {
    const audits = await masterCall('GET', '/api/client/tenant-settings/audits');
    const subjects = new Set((audits.body.data as any[]).map((a) => a.subject));
    for (const s of subjects) {
      expect(['organization', 'contact', 'tce', 'responsible', 'official_address']).toContain(s);
    }
  });
});
