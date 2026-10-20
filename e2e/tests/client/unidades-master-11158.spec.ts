import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import * as path from 'node:path';
import { CLIENT_BASE_URL, TENANT_UUID, createTenantApiClient, loginAsTenantUser } from '../../fixtures/tenant-auth';

/**
 * HU #11158 · RN08 / CA11 / CA12 — o Master cadastra e mantém unidades
 * socioassistenciais; nenhum papel do tenant exclui unidade (nem em lote).
 *
 * Sessão: o project chromium-tenant entrega o OPERADOR; o Master entra UMA vez
 * no beforeAll (throttle:6,1 nas rotas /auth/*). Sem as variáveis do Master o
 * describe inteiro é pulado. A unidade criada fica na base E2E (o tenant não
 * pode excluí-la) — por isso o nome leva sufixo único.
 */

const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF;
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD;

function evidencePath(name: string): string {
  const dir = process.env.E2E_EVIDENCE_DIR;

  return dir ? path.join(dir, name) : test.info().outputPath(name);
}

type Res = { status: number; body: any };

async function parse(res: { status(): number; text(): Promise<string> }): Promise<Res> {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  return { status: res.status(), body };
}

const apiHeaders = (xsrf: string) => ({
  Accept: 'application/json',
  Origin: CLIENT_BASE_URL,
  Referer: `${CLIENT_BASE_URL}/app`,
  'X-Requested-With': 'XMLHttpRequest',
  'X-Locale': 'pt_BR',
  'X-Tenant-UUID': TENANT_UUID,
  'X-XSRF-TOKEN': xsrf,
});

async function dismissPlatformUpdates(page: Page): Promise<void> {
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
}

test.describe.configure({ mode: 'serial' });

test.describe('HU #11158 — Master cadastra unidades; exclusão fechada (RN08)', () => {
  test.skip(!MASTER_CPF || !MASTER_PASSWORD, 'E2E_CLIENT_MASTER_CPF/PASSWORD não definidos');

  let masterCtx: BrowserContext;
  let masterPage: Page;
  let operadorApi: APIRequestContext;
  const unitName = `Unidade E2E 11158 ${Date.now().toString().slice(-6)}`;

  async function masterCall(method: 'GET' | 'POST', endpoint: string, data?: unknown): Promise<Res> {
    const cookies = await masterCtx.cookies(API_BASE);
    const xsrf = decodeURIComponent(cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');

    return parse(await masterCtx.request.fetch(`${API_BASE}${endpoint}`, { method, data, headers: apiHeaders(xsrf) }));
  }

  test.beforeAll(async ({ browser }) => {
    operadorApi = await createTenantApiClient();
    masterCtx = await browser.newContext({ baseURL: CLIENT_BASE_URL });
    masterPage = await masterCtx.newPage();
    await loginAsTenantUser(masterPage, MASTER_CPF!, MASTER_PASSWORD!);
  });

  test.afterAll(async () => {
    await operadorApi?.dispose();
    await masterCtx?.close();
  });

  test('CA11 — o Master vê "Nova Unidade", cadastra, edita, muda o status e vincula equipamento', async () => {
    const page = masterPage;
    await page.goto('/app/unidades');
    await dismissPlatformUpdates(page);

    const nova = page.getByRole('button', { name: 'Nova Unidade' });
    await expect(nova).toBeVisible();
    await page.screenshot({ path: evidencePath('AC-004-master-nova-unidade.png') });

    // Cadastro: nome, número MDS, tipo, status e tipo de localização.
    await nova.click();
    await page.locator('#su-name').fill(unitName);
    await page.locator('#su-mds').fill('MDS11158');
    const selects = page.locator('form#social-unit-form button[role="combobox"]');
    for (let i = 0; i < 3; i++) {
      await selects.nth(i).click();
      await page.getByRole('option').first().click();
    }
    await page.getByRole('button', { name: /Salvar|Cadastrar|Criar/ }).last().click();
    await expect(page.getByText('Unidade cadastrada com sucesso.')).toBeVisible();
    await expect(page.getByRole('button', { name: unitName })).toBeVisible();
    await page.screenshot({ path: evidencePath('AC-004-master-unidade-salva.png') });

    // Edição do nome.
    const edited = `${unitName} editada`;
    let row = page.getByRole('row').filter({ hasText: unitName }).first();
    await row.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: /Editar/ }).click();
    await page.locator('#su-name').fill(edited);
    await page.getByRole('button', { name: /Salvar/ }).last().click();
    await expect(page.getByRole('button', { name: edited })).toBeVisible();

    // Mudança de status.
    row = page.getByRole('row').filter({ hasText: edited }).first();
    const before = await row.innerText();
    await row.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: /Mudar status/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').click();
    await page.getByRole('option').nth(1).click();
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page.getByRole('row').filter({ hasText: edited }).first()).not.toHaveText(before);

    // Equipamento na aba Equipamentos do detalhe.
    await page.goto('/app/unidades');
    await dismissPlatformUpdates(page);
    await page.getByRole('button', { name: edited }).click();
    await page.getByRole('button', { name: 'Equipamentos' }).click();
    await page.getByRole('button', { name: 'Novo equipamento' }).click();
    const eq = page.getByRole('dialog');
    await eq.getByText('Selecione um equipamento').click();
    await page.getByRole('option').first().click();
    await eq.locator('#eq-qty').fill('2');
    await eq.locator('#eq-qty-use').fill('1');
    await eq.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Equipamento vinculado com sucesso.')).toBeVisible();
    await page.screenshot({ path: evidencePath('AC-004-master-equipamento.png') });
  });

  test('CA12 — API: /auth/me sem exclusão e bulk-destroy 403 para Master e Operador', async () => {
    const me = await masterCall('GET', '/api/client/auth/me');
    expect(me.status).toBe(200);
    const masterPerms = JSON.stringify(me.body);
    expect(masterPerms).toContain('social-units.store');
    expect(masterPerms).not.toContain('social-units.destroy');
    expect(masterPerms).not.toContain('social-units.bulk-destroy');

    const masterBulk = await masterCall('POST', '/api/client/social-units/bulk-destroy', {
      uuids: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(masterBulk.status).toBe(403);

    const state = await operadorApi.storageState();
    const xsrf = decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
    const opMe = await parse(await operadorApi.fetch(`${API_BASE}/api/client/auth/me`, { headers: apiHeaders(xsrf) }));
    expect(opMe.status).toBe(200);
    expect(JSON.stringify(opMe.body)).not.toContain('social-units.destroy');
    expect(JSON.stringify(opMe.body)).not.toContain('social-units.bulk-destroy');

    const opBulk = await parse(
      await operadorApi.fetch(`${API_BASE}/api/client/social-units/bulk-destroy`, {
        method: 'POST',
        data: { uuids: ['00000000-0000-4000-8000-000000000000'] },
        headers: apiHeaders(xsrf),
      }),
    );
    expect(opBulk.status).toBe(403);
  });

  test('CA12 — tela: menu de ações e barra de lote sem "Excluir"', async () => {
    const page = masterPage;
    await page.goto('/app/unidades');
    await dismissPlatformUpdates(page);

    const row = page.getByRole('row').filter({ hasText: unitName }).first();
    await row.getByRole('button', { name: 'Mais ações' }).click();
    await expect(page.getByRole('menuitem', { name: /Editar/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Excluir/ })).toHaveCount(0);
    await page.screenshot({ path: evidencePath('AC-005-sem-excluir.png') });
    await page.keyboard.press('Escape');

    await row.getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: /Mudar status|Alterar status/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Excluir/ })).toHaveCount(0);
  });
});
