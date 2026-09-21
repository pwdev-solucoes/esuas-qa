import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '.env.e2e') });

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL ?? 'http://localhost:4174';
const IS_CI = !!process.env.CI;

/**
 * Playwright configuration para SigSUAS E2E & Acceptance Testing
 *
 * Projects:
 * - setup: Autentica e gera storage states (super-admin + tenant user)
 * - chromium: Testa admin (super-admin), todos os specs EXCETO client/*
 * - chromium-tenant: Testa client (tenant), specs em tests/client/
 *
 * Rodando: npm test (tudo) | npm run test:admin | npm run test:client
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',
  globalSetup: './global-setup.ts',

  // Paralelo desativado por compatibilidade com DatabaseSeeder (Pest+Playwright)
  fullyParallel: false,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  workers: IS_CI ? 2 : undefined,

  // Timeouts
  timeout: 60_000,
  expect: { timeout: 5_000 },
  globalTimeout: 15 * 60 * 1000,

  // Reporters
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
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/super-admin.json',
      },
      dependencies: ['setup'],
      testIgnore: [/.*\.setup\.ts/, /[\\/]tests[\\/]client[\\/]/],
    },
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
