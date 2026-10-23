import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { loginAsTenantUser, TENANT_UUID } from '../../fixtures/tenant-auth';

/**
 * US-VIOL-01 (HU #11290) — CA05: o Master do tenant NÃO encontra onde editar os
 * quatro domínios da proteção social especial.
 *
 * ## ⚠ Evidência de AUSÊNCIA
 * O print é do menu do Painel do Tenant e a legenda do dossiê é: "a evidência é
 * a ausência: não há cadastro destes domínios no Painel do Tenant". O cadastro
 * é do Painel Global (`admin/`).
 *
 * ## O que prova (um único login do Master)
 * 1. O menu lateral do tenant não tem entrada para nenhum dos quatro domínios.
 * 2. `/app/<recurso>` cai em "Página não encontrada".
 * 3. Com o token do Master da mesma sessão: `GET /api/<recurso>` → 200 (leitura
 *    compartilhada) e `PUT`/`POST`/`DELETE`/`bulk-*` → 401 (rotas do `manager`).
 * Nada é criado, alterado nem apagado.
 */

const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? '';
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? '';
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8000';
const SHOTS = path.resolve(
  __dirname,
  '..', '..', '..', '..',
  'e2e', 'reports', '11290-dominios-protecao-social-especial-acceptance', 'screenshots',
);

const DOMAINS = [
  'violence-history-situations',
  'violence-record-situations',
  'rights-guarantee-bodies',
  'socio-educational-measure-types',
] as const;

const MENU_LABELS = [
  /Proteção social especial/i,
  /Situações de Violência/i,
  /Órgãos de Garantia de Direitos/i,
  /Tipos de Medida Socioeducativa/i,
];

test.describe('US-VIOL-01 #11290 — ausência do cadastro dos domínios no Painel do Tenant (CA05)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });

  test('CA05 — o menu do tenant não tem os domínios, as rotas não existem e a escrita é recusada com a sessão do Master', async ({ page }) => {
    expect(MASTER_CPF && MASTER_PASSWORD, 'E2E_CLIENT_MASTER_CPF/PASSWORD no ambiente').toBeTruthy();
    await loginAsTenantUser(page, MASTER_CPF, MASTER_PASSWORD);
    await page.goto('/app');
    await page.waitForLoadState('networkidle');
    await dismissPlatformUpdates(page);

    // 1. Menu: nenhuma entrada dos quatro domínios.
    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible();
    for (const label of MENU_LABELS) {
      await expect(sidebar.getByText(label)).toHaveCount(0);
    }
    for (const route of DOMAINS) {
      await expect(page.locator(`a[href$="/app/${route}"]`)).toHaveCount(0);
    }
    if (process.env.CAPTURE_EVIDENCE === '1') {
      await fs.promises.mkdir(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, 'CA05-ausencia.png') });
    }

    // 2. Rotas: 404 do tenant (não existe tela de cadastro).
    for (const route of DOMAINS) {
      await page.goto(`/app/${route}`);
      await expect(
        page.getByRole('heading', { name: 'Página não encontrada' }),
        `/app/${route} deve ser 404 no tenant`,
      ).toBeVisible();
    }
    if (process.env.CAPTURE_EVIDENCE === '1') {
      await page.screenshot({ path: path.join(SHOTS, 'CA05-rota-404.png') });
    }

    // 3. API com a sessão do Master (o client é stateful: cookie Sanctum + XSRF, sem
    //    token em localStorage): lê, mas não escreve.
    const cookies = await page.context().cookies();
    const xsrf = decodeURIComponent(cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
    expect(xsrf, 'XSRF-TOKEN da sessão do Master').toBeTruthy();
    const origin = new URL(page.url()).origin;
    const headers = {
      Accept: 'application/json',
      Origin: origin,
      Referer: `${origin}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': xsrf,
      'X-Tenant-UUID': TENANT_UUID,
    };
    for (const route of DOMAINS) {
      const read = await page.request.get(`${API_BASE}/api/${route}?per_page=1`, { headers });
      expect(read.status(), `GET ${route}`).toBe(200);
      const uuid = ((await read.json()) as { data: Array<{ uuid: string }> }).data[0]?.uuid;
      expect(uuid, `${route}: item para tentar escrever`).toBeTruthy();

      const writes = [
        await page.request.post(`${API_BASE}/api/${route}`, { headers, data: { name: 'Teste', code: '98', display_order: 98 } }),
        await page.request.put(`${API_BASE}/api/${route}/${uuid}`, { headers, data: { is_active: true } }),
        await page.request.delete(`${API_BASE}/api/${route}/${uuid}`, { headers }),
        await page.request.post(`${API_BASE}/api/${route}/bulk-activate`, { headers, data: { uuids: [uuid] } }),
        await page.request.post(`${API_BASE}/api/${route}/bulk-deactivate`, { headers, data: { uuids: [uuid] } }),
      ];
      for (const res of writes) {
        expect(res.status(), `${route}: escrita com a sessão do tenant`).toBe(401);
      }
    }
  });
});
