import { expect } from '@playwright/test';
import { test } from '../../fixtures/auth';

/**
 * Smoke RBAC: confirma que listagem e detalhe de perfis (roles Spatie)
 * estão acessíveis ao super-admin e que a API de roles responde.
 *
 * A primeira onda foca em provar:
 *   1) Super-admin lista roles
 *   2) Endpoints /api/roles e /api/permissions retornam 200
 *   3) Página /app/perfis renderiza sem erro
 *
 * Atribuição/revogação granular de permissões e teste de bloqueio com
 * usuário sem permissão ficam para a onda seguinte (depende de seed
 * de um segundo usuário com role limitada — não previsto no E2ESeeder atual).
 */
test.describe('RBAC — listagem de perfis', () => {
  test('super-admin lista roles via /app/perfis', async ({ page }) => {
    await page.goto('/app/perfis');
    await expect(page).toHaveURL(/\/app\/perfis/);
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('API /api/roles responde 200 e retorna array', async ({ apiClient }) => {
    const response = await apiClient.get<{ data: unknown[] }>('/roles');
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data.length).toBeGreaterThan(0);
  });

  test('API /api/permissions responde 200', async ({ apiClient }) => {
    const response = await apiClient.get<{ data: unknown[] }>('/permissions');
    expect(Array.isArray(response.data)).toBe(true);
  });
});
