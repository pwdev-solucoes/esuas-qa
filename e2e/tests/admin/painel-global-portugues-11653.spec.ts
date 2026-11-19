import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * HU #11653 (Parte B, CA04) — Painel Global em português com o NAVEGADOR em inglês (`locale: 'en-US'`).
 * Spec MANUAL no project `chromium` (sessão do Administrador herdada; nenhum login). Percorre as telas da §17-B:
 * início, Organizações (lista e detalhe), um cadastro SUAS (tipos de atendimento) com tentativa de salvar vazio
 * (422 da API em pt-BR), Usuários das organizações, Auditoria da plataforma, página inexistente (404) e acesso
 * negado (403), as duas com o botão "Painel". Em cada tela, nenhum texto visível casa com palavras em inglês da
 * interface nem com chave crua de tradução. Somente leitura (a tentativa de salvar vazio não grava nada).
 * Prints só com CAPTURE_EVIDENCE=1, em `e2e/reports/11653-…-acceptance/screenshots/` (raiz do meta-repo).
 */

const SHOTS = path.resolve(
  __dirname,
  '..', '..', '..', '..',
  'e2e', 'reports', '11653-ajustes-pontuais-contrato-idioma-recebidos-acceptance', 'screenshots',
);

const ENGLISH = /\b(Dashboard|Close|Loading|Save|Cancel|Search|No results)\b/;
const RAW_KEY = /\b[a-z_]+\.[a-z_]+\.[a-z_]+\b/;

test.use({ locale: 'en-US', viewport: { width: 1440, height: 900 } });

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.CAPTURE_EVIDENCE !== '1') return;
  await fs.promises.mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await dismissPlatformUpdates(page);
  await expect(page, 'sessão do Administrador ativa (sem cair no login)').not.toHaveURL(/\/auth\/login/);
  await page.waitForTimeout(1500);
}

async function expectPortuguese(page: Page): Promise<void> {
  const text = await page.locator('body').innerText();
  expect(text, 'texto visível sem palavras em inglês da interface').not.toMatch(ENGLISH);
  expect(text, 'texto visível sem chave crua de tradução').not.toMatch(RAW_KEY);
}

test.describe('HU #11653 — CA04 Painel Global em português (navegador en-US)', () => {
  test('o navegador está de fato em inglês', async ({ page }) => {
    await visit(page, '/app');
    expect(await page.evaluate(() => navigator.language)).toBe('en-US');
  });

  for (const [name, url, shotName] of [
    ['início', '/app', 'CA04-inicio'],
    ['Organizações (lista)', '/app/tenants', 'CA04-organizacoes'],
    ['Usuários das organizações', '/app/usuarios-organizacoes', 'CA04-usuarios'],
    ['Auditoria da plataforma', '/app/platform-audits', 'CA04-auditoria'],
  ] as const) {
    test(`${name}: tudo em português`, async ({ page }) => {
      await visit(page, url);
      await expectPortuguese(page);
      await shot(page, shotName);
    });
  }

  test('Organizações (detalhe): tudo em português', async ({ page }) => {
    const tenant = process.env.E2E_TENANT_UUID ?? '00000000-0000-4000-8000-0000000000c1';
    await visit(page, `/app/tenants/${tenant}`);
    await expect(page).toHaveURL(/\/app\/tenants\/[0-9a-f-]{36}/);
    await page.waitForTimeout(1500);
    await expectPortuguese(page);
    await shot(page, 'CA04-detalhe-organizacao');
  });

  test('cadastro SUAS vazio: a validação devolvida pela API vem em português e o X é "Fechar"', async ({ page }) => {
    await visit(page, '/app/attendance-types');
    await page.getByRole('button', { name: /^(novo|nova|adicionar|cadastrar)/i }).first().click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    // Acessibilidade: o botão de fechar do drawer se chama "Fechar" (antes "Close").
    const snapshot = await dialog.ariaSnapshot();
    expect(snapshot).toContain('button "Fechar"');
    expect(snapshot).not.toContain('button "Close"');
    await shot(page, 'CA04-drawer-fechar');

    await dialog.getByRole('button', { name: /^salvar$/i }).click();
    await page.waitForTimeout(2000);
    const text = await page.locator('body').innerText();
    expect(text).toMatch(/obrigat|preench|informe|inválid/i);
    expect(text).not.toMatch(/\b(is required|field is required|The .* field)\b/i);
    expect(text).not.toMatch(ENGLISH);
    await shot(page, 'CA04-validacao-api-pt-br');
  });

  test('página inexistente (404) oferece "Painel" e o acesso negado (403) também', async ({ page }) => {
    await visit(page, '/app/rota-inexistente-11653');
    const painel = page.getByRole('button', { name: 'Painel' });
    await expect(painel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Dashboard')).toHaveCount(0);
    await expectPortuguese(page);
    await shot(page, 'CA04-pagina-nao-encontrada');
    await painel.click();
    await expect(page).toHaveURL(/\/app\/?$/);

    await visit(page, '/403');
    await expect(page.getByRole('button', { name: 'Painel' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Dashboard')).toHaveCount(0);
    await expectPortuguese(page);
    await shot(page, 'CA04-acesso-negado');
  });
});
