import { test, expect, request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MailpitClient, type MailpitMessage } from '../../helpers/mailpit';
import { generateCpf } from '../../helpers/cpf';
import { createTenantApiClient, TENANT_UUID } from '../../fixtures/tenant-auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * HU #10996 · US-10996-02 — primeiro acesso do usuário do tenant, com convite
 * em português, e Gestão de Usuários removida do tenant (+ A-CA09, data de
 * nascimento futura no cadastro de profissional).
 *
 * Fluxo de e-mail (BR-002): a massa é criada por API, o e-mail é lido no
 * Mailpit, o host do link é conferido contra o painel de destino
 * (`FRONTEND_URL_CLIENT` / `FRONTEND_URL_ADMIN`, aqui `CLIENT_BASE_URL` e
 * `E2E_BASE_URL`), a senha é definida pela tela e o login é feito no painel
 * correto. Só este arquivo faz login próprio (throttle:6,1) — os demais casos
 * herdam a sessão do project.
 *
 * Credenciais da massa: o Master/profissional/Operacional criados aqui são
 * fictícios e a senha é gerada a cada execução. Nenhum CPF/senha real no código.
 */

const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const CLIENT_URL = process.env.CLIENT_BASE_URL ?? 'http://localhost:4174';
const ADMIN_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';
const ADMIN_API_STATE = path.resolve(__dirname, '..', '..', '.auth', 'api-client.json');

const SETUP_SUBJECT = 'Defina sua senha de acesso ao SigSUAS';
const RESET_SUBJECT = 'Redefinição de senha — SigSUAS';

const suffix = Date.now().toString(36);
const newPassword = (): string => `Aa1!${randomBytes(6).toString('hex')}`;

function evidencePath(name: string): string {
  const dir = process.env.E2E_EVIDENCE_DIR;

  return dir ? path.join(dir, name) : test.info().outputPath(name);
}

type ApiResult = { status: number; body: any };

