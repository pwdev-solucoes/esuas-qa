import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '../../fixtures/auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * US-VIOL-01 (HU #11290) — os quatro domínios da proteção social especial no
 * Painel Global (`admin/`, guard `manager`): situações de violência (Quadro 1 e
 * Quadro 3), órgãos de garantia de direitos e tipos de medida socioeducativa.
 *
 * Spec MANUAL: CA01–CA04, CT03 (inativar/reativar) e CT05 (Operacional Global).
 * O E2E-029 (gerado) cobre o núcleo; a criação, a edição de dados e a exclusão
 * são provadas pelo Pest — código único inclui soft-deletados, então criar item
 * em E2E deixaria lixo e quebraria a reexecução.
 *
 * ## Estado — este spec ALTERA um dado global e RESTAURA
 * Inativa "Outra" (`'99'`) do Quadro 1 e a reativa; o `beforeAll` normaliza (caso
 * uma execução anterior tenha caído no meio) e o `afterAll` reativa pela API do
 * `manager`. Rodar duas vezes dá o mesmo resultado.
 *
 * Sessão do Administrador herdada (`chromium`); 1 login do Operacional Global.
 * Prints só com `CAPTURE_EVIDENCE=1`, direto na pasta do dossiê.
 */

const ADMIN_BASE = process.env.E2E_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8000';
const API_STATE = path.resolve(__dirname, '..', '..', '.auth', 'api-client.json');
const SHOTS = path.resolve(
  __dirname,
  '..', '..', '..', '..',
  'e2e', 'reports', '11290-dominios-protecao-social-especial-acceptance', 'screenshots',
);

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  if (process.env.CAPTURE_EVIDENCE !== '1') return;
  await fs.promises.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

const QUADRO1 = [
  'Trabalho infantil', 'Exploração sexual', 'Abuso ou violência sexual', 'Violência física',
  'Violência psicológica', 'Negligência contra idoso', 'Negligência contra criança',
  'Negligência contra pessoa com deficiência', 'Trajetória de rua', 'Tráfico de pessoas',
  'Violência patrimonial contra idoso ou pessoa com deficiência', 'Outra',
];
const QUADRO3 = [
  'Violência física', 'Violência psicológica', 'Exploração sexual', 'Abuso ou violência sexual',
  'Negligência ou abandono', 'Trabalho infantil', 'Trajetória de rua', 'Tráfico de pessoas',
  'Discriminação por orientação sexual', 'Violência patrimonial contra idoso ou pessoa com deficiência',
  'Outra',
];
const ORGAOS = [
  'Conselho Tutelar', 'Poder Judiciário', 'Ministério Público', 'Defensoria Pública', 'Delegacias', 'Outro',
];
const MEDIDAS = [
  'Liberdade assistida (LA)', 'Prestação de serviços à comunidade (PSC)', 'Advertência',
  'Obrigação de reparar o dano', 'Semiliberdade', 'Internação',
];

const LISTS: Array<{ route: string; names: string[] }> = [
  { route: 'violence-history-situations', names: QUADRO1 },
  { route: 'violence-record-situations', names: QUADRO3 },
  { route: 'rights-guarantee-bodies', names: ORGAOS },
  { route: 'socio-educational-measure-types', names: MEDIDAS },
];

type Item = { uuid: string; code: string; name: string; is_active: boolean };

