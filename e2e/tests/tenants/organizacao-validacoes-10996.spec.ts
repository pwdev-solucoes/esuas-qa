import { test, expect } from '../../fixtures/auth';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import * as path from 'node:path';
import { TenantsListPage } from '../../pages/tenants/TenantsListPage';
import { TenantFormSheet } from '../../pages/tenants/TenantFormSheet';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';
import { generateCpf } from '../../helpers/cpf';

/**
 * HU #10996 · US-10996-01 — validações e mensagens no cadastro da organização
 * e dos usuários (Painel Global). Um teste por CA da spec (`A-CA01`…`A-CA08`).
 *
 * - A-CA05 NÃO SE APLICA (D02): no Painel do Tenant a Razão Social e o Nome
 *   Fantasia são somente leitura; só o Global edita. O telefone do tenant é
 *   coberto por Pest (`TenantSettingPhoneTest`), sem tela.
 * - Massa fictícia por API; nada de CPF/senha literal (credenciais via env).
 * - O 422 do servidor é conferido por API; a mensagem local, pela tela.
 */

const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8090';
const ADMIN_ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const API_STATE = path.resolve(__dirname, '..', '..', '.auth', 'api-client.json');

type ApiResult = { status: number; body: any };

async function newAdminApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: API_BASE,
    storageState: API_STATE,
    extraHTTPHeaders: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: ADMIN_ORIGIN,
      Referer: `${ADMIN_ORIGIN}/app`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Locale': 'pt_BR',
    },
  });
}

async function send(
  api: APIRequestContext,
  method: 'POST' | 'PUT' | 'DELETE' | 'GET',
  endpoint: string,
  data?: unknown,
): Promise<ApiResult> {
  const state = await api.storageState();
  const xsrf = decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
  const res = await api.fetch(`/api${endpoint}`, { method, data, headers: { 'X-XSRF-TOKEN': xsrf } });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { status: res.status(), body };
}

const WEIGHTS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const WEIGHTS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** CNPJ válido; `alfanumerico` usa A-Z nas 12 primeiras posições (valor = código ASCII − 48). */
function generateCnpj(alfanumerico = false): string {
  const alphabet = alfanumerico ? '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '0123456789';
  const base = Array.from({ length: 12 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]);
  // Garante ao menos uma letra no alfanumérico.
  if (alfanumerico) base[0] = 'A';
  const value = (ch: string): number => ch.charCodeAt(0) - 48;
  const dv = (chars: string[], weights: number[]): string => {
    const sum = chars.reduce((acc, ch, i) => acc + value(ch) * weights[i], 0);
    const mod = sum % 11;

    return String(mod < 2 ? 0 : 11 - mod);
  };
  const d1 = dv(base, WEIGHTS_1);
  const d2 = dv([...base, d1], WEIGHTS_2);

  return [...base, d1, d2].join('');
}