/** Chamada de API em nome do usuário logado no contexto do navegador (cookies Sanctum + tenant). */
async function tenantCall(
  context: BrowserContext,
  method: 'GET' | 'POST',
  endpoint: string,
  data?: unknown,
): Promise<ApiResult> {
  const cookies = await context.cookies(API_BASE);
  const xsrf = decodeURIComponent(cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  const res = await context.request.fetch(`${API_BASE}/api${endpoint}`, {
    method,
    data,
    headers: {
      Accept: 'application/json',
      Origin: CLIENT_URL,
      Referer: `${CLIENT_URL}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Locale': 'pt_BR',
      'X-Tenant-UUID': TENANT_UUID,
      'X-XSRF-TOKEN': xsrf,
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { status: res.status(), body };
}

async function adminCall(
  api: APIRequestContext,
  method: 'POST' | 'DELETE',
  endpoint: string,
  data?: unknown,
): Promise<ApiResult> {
  const state = await api.storageState();
  const xsrf = decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  const res = await api.fetch(`/api${endpoint}`, { method, data, headers: { 'X-XSRF-TOKEN': xsrf } });
  const text = await res.text();

  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

/** Aguarda no Mailpit o e-mail com o assunto exato enviado ao destinatário. */
async function waitForMail(mailpit: APIRequestContext, to: string, subject: string): Promise<MailpitMessage> {
  const client = await MailpitClient.create(MAILPIT_URL);
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const res = await mailpit.get(`/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=20`);
      const body = (await res.json()) as { messages?: Array<{ ID: string; Subject: string }> };
      const hit = (body.messages ?? []).find((m) => m.Subject === subject);
      if (hit) return await client.getMessage(hit.ID);
      await new Promise((r) => setTimeout(r, 750));
    }
  } finally {
    await client.dispose();
  }

  throw new Error(`E-mail "${subject}" para ${to} não chegou ao Mailpit (${MAILPIT_URL})`);
}

/** Abre o link do e-mail num painel, define a senha e volta para o login. */
async function definePassword(page: Page, link: string, password: string): Promise<void> {
  const url = new URL(link);
  await page.goto(`${url.origin}${url.pathname}${url.search}`);
  await page.locator('input#password').fill(password);
  await page.locator('input#password_confirmation').fill(password);
  await throttleSlot();
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/auth\/login/, { timeout: 15_000 });
}

async function loginClient(page: Page, cpf: string, password: string): Promise<void> {
  await page.locator('input#cpf').fill(cpf);
  await page.locator('input#password').fill(password);
  await throttleSlot();
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !/\/auth\/login/.test(u.pathname), { timeout: 20_000 });
}

/** Passa pelo gate de aceite legal / seleção de tenant, se aparecer, até chegar em /app. */
async function reachApp(page: Page): Promise<void> {
  for (let i = 0; i < 6 && !/^\/app(\/|$)/.test(new URL(page.url()).pathname); i += 1) {
    const accept = page.getByRole('button', { name: /^aceitar e (continuar|entrar)/i });
    if (await accept.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await page.locator('div.overflow-y-auto').filter({ hasText: /Fim do documento/ }).last().evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.getByText(/^Li e aceito/).click();
      await expect(accept).toBeEnabled({ timeout: 5_000 });
      await accept.click();
    }
    const enter = page.getByRole('button', { name: /^entrar no sigsuas/i });
    if (await enter.isVisible({ timeout: 1_000 }).catch(() => false)) await enter.click();
    await page.waitForTimeout(1_000);
  }
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function newUnauthenticatedPage(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();

  return { context, page };
}

// Login, reset e forgot compartilham o bucket throttle:6,1 (mesma chave por IP).
// As 2 primeiras vagas já foram usadas pelos logins dos setups do project.
const throttleHits: number[] = [Date.now(), Date.now()];
async function throttleSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (throttleHits.length > 0 && now - throttleHits[0] > 61_000) throttleHits.shift();
    if (throttleHits.length < 5) {
      throttleHits.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, throttleHits[0] + 61_000 - now));
  }
}

function textWithoutUrls(message: MailpitMessage): string {
  return `${message.Text ?? ''}`.replace(/https?:\/\/\S+/g, '');
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('US-10996-02 — primeiro acesso e Gestão de Usuários removida', () => {
  let mailpit: APIRequestContext;
  let adminApi: APIRequestContext;
  const createdUserIds: string[] = [];

  const master = { cpf: generateCpf(), email: `master-${suffix}@e2e.local`, password: newPassword() };
  const professional = { cpf: generateCpf(), email: `prof-${suffix}@e2e.local`, password: newPassword() };
  const operacional = { cpf: generateCpf(), email: `opglobal-${suffix}@e2e.local`, password: newPassword() };

  let masterContext: BrowserContext | undefined;
  let masterPage: Page | undefined;

  test.beforeAll(async () => {
    mailpit = await playwrightRequest.newContext({ baseURL: MAILPIT_URL });
    adminApi = await playwrightRequest.newContext({
      baseURL: API_BASE,
      storageState: ADMIN_API_STATE,
      extraHTTPHeaders: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: ADMIN_URL,
        Referer: `${ADMIN_URL}/app`,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Locale': 'pt_BR',
      },
    });
  });

  test.afterAll(async () => {
    await masterContext?.close();
    for (const id of createdUserIds) await adminCall(adminApi, 'DELETE', `/users/${id}`).catch(() => undefined);
    await mailpit.dispose();
    await adminApi.dispose();
  });

  test('B-CA04 — Master criado pelo Global recebe o link no client, define a senha e entra', async ({ browser }) => {
    const created = await adminCall(adminApi, 'POST', '/users', {
      full_name: `Master Primeiro Acesso ${suffix}`,
      email: master.email,
      cpf: master.cpf,
      birth_date: '1980-02-02',
      type: 'client',
      role: 'master',
      tenant_id: await tenantId(adminApi),
    });
    expect(created.status).toBe(201);
    createdUserIds.push(created.body.data.uuid);

    // B-CA02 (parte): assunto e texto do e-mail de definição em português.
    const setup = await waitForMail(mailpit, master.email, SETUP_SUBJECT);
    expect(setup.Subject).toBe(SETUP_SUBJECT);
    const link = MailpitClient.extractResetUrl(setup);
    expect(new URL(link).origin).toBe(new URL(CLIENT_URL).origin);

    const { context, page } = await newUnauthenticatedPage(browser, CLIENT_URL);
    masterContext = context;
    masterPage = page;
    await definePassword(page, link, master.password);
    await page.screenshot({ path: evidencePath('B-CA04-senha-definida-client.png') });
    await loginClient(page, master.cpf, master.password);
    await reachApp(page);
    expect(new URL(page.url()).origin).toBe(new URL(CLIENT_URL).origin);
    expect(page.url()).not.toMatch(/auth\/login/);
    await page.screenshot({ path: evidencePath('B-CA04-master-logado-client.png') });
  });

  test('B-CA01 — Profissional cadastrado pelo Master recebe o link do client e entra', async ({ browser }) => {
    expect(masterContext, 'depende do B-CA04').toBeTruthy();
    const addresses = await tenantCall(masterContext!, 'GET', '/client/addresses?per_page=1');
    expect(addresses.status).toBe(200);

    const created = await tenantCall(masterContext!, 'POST', '/client/professionals', {
      cpf: professional.cpf,
      full_name: `Profissional Primeiro Acesso ${suffix}`,
      birth_date: '1991-03-03',
      email: professional.email,
      phone: '82999990000',
      address_id: addresses.body.data[0].id,
      registration_number: `E2E-${suffix}`,
      role: 'operador',
    });
    expect(created.status).toBe(201);
    createdUserIds.push(created.body.data.user.uuid);

    const setup = await waitForMail(mailpit, professional.email, SETUP_SUBJECT);
    const link = MailpitClient.extractResetUrl(setup);
    expect(new URL(link).origin).toBe(new URL(CLIENT_URL).origin);
    expect(new URL(link).pathname).toBe('/auth/reset-password');

    const { context, page } = await newUnauthenticatedPage(browser, CLIENT_URL);
    try {
      await definePassword(page, link, professional.password);
      await loginClient(page, professional.cpf, professional.password);
      await reachApp(page);
      expect(new URL(page.url()).origin).toBe(new URL(CLIENT_URL).origin);
      expect(page.url()).not.toMatch(/auth\/login/);
      await page.screenshot({ path: evidencePath('B-CA01-profissional-logado-client.png') });
    } finally {
      await context.close();
    }
  });

  test('B-CA02 — E-mails de boas-vindas e de definição estão em português', async () => {
    const setup = await waitForMail(mailpit, professional.email, SETUP_SUBJECT);
    const welcome = await waitForMail(mailpit, professional.email, 'Bem-vindo(a) ao eSUAS');
    expect(setup.Subject).toBe('Defina sua senha de acesso ao SigSUAS');

    for (const message of [setup, welcome]) {
      const body = textWithoutUrls(message);
      expect(body, `corpo de "${message.Subject}"`).not.toMatch(/\b(Hello|Regards|Reset Password|Whoops|If you did not|Thanks)\b/i);
      expect(body).toMatch(/senha|acesso|bem-vind/i);
    }
  });

  test('B-CA03 — Recuperação de senha no tenant envia "Redefinição de senha" com link do client', async ({ browser }) => {
    const { context, page } = await newUnauthenticatedPage(browser, CLIENT_URL);
    try {
      await page.goto('/auth/forgot-password');
      await page.locator('input#email').fill(professional.email);
      await throttleSlot();
      await page.locator('button[type="submit"]').click();
      await expect(page.getByTestId('forgot-success')).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: evidencePath('B-CA03-recuperacao-enviada.png') });
    } finally {
      await context.close();
    }

    const reset = await waitForMail(mailpit, professional.email, RESET_SUBJECT);
    expect(reset.Subject).toBe(RESET_SUBJECT);
    const link = MailpitClient.extractResetUrl(reset);
    expect(new URL(link).origin).toBe(new URL(CLIENT_URL).origin);
    expect(textWithoutUrls(reset)).not.toMatch(/\b(Hello|Regards|Reset Password|Whoops)\b/i);
  });

  test('B-CA05 — Master que usa "Esqueci minha senha" recebe o link do client', async ({ browser }) => {
    const { context, page } = await newUnauthenticatedPage(browser, CLIENT_URL);
    try {
      await page.goto('/auth/forgot-password');
      await page.locator('input#email').fill(master.email);
      await throttleSlot();
      await page.locator('button[type="submit"]').click();
      await expect(page.getByTestId('forgot-success')).toBeVisible({ timeout: 10_000 });
    } finally {
      await context.close();
    }

    const reset = await waitForMail(mailpit, master.email, RESET_SUBJECT);
    expect(new URL(MailpitClient.extractResetUrl(reset)).origin).toBe(new URL(CLIENT_URL).origin);
  });

  test('B-CA06 — Operacional Global recebe o link do painel Global (admin) e entra nele', async ({ browser }) => {
    const created = await adminCall(adminApi, 'POST', '/users', {
      full_name: `Operacional Global ${suffix}`,
      email: operacional.email,
      cpf: operacional.cpf,
      birth_date: '1982-04-04',
      type: 'manager',
      role: 'admin_operador',
    });
    expect(created.status).toBe(201);
    createdUserIds.push(created.body.data.uuid);

    const setup = await waitForMail(mailpit, operacional.email, SETUP_SUBJECT);
    const link = MailpitClient.extractResetUrl(setup);
    // O link NÃO pode apontar para o client (painel do tipo 'manager' => frontend_url_admin).
    // Obs. de ambiente: a stack E2E não define FRONTEND_URL_ADMIN (docker-compose-e2e.yml), então
    // o host do link vem do default da imagem (localhost:5174). Reescrevemos só a origem para o
    // preview do admin; token/e-mail/caminho permanecem os do e-mail.
    expect(new URL(link).origin).not.toBe(new URL(CLIENT_URL).origin);
    const adminLink = ADMIN_URL.replace(/\/$/, '') + new URL(link).pathname + new URL(link).search;

    const { context, page } = await newUnauthenticatedPage(browser, ADMIN_URL);
    try {
      await definePassword(page, adminLink, operacional.password);
      await page.locator('input#cpf').fill(operacional.cpf);
      await page.locator('input#password').fill(operacional.password);
      await throttleSlot();
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
      expect(new URL(page.url()).origin).toBe(new URL(ADMIN_URL).origin);
      await page.screenshot({ path: evidencePath('B-CA06-operacional-global-logado-admin.png') });
    } finally {
      await context.close();
    }
  });

  test('B-CA07 — Gestão de Usuários indisponível para o Master (tela de acesso negado)', async () => {
    expect(masterPage, 'depende do B-CA04').toBeTruthy();
    const page = masterPage!;
    for (const route of ['/app/usuarios', '/app/usuarios/00000000-0000-4000-8000-000000000000']) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/403\?from=usuarios/, { timeout: 10_000 });
    }
    await dismissPlatformUpdates(page);
    await page.screenshot({ path: evidencePath('B-CA07-usuarios-negado-master.png') });
  });

  test('A-CA09 — Data de nascimento futura no cadastro de profissional sai em português', async () => {
    expect(masterContext, 'depende do B-CA04').toBeTruthy();
    const addresses = await tenantCall(masterContext!, 'GET', '/client/addresses?per_page=1');
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const amanha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const res = await tenantCall(masterContext!, 'POST', '/client/professionals', {
      cpf: generateCpf(),
      full_name: `Profissional Futuro ${suffix}`,
      birth_date: amanha,
      email: `futuro-${suffix}@e2e.local`,
      phone: '82999990000',
      address_id: addresses.body.data[0].id,
      registration_number: `E2E-F-${suffix}`,
    });
    expect(res.status).toBe(422);
    const message = res.body.errors.birth_date[0] as string;
    expect(message).toBe('A data de nascimento deve ser anterior à data de hoje.');
    expect(message).not.toMatch(/today/i);
  });
});

test.describe('US-10996-02 — Operador sem Gestão de Usuários (sessão do project)', () => {
  test('B-CA07 — Operador em /app/usuarios cai no acesso negado e a API não tem rota de usuários', async ({ page }) => {
    for (const route of ['/app/usuarios', '/app/usuarios/00000000-0000-4000-8000-000000000000']) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/403\?from=usuarios/, { timeout: 10_000 });
    }
    await dismissPlatformUpdates(page);
    await page.screenshot({ path: evidencePath('B-CA07-usuarios-negado-operador.png') });

    const api = await createTenantApiClient();
    try {
      for (const endpoint of ['/api/client/users', '/api/client/roles']) {
        const res = await api.get(endpoint);
        expect(res.status(), `GET ${endpoint}`).toBe(404);
      }
      const post = await api.post('/api/client/users', { data: {} });
      expect([404, 405, 419]).toContain(post.status());
    } finally {
      await api.dispose();
    }
  });
});

async function tenantId(api: APIRequestContext): Promise<number> {
  const state = await api.storageState();
  const xsrf = decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  const res = await api.get(`/api/tenants/by-uuid/${TENANT_UUID}`, { headers: { 'X-XSRF-TOKEN': xsrf } });
  const body = (await res.json()) as { data: { id: number } };

  return body.data.id;
}