async function manager(): Promise<APIRequestContext> {
  const origin = ADMIN_BASE ?? 'http://localhost:5175';
  return playwrightRequest.newContext({
    baseURL: API_BASE,
    storageState: API_STATE,
    extraHTTPHeaders: {
      Accept: 'application/json',
      Origin: origin,
      Referer: `${origin}/auth/login`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
}

async function xsrf(api: APIRequestContext): Promise<string> {
  const state = await api.storageState();
  const token = state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value;
  if (!token) throw new Error('XSRF-TOKEN ausente no contexto autenticado');
  return decodeURIComponent(token);
}

/** Devolve o estado de partida: "Outra" ('99') do Quadro 1 ativa. */
async function restore(api: APIRequestContext): Promise<void> {
  const res = await api.get('/api/violence-history-situations?per_page=0');
  expect(res.ok(), 'GET violence-history-situations').toBeTruthy();
  const outra = ((await res.json()) as { data: Item[] }).data.find((i) => i.code === '99');
  if (outra && !outra.is_active) {
    const put = await api.put(`/api/violence-history-situations/${outra.uuid}`, {
      data: { is_active: true },
      headers: { 'X-XSRF-TOKEN': await xsrf(api) },
    });
    expect(put.ok(), `PUT reativar: ${await put.text()}`).toBeTruthy();
  }
}

async function gotoList(page: Page, route: string, rows?: number) {
  await page.goto(`/app/${route}`);
  await page.waitForLoadState('networkidle');
  await dismissPlatformUpdates(page);
  await expect(page.locator('tbody tr').first()).toBeVisible();
  if (rows !== undefined) await expect(page.locator('tbody tr')).toHaveCount(rows);
}

/** Textos da coluna "Nome" (4ª célula: seleção, ordem, código, nome). */
async function names(page: Page): Promise<string[]> {
  return page.locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => (tr.querySelectorAll('td')[3]?.textContent ?? '').trim()),
  );
}

async function search(page: Page, term: string) {
  await page.getByPlaceholder('Buscar por nome ou código...').fill(term);
  await page.waitForTimeout(900);
}

test.describe.serial('US-VIOL-01 #11290 — domínios da proteção social especial no Painel Global', () => {
  test.skip(!ADMIN_BASE, 'Defina E2E_BASE_URL para rodar contra o admin.');
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });

  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await manager();
    await restore(api);
  });

  test.afterAll(async () => {
    try {
      await restore(api);
    } finally {
      await api.dispose();
    }
  });

  test('CA01 — o menu tem o subgrupo e as quatro listas trazem 12, 11, 6 e 6 itens na ordem do instrumento', async ({ page }) => {
    for (const { route, names: expected } of LISTS) {
      await gotoList(page, route, expected.length);
      expect(await names(page), `${route}: nomes na ordem`).toEqual(expected);
      await shot(page, `CA01-lista-${route}`);
    }
    // Menu: subgrupo com as quatro entradas, visível com uma tela do grupo aberta.
    const sidebar = page.locator('aside').first();
    await expect(sidebar.getByText('Proteção social especial', { exact: true })).toBeVisible();
    for (const label of [
      'Situações de Violência (Quadro 1)', 'Situações de Violência (Quadro 3)',
      'Órgãos de Garantia de Direitos', 'Tipos de Medida Socioeducativa',
    ]) {
      await expect(sidebar.getByText(label, { exact: true })).toBeVisible();
    }
    await sidebar.getByText('Proteção social especial', { exact: true }).scrollIntoViewIfNeeded();
    await shot(page, 'CA01-menu-subgrupo', false);
    await gotoList(page, 'violence-history-situations', 12);
    await shot(page, 'CA01-listas', false);
  });

  test('CA02 — Quadro 1 e Quadro 3 são listas distintas', async ({ page }) => {
    await gotoList(page, 'violence-history-situations');
    await search(page, 'Negligência');
    await expect(page.locator('tbody tr')).toHaveCount(3);
    expect(await names(page)).toEqual([
      'Negligência contra idoso', 'Negligência contra criança', 'Negligência contra pessoa com deficiência',
    ]);
    await shot(page, 'CA02-quadro-1');
    await search(page, 'Discriminação');
    await expect(page.locator('tbody tr')).toHaveCount(0);

    await gotoList(page, 'violence-record-situations');
    await search(page, 'Negligência');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('Negligência ou abandono', { exact: true })).toBeVisible();
    await shot(page, 'CA02-quadro-3-negligencia');
    await search(page, 'Discriminação');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('Discriminação por orientação sexual', { exact: true })).toBeVisible();
    await shot(page, 'CA02-quadros-1-e-3');
  });

  test('CA03 — LA e PSC trazem o selo "Acompanhável pelo CREAS"; as outras quatro não', async ({ page }) => {
    await gotoList(page, 'socio-educational-measure-types', 6);
    await expect(page.getByTestId('badge-creas-followable')).toHaveCount(2);
    for (const name of ['Liberdade assistida (LA)', 'Prestação de serviços à comunidade (PSC)']) {
      await expect(
        page.locator('tbody tr').filter({ hasText: name }).getByTestId('badge-creas-followable'),
      ).toBeVisible();
    }
    for (const name of ['Advertência', 'Obrigação de reparar o dano', 'Semiliberdade', 'Internação']) {
      await expect(
        page.locator('tbody tr').filter({ hasText: name }).getByTestId('badge-creas-followable'),
      ).toHaveCount(0);
    }
    await shot(page, 'CA03-medidas-creas');
  });

  test('CA04 — o formulário da Internação traz "Alimenta o bloco de acolhimento" ligado', async ({ page }) => {
    await gotoList(page, 'socio-educational-measure-types', 6);
    await expect(page.getByTestId('badge-feeds-sheltering')).toHaveCount(1);
    await page.locator('tbody tr').filter({ hasText: 'Internação' }).getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Editar', exact: true }).click();
    const flag = page.getByTestId('sem-flag-feeds_sheltering');
    await expect(flag).toBeVisible();
    await expect(flag).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('sem-flag-is_creas_followable')).toHaveAttribute('aria-checked', 'false');
    await page.waitForTimeout(800); // fim da animação do painel
    await shot(page, 'CA04-internacao', false);
    // Fecha sem salvar: nada foi alterado.
    await page.keyboard.press('Escape');
    await expect(flag).toBeHidden();
  });

  test('CT03 — inativar "Outra" do Quadro 1 mostra o selo "Inativo" e persiste (reativa no afterAll)', async ({ page }) => {
    await gotoList(page, 'violence-history-situations', 12);
    await search(page, '99');
    const row = page.locator('tbody tr').filter({ hasText: 'Outra' });
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Ativo', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Ativo', exact: true }).click();
    await expect(row.getByText('Inativo', { exact: true })).toBeVisible();
    await shot(page, 'CT03-inativado');

    // Persistiu no servidor: recarrega e o selo continua "Inativo".
    await gotoList(page, 'violence-history-situations');
    await search(page, '99');
    await expect(
      page.locator('tbody tr').filter({ hasText: 'Outra' }).getByText('Inativo', { exact: true }),
    ).toBeVisible();
  });

  test.describe('Operacional Global (CT05)', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('CT05 — o Operacional Global só consulta: sem "Novo", sem seleção em massa e sem ações de linha', async ({ page }) => {
      await page.goto('/auth/login');
      await page.locator('input#cpf').fill(process.env.E2E_ADMIN_OPERADOR_CPF ?? '');
      await page.locator('input#password').fill(process.env.E2E_ADMIN_OPERADOR_PASSWORD ?? '');
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/app/);

      await gotoList(page, 'socio-educational-measure-types', 6);
      await expect(page.getByRole('button', { name: /^Novo/ })).toHaveCount(0);
      await expect(page.locator('tbody [role="checkbox"], tbody input[type="checkbox"]')).toHaveCount(0);
      await expect(page.locator('tbody').getByRole('button', { name: /^(Ativo|Inativo)$/ })).toHaveCount(0);
      await page.locator('tbody tr').first().getByRole('button', { name: 'Mais ações' }).click();
      await expect(page.getByRole('menuitem')).toHaveCount(0);
      await shot(page, 'CT05-somente-consulta');
      await page.keyboard.press('Escape');
    });
  });
});
