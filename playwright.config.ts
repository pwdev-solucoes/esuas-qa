import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// `package.json` é "type": "module": `__dirname` não existe em ESM.
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(CONFIG_DIR,'.env.e2e') });

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL ?? 'http://localhost:4174';
const IS_CI = !!process.env.CI;

/**
 * Project das etapas da massa fictícia (#10994): etapas em ordem, sem retry silencioso (determinismo),
 * sem storageState e sem depender do `setup`. Só roda pelo CLI (`npm run massa`), que faz preflight,
 * trava de produção e reset ANTES de chamar o Playwright.
 *
 * - `trace`, `video` e `screenshot` DESLIGADOS (CR-001, RN-T7): o trace do Playwright grava todo
 *   `APIRequestContext` do teste — corpo do login (`cpf`/`password`), tokens de redefinição, cookie e
 *   XSRF — em texto puro, fora do alcance do `sanitizar()`. Os passos sanitizados ficam no estado e no
 *   relatório de evidências. NUNCA religue (há teste em `lib/infra.test.ts` que falha se religar).
 * - Registrado só com a execução marcada pelo CLI (`MASSA_VIA_CLI`) ou com um estado explícito
 *   (`MASSA_EXECUCAO_ARQUIVO`, ex.: o `e01-e09.check.spec.ts`): `npm test` comum não coleta as etapas (CR-004).
 */
export const PROJECT_MASSA_DADOS = {
  name: 'massa-dados',
  testDir: './massa-dados/etapas',
  testMatch: /e\d+[a-z]?-.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  use: {
    baseURL: process.env.CLIENT_URL ?? 'http://localhost:5174',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
} as const;

const MASSA_EXECUCAO_MARCADA = Boolean(process.env.MASSA_VIA_CLI || process.env.MASSA_EXECUCAO_ARQUIVO);

/**
 * Playwright configuration para SigSUAS E2E & Acceptance Testing
 *
 * Projects:
 * - setup: Autentica e gera storage states (super-admin + tenant user)
 * - chromium: Testa admin (super-admin), todos os specs EXCETO client/*
 * - chromium-tenant: Testa client (tenant), specs em tests/client/
 * - massa-dados: etapas da massa fictícia (#10994), só via `npm run massa` (registrado só com MASSA_VIA_CLI/MASSA_EXECUCAO_ARQUIVO)
 * - massa-insumos: testes unitários/integração da massa (massa-dados/{scripts,lib}/*.test.ts), sem browser
 *
 * Rodando: npm test (tudo) | npm run test:admin | npm run test:client
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',
  // Só registra o global setup quando ele existe na raiz (hoje vive em e2e/); sem isso nenhum
  // project roda a partir desta config.
  globalSetup: existsSync(path.resolve(CONFIG_DIR, 'global-setup.ts')) ? './global-setup.ts' : undefined,

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
    // Massa fictícia (#10994): só registrado quando o CLI marcou a execução (CR-004) — ver `PROJECT_MASSA_DADOS`.
    ...(MASSA_EXECUCAO_MARCADA ? [PROJECT_MASSA_DADOS] : []),
    {
      // Testes unitários/integração da massa (geradores de insumos e infra do executor), sem browser.
      name: 'massa-insumos',
      testDir: './massa-dados',
      testMatch: /[\\/](scripts|lib)[\\/][^\\/]+\.test\.ts$/,
      fullyParallel: false,
      workers: 1,
      retries: 0,
      use: { trace: 'off', video: 'off', screenshot: 'off' },
    },
  ],
});
