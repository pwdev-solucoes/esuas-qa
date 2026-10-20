import { test, expect, type Page } from '@playwright/test';
import * as path from 'node:path';
import {
  CLIENT_BASE_URL,
  TENANT_UUID,
  loginAsTenantUser,
} from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * HU #11158 — CA09 (data de nascimento futura no Novo Profissional) e CA10 (sem área em branco
 * abaixo do rodapé). Project `chromium-tenant`; o Novo Profissional é exclusivo do Master, então
 * cada describe faz UM login do Master no `beforeAll` (logar teste a teste estoura o throttle).
 */

const CPF = process.env.E2E_CLIENT_MASTER_CPF;
const PASS = process.env.E2E_CLIENT_MASTER_PASSWORD;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const NOVO = '/app/cadastros/profissionais-municipais/novo';
const MSG = 'A data de nascimento deve ser anterior à data de hoje.';

function evidencePath(name: string): string {
  const dir = process.env.E2E_EVIDENCE_DIR;
  return dir ? path.join(dir, name) : test.info().outputPath(name);
}

function isoDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function apiHeaders(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  const token = await page.evaluate(() => window.localStorage.getItem('app-token'));
  return {
    Accept: 'application/json',
    Origin: CLIENT_BASE_URL,
    Referer: `${CLIENT_BASE_URL}/app`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Tenant-UUID': TENANT_UUID,
    'X-XSRF-TOKEN': xsrf,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function gotoNovo(page: Page): Promise<void> {
  await page.goto(NOVO);
  await dismissPlatformUpdates(page);
  await expect(page.locator('form')).toBeVisible();
}

for (const locale of ['en-US', 'pt-BR'] as const) {
  test.describe(`CA09 — data de nascimento futura (navegador ${locale})`, () => {
    test.describe.configure({ mode: 'serial' });
    test.use({ locale });
    test.skip(!CPF || !PASS, 'Defina E2E_CLIENT_MASTER_CPF/E2E_CLIENT_MASTER_PASSWORD.');

    let page: Page;

    test.beforeAll(async ({ browser }) => {
      const context = await browser.newContext({ locale, baseURL: CLIENT_BASE_URL });
      page = await context.newPage();
      await loginAsTenantUser(page, CPF!, PASS!);
    });
    test.afterAll(async () => {
      await page?.context().close();
    });

    test('data de amanhã: nenhuma requisição, texto da tela, aria-invalid e form novalidate', async () => {
      const posts: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/client\/professionals/.test(r.url())) posts.push(r.url());
      });
      await gotoNovo(page);

      const date = page.locator('input[type="date"]').first();
      await expect(date).toHaveAttribute('max', isoDay(0));
      expect(await page.locator('form').evaluate((f: HTMLFormElement) => f.noValidate)).toBe(true);

      await date.fill(isoDay(1));
      await page.getByRole('button', { name: /Salvar profissional/i }).click();

      await expect(page.getByText(MSG)).toBeVisible();
      await expect(date).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('body')).not.toContainText(/Value must be|earlier/i);
      expect(posts).toHaveLength(0);
      await page.screenshot({ path: evidencePath(`CA09-nascimento-futuro-${locale}.png`) });

      // Data passada: a mensagem some.
      await date.fill(isoDay(-1));
      await expect(page.getByText(MSG)).toHaveCount(0);
    });

    test('API: POST client/professionals com nascimento de amanhã devolve 422 com o mesmo texto', async () => {
      const headers = await apiHeaders(page);
      const res = await page.request.post(`${API_BASE}/api/client/professionals`, {
        headers,
        data: {
          cpf: '39053344705',
          full_name: 'Teste Nascimento Futuro',
          birth_date: isoDay(1),
          email: `futuro-${Date.now()}@e2e.local`,
          phone: '82999990000',
          registration_number: 'MAT-11158',
        },
      });
      expect(res.status()).toBe(422);
      const body = await res.json();
      expect(body.errors.birth_date[0]).toBe(MSG);
    });
  });
}

test.describe('CA10 — sem área em branco abaixo do rodapé', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!CPF || !PASS, 'Defina E2E_CLIENT_MASTER_CPF/E2E_CLIENT_MASTER_PASSWORD.');

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: CLIENT_BASE_URL });
    page = await context.newPage();
    await loginAsTenantUser(page, CPF!, PASS!);
  });
  test.afterAll(async () => {
    await page?.context().close();
  });

  async function assertNoBlankArea(label: string): Promise<void> {
    await expect(page.locator('form')).toBeVisible();
    await expect(page.getByText(/Versão/).last()).toBeVisible();
    const m = await page.evaluate(() => {
      const se = document.scrollingElement!;
      const footer = [...document.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && /Versão/.test(e.textContent ?? ''))
        .pop();
      return {
        scrollHeight: se.scrollHeight,
        innerHeight: window.innerHeight,
        footerBottom: footer ? footer.getBoundingClientRect().bottom : -1,
      };
    });
    expect(m.scrollHeight, `${label}: scrollHeight`).toBeLessThanOrEqual(m.innerHeight + 1);
    expect(m.footerBottom, `${label}: base do rodapé`).toBeGreaterThanOrEqual(m.innerHeight - 1);
    await page.screenshot({ path: evidencePath(`CA10-${label}.png`) });
  }

  for (const vp of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    test(`Novo Profissional ${vp.width}x${vp.height}`, async () => {
      await page.setViewportSize(vp);
      await gotoNovo(page);
      await assertNoBlankArea(`novo-${vp.width}`);
    });
  }

  test('Editar Profissional 1440x900', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoNovo(page);
    const headers = await apiHeaders(page);
    const list = await page.request.get(`${API_BASE}/api/client/professionals?per_page=1`, { headers });
    expect(list.status()).toBe(200);
    const uuid = (await list.json()).data?.[0]?.uuid as string | undefined;
    test.skip(!uuid, 'Sem profissional na massa para abrir o Editar.');
    await page.goto(`/app/cadastros/profissionais-municipais/${uuid}/editar`);
    await dismissPlatformUpdates(page);
    await assertNoBlankArea('editar-1440');
  });
});