/** Com `E2E_EVIDENCE_DIR` as capturas vão para o dossiê de aceite; sem ele, para o outputDir do teste. */
function evidencePath(name: string): string {
  const dir = process.env.E2E_EVIDENCE_DIR;

  return dir ? path.join(dir, name) : test.info().outputPath(name);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function today(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');

  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.describe.configure({ mode: 'serial' });

test.describe('US-10996-01 — organização no Painel Global', () => {
  const suffix = `${Date.now().toString(36)}`;
  let api: APIRequestContext;
  let statusId: number;
  const createdTenantIds: number[] = [];
  const createdUserIds: number[] = [];

  function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      legal_name: `Fundo Teste ${suffix}`,
      cnpj: generateCnpj(),
      email: `org-${suffix}@e2e.local`,
      status_id: statusId,
      timezone: 'America/Maceio',
      ...overrides,
    };
  }

  async function create(overrides: Record<string, unknown> = {}): Promise<ApiResult> {
    const res = await send(api, 'POST', '/tenants', payload(overrides));
    if (res.status === 201) createdTenantIds.push(res.body.data.id);

    return res;
  }

  test.beforeAll(async () => {
    api = await newAdminApi();
    const list = await send(api, 'GET', '/tenants?per_page=1');
    statusId = Number(list.body?.data?.[0]?.status_id ?? list.body?.data?.[0]?.status?.id ?? 1);
  });

  test.afterAll(async () => {
    for (const id of createdTenantIds) {
      await send(api, 'DELETE', `/tenants/${id}`);
    }
    for (const id of createdUserIds) {
      await send(api, 'DELETE', `/users/${id}`);
    }
    await api.dispose();
  });

  test('A-CA01 — Razão Social com pontuação usual é aceita e gravada como informada', async ({ page }) => {
    const legalName = `Fundo Municipal de Assistência Social - FMAS / Pref. de Teste & Região ${suffix}`;
    const list = new TenantsListPage(page);
    const sheet = new TenantFormSheet(page);

    await list.goto();
    await dismissPlatformUpdates(page);
    await list.openCreateForm();
    await sheet.fill({
      legalName,
      cnpj: generateCnpj(),
      email: `a-ca01-${suffix}@e2e.local`,
      timezone: 'America/Maceio',
    });
    // O status é um Select do shadcn (não mais <select> nativo).
    await page.locator('#t-status').click();
    await page.getByRole('option').first().click();
    await sheet.save();

    await list.searchInput.fill(legalName);
    await expect(list.row(legalName)).toBeVisible({ timeout: 10_000 });
    await expect(list.row(legalName)).toContainText('FMAS / Pref. de Teste & Região');
    await page.screenshot({ path: evidencePath('A-CA01-razao-social-pontuacao.png') });

    // Gravado exatamente como informado (conferência pela API).
    const found = await send(api, 'GET', `/tenants?search=${encodeURIComponent(legalName)}`);
    const row = (found.body?.data ?? []).find((t: any) => t.legal_name === legalName);
    expect(row, 'a organização criada pela tela existe com o nome idêntico').toBeTruthy();
    createdTenantIds.push(row.id);
  });

  test('A-CA01b — Apóstrofo nas três formas é gravado sem normalização', async () => {
    for (const legalName of [`d'Água ${suffix}`, `D\`ÁGUA ${suffix}`, `d’Arca ${suffix}`]) {
      const res = await create({ legal_name: legalName });
      expect(res.status, `legal_name ${legalName}`).toBe(201);
      expect(res.body.data.legal_name).toBe(legalName);
    }
  });

  test('A-CA01c — Sinal fora da lista é recusado com a lista dos sinais aceitos', async () => {
    const res = await create({ legal_name: 'Secretaria de Assistência Social [Antiga]' });
    expect(res.status).toBe(422);
    expect(res.body.errors.legal_name[0]).toContain('aceita apenas letras, números, espaços e os sinais');
  });

  test('A-CA02 / A-CA03 — Nome sem letras é recusado na tela e na API', async ({ page }) => {
    // "@#$%" também fere a lista de sinais: o servidor recusa (422) com a mensagem dos sinais, que
    // tem precedência sobre "precisa conter letras" (desvio do texto literal do CA, registrado no
    // relatório). A mensagem de "sem letras" é conferida com um nome de caracteres permitidos.
    const apiSymbols = await create({ legal_name: '@#$%' });
    expect(apiSymbols.status).toBe(422);
    expect(apiSymbols.body.errors.legal_name).toBeTruthy();

    const apiLegal = await create({ legal_name: '123 - 456' });
    expect(apiLegal.status).toBe(422);
    expect(apiLegal.body.errors.legal_name[0]).toMatch(/precisa conter letras/i);

    const apiTrade = await create({ trade_name: '---' });
    expect(apiTrade.status).toBe(422);
    expect(apiTrade.body.errors.trade_name[0]).toMatch(/precisa conter letras/i);

    const list = new TenantsListPage(page);
    const sheet = new TenantFormSheet(page);
    await list.goto();
    await dismissPlatformUpdates(page);
    await list.openCreateForm();
    await sheet.legalNameInput.fill('123 - 456');
    await sheet.tradeNameInput.fill('---');
    await sheet.saveButton.click();

    await expect(page.getByText('A razão social precisa conter letras.')).toBeVisible();
    await expect(page.getByText('O nome fantasia precisa conter letras.')).toBeVisible();
    await expect(sheet.sheet).toBeVisible();
    await page.screenshot({ path: evidencePath('A-CA02-nome-sem-letras.png') });
  });

  test('A-CA04 / A-CA04b — Telefone com caractere inválido ou quantidade errada é recusado', async ({ page }) => {
    for (const phone of ['(82) 9A999-0000', '82#999990000']) {
      const res = await create({ phone });
      expect(res.status, phone).toBe(422);
      expect(res.body.errors.phone[0]).toMatch(/apenas n[úu]meros/i);
    }
    const short = await create({ phone: '123' });
    expect(short.status).toBe(422);
    expect(short.body.errors.phone).toBeTruthy();

    // Máscara é aceita e só os dígitos persistem.
    const fixo = await create({ phone: '(82) 3333-4444' });
    expect(fixo.status).toBe(201);
    expect(fixo.body.data.phone).toBe('8233334444');
    const celular = await create({ phone: '(82) 99999-0000' });
    expect(celular.status).toBe(201);
    expect(celular.body.data.phone).toBe('82999990000');

    // Tela: telefone curto é barrado localmente.
    const list = new TenantsListPage(page);
    const sheet = new TenantFormSheet(page);
    await list.goto();
    await dismissPlatformUpdates(page);
    await list.openCreateForm();
    await sheet.legalNameInput.fill(`Fundo Teste ${suffix}`);
    await sheet.phoneInput.fill('8299');
    await sheet.saveButton.click();
    await expect(page.getByText('O telefone deve ter 10 ou 11 dígitos, com DDD.')).toBeVisible();
    await page.screenshot({ path: evidencePath('A-CA04-telefone-invalido.png') });
  });

  test('A-CA06 — CNPJ alfanumérico válido continua aceito', async () => {
    const res = await create({ cnpj: generateCnpj(true), legal_name: `Fundo Alfa ${suffix}` });
    expect(res.status).toBe(201);
    expect(res.body.data.cnpj).toMatch(/[A-Z]/);
  });

  test('A-CA07 — Vínculo de gestor conclui com organização de nome longo', async ({ page }) => {
    const longName =
      `Secretaria Municipal de Assistência Social, Trabalho e Direitos Humanos - Fundo Municipal (FMAS) / ` +
      `Gestão Integrada & Cooperação Intergovernamental da Rede Socioassistencial ${suffix}`;
    expect(longName.length).toBeGreaterThan(150);
    const org = await create({ legal_name: longName });
    expect(org.status).toBe(201);

    const cpf = generateCpf();
    const user = await send(api, 'POST', '/users', {
      full_name: `Gestor Teste ${suffix}`,
      email: `gestor-${suffix}@e2e.local`,
      cpf,
      birth_date: '1985-05-05',
      type: 'client',
    });
    expect(user.status).toBe(201);
    createdUserIds.push(user.body.data.id);
    const userUuid = user.body.data.uuid;

    await page.goto(`/app/usuarios/${userUuid}?tab=bindings`);
    await dismissPlatformUpdates(page);
    await page.getByRole('button', { name: 'Adicionar vínculo' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Selecione a organização...' }).click();
    await page.locator('input[placeholder^="Buscar por nome"]').fill(suffix);
    const option = page.getByRole('listbox').getByRole('option').filter({ hasText: 'Gestão Integrada' }).filter({ hasText: suffix }).first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    // Nome truncado na linha; o nome completo fica no title.
    await expect(option.locator('span[title]')).toHaveAttribute('title', new RegExp(`^${escapeRe(longName)}`));
    await option.click();
    await expect(dialog.locator('button span[title]').first()).toHaveAttribute(
      'title',
      new RegExp(`^${escapeRe(longName)}`),
    );

    // Os controles do diálogo seguem visíveis e dentro da janela.
    const confirm = dialog.getByRole('button', { name: /^adicionar$/i });
    const cancel = dialog.getByRole('button', { name: /^cancelar$/i });
    await expect(confirm).toBeVisible();
    await expect(cancel).toBeVisible();
    await expect(confirm).toBeInViewport();
    await page.screenshot({ path: evidencePath('A-CA07-vinculo-nome-longo.png') });

    // Conclui o vínculo escolhendo um perfil (Select do shadcn).
    await dialog.getByRole('combobox').click();
    await page.getByRole('option').first().click();
    await confirm.click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await page.screenshot({ path: evidencePath('A-CA07-vinculo-concluido.png') });
  });

  test('A-CA08 — Data de nascimento futura sai em português, sem "today"', async ({ page }) => {
    const amanha = today(1);
    const res = await send(api, 'POST', '/users', {
      full_name: `Gestor Futuro ${suffix}`,
      email: `futuro-${suffix}@e2e.local`,
      cpf: generateCpf(),
      birth_date: amanha,
      type: 'client',
    });
    expect(res.status).toBe(422);
    const message = res.body.errors.birth_date[0] as string;
    expect(message).toBe('A data de nascimento deve ser anterior à data de hoje.');
    expect(message).not.toMatch(/today/i);

    // Tela: o campo já limita a data máxima a hoje.
    await page.goto('/app/usuarios-organizacoes');
    await dismissPlatformUpdates(page);
    await page.getByRole('button', { name: /novo|nova|adicionar|cadastrar/i }).first().click();
    await expect(page.locator('#ou-birth-date')).toHaveAttribute('max', today());
    await page.screenshot({ path: evidencePath('A-CA08-nascimento-max.png') });
  });
});
