import { test as base } from '@playwright/test';
import { ApiClient } from './api-client';

/**
 * Estende o test do Playwright injetando:
 *   - apiClient: cliente HTTP autenticado (Sanctum) para seed/cleanup via API
 *
 * O storage state do super-admin é carregado automaticamente pela config
 * (project chromium → storageState: .auth/super-admin.json), então `page`
 * já vem logado nos specs que NÃO sobrescrevem o storageState.
 *
 * Uso:
 *   import { test, expect } from '../../fixtures/auth';
 *   test('faz X', async ({ page, apiClient }) => { ... });
 */
type AuthFixtures = {
  apiClient: ApiClient;
};

export const test = base.extend<AuthFixtures>({
  apiClient: async ({}, use) => {
    const client = await ApiClient.createAuthenticated();
    await use(client);
    await client.dispose();
  },
});

export { expect } from '@playwright/test';
