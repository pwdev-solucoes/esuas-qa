import { expect, test } from '@playwright/test';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { createTenantApiClient, loginAsTenantUser } from '../../fixtures/tenant-auth';

/**
 * US-DIAG2-01 (#11230) — CA07: o Master do tenant NÃO encontra onde editar os
 * nove domínios do diagnóstico completo.
 *
 * ## ⚠ Evidência de AUSÊNCIA
 *
 * Este caso prova que algo NÃO existe. O print é do menu do Painel do Tenant e
 * a legenda do dossiê é: "a evidência é a ausência — não há cadastro destes
 * domínios no Painel do Tenant". O cadastro é do Painel Global (`admin/`).
 *
 * ## O que prova
 *
 * 1. O menu lateral do tenant não tem entrada para nenhum dos nove domínios.
 * 2. As nove rotas (`/app/<recurso>`) caem na página 404 do tenant.
 * 3. Na API, a escrita com o token do tenant é recusada (o Pest garante o
 *    401 por rota; aqui só confirma de ponta a ponta, com o Master).
 *
 * Não depende do frontend do tenant desta HU: serve qualquer versão do
 * `client/` (que não ganha nenhuma tela de cadastro). Nada é alterado.
 */

const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? '';
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? '';

const DOMAINS = [
  'wall-materials',
  'electricity-access-types',
  'water-supply-types',
  'sanitation-types',
  'garbage-collection-types',
  'home-accessibility-types',
  'school-grades',
  'academic-titles',
  'occupation-conditions',
] as const;

const MENU_LABELS = [
  /Materiais das Paredes/i,
  /Acesso à Energia Elétrica/i,
  /Abastecimento de Água/i,
  /Escoamento Sanitário/i,
  /Coleta de Lixo/i,
  /Acessibilidade do Domic/i,
  /Séries Escolares/i,
  /Titulações Acadêmicas/i,
  /Condições de Ocupação/i,
];

test.describe('US-DIAG2-01 — ausência do cadastro dos domínios no Painel do Tenant (CA07)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });

  test('CA07 — o menu do tenant não tem os domínios e as rotas não existem', async ({ page }) => {
    expect(MASTER_CPF && MASTER_PASSWORD, 'E2E_CLIENT_MASTER_CPF/PASSWORD no ambiente').toBeTruthy();
    await loginAsTenantUser(page, MASTER_CPF, MASTER_PASSWORD);
    await page.goto('/app');
    await page.waitForLoadState('networkidle');
    await dismissPlatformUpdates(page);

    // 1. Menu: nenhuma entrada dos nove domínios.
    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible();
    for (const label of MENU_LABELS) {
      await expect(sidebar.getByText(label)).toHaveCount(0);
    }
    for (const route of DOMAINS) {
      await expect(page.locator(`a[href$="/app/${route}"]`)).toHaveCount(0);
    }
    await page.screenshot({ path: 'test-results/11230/CA07-ausencia.png' });

    // 2. Rotas: 404 do tenant (não existe tela de cadastro).
    for (const route of DOMAINS) {
      await page.goto(`/app/${route}`);
      await expect(
        page.getByRole('heading', { name: 'Página não encontrada' }),
        `/app/${route} deve ser 404 no tenant`,
      ).toBeVisible();
    }
  });

  test('CA07 — a API recusa a escrita com o token do tenant', async () => {
    const api = await createTenantApiClient();
    try {
      const state = await api.storageState();
      const token = state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '';
      const headers = { 'X-XSRF-TOKEN': decodeURIComponent(token) };

      // Leitura é compartilhada (D10); a escrita é só do Painel Global.
      const read = await api.get('/api/school-grades?per_page=1');
      expect(read.status()).toBe(200);
      const uuid = ((await read.json()) as { data: Array<{ uuid: string }> }).data[0]?.uuid;
      expect(uuid).toBeTruthy();

      const write = await api.put(`/api/school-grades/${uuid}`, {
        data: { is_active: true },
        headers,
      });
      expect(write.ok(), 'PUT com token de tenant não pode passar').toBeFalsy();
      expect([401, 403]).toContain(write.status());
    } finally {
      await api.dispose();
    }
  });
});
