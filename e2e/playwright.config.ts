import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'node:path';

/**
 * ADAPTADO PARA qa/ STANDALONE:
 * Carrega qa/.env.qa (não e2e/.env.e2e)
 */
const qaDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(qaDir, '.env.qa') });

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
/**
 * Frontend do TENANT (`client/`), servido em paralelo ao admin pelo
 * `scripts/start-stack.sh`. `CLIENT_BASE_URL` é o nome que os specs de
 * `tests/client/` já leem — não invente outro.
 */
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL ?? 'http://localhost:4174';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  workers: IS_CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  globalTimeout: 15 * 60 * 1000,
  reporter: IS_CI
    ? [
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['github'],
        ['junit', { outputFile: 'test-results/junit.xml' }],
      ]
    : [['html', { open: 'on-failure' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    /**
     * Super Admin (`admin/` em 4173). Tudo, MENOS `tests/client/` — que agora
     * roda no project `chromium-tenant`, com a sessão de tenant.
     */
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/super-admin.json',
      },
      dependencies: ['setup'],
      testIgnore: [/.*\.setup\.ts/, /[\\/]tests[\\/]client[\\/]/],
    },
    /**
     * Frontend do TENANT (`client/` em 4174), autenticado como o Operacional
     * do tenant E2E (ver `tests/tenant-auth.setup.ts`).
     *
     * ⚠️ Os specs herdam uma sessão JÁ ativa: `page.goto('/auth/login')` é
     * redirecionado para `/app` pelo guard `redirectIfAuthenticated`. Specs
     * que precisam de OUTRO usuário (master, sem lotação, sem add-on) devem
     * chamar `loginAsTenantUser()` de `fixtures/tenant-auth.ts`, que zera a
     * sessão herdada antes de autenticar.
     */
    {
      name: 'chromium-tenant',
      testDir: './tests/client',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: CLIENT_BASE_URL,
        storageState: '.auth/tenant.json',
      },
      dependencies: ['setup'],
    },
  ],
});
