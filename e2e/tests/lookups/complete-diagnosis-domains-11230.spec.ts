import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import * as path from 'node:path';
import { expect, test } from '../../fixtures/auth';
import { dismissPlatformUpdates } from '../../helpers/platform-updates';

/**
 * US-DIAG2-01 (#11230) — os nove domínios do diagnóstico completo no Painel
 * Global (`admin/`, guard `manager`): seis listas de habitação, série
 * escolar (20), titulação (4) e condição de ocupação (12).
 *
 * ## O que este spec prova, e que nenhum teste de backend prova
 *
 * Que o Administrador **enxerga e opera** o que o Pest garante no banco: as
 * listas fechadas com os códigos literais do instrumento (zero à esquerda e
 * lacunas), o de-para da série nos três estados, a inativação com o selo
 * "Inativo" e a trilha de auditoria da alteração do nível.
 *
 * ## Massa (pré-condição)
 *
 * `CompleteDiagnosisDomainsSeeder`, chamado pelo `E2ESeeder`. Massa ausente
 * aqui NÃO vira `skip`: é harness quebrado.
 *
 * ## Estado — este spec ALTERA dados globais e RESTAURA no `afterAll`
 *
 * - inativa "Carro pipa" (CA06) — a disponibilidade em registro antigo é
 *   provada pelo Pest (`ActiveCatalogItemDiagnosisDomainsTest`), não aqui;
 * - muda o nível da série `30` de 4 (Ensino médio) para 3 (Fundamental)
 *   (CT04).
 *
 * O `beforeAll` normaliza (caso uma execução anterior tenha caído no meio) e o
 * `afterAll` reativa o item e devolve o nível 4, **pela API do `manager`**.
 * Rodar duas vezes dá o mesmo resultado.
 *
 * ## NÃO COBERTO
 *
 * A prova de que o item inativo continua disponível em um registro antigo é
 * da #11231 (o registro nasce lá); aqui só o selo e a persistência.
 */

const ADMIN_BASE = process.env.E2E_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:8000';
const API_STATE = path.resolve(__dirname, '..', '..', '.auth', 'api-client.json');
const SHOTS = 'test-results/11230';

type Item = {
  uuid: string;
  code: string;
  name: string;
  is_active: boolean;
  schooling_level?: { uuid: string; code: string; name: string } | null;
};

/** Contexto HTTP com a sessão do Super Admin (cookies Sanctum), com `PUT`. */
async function manager(): Promise<APIRequestContext> {
  const origin = ADMIN_BASE ?? 'http://localhost:5173';
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

async function list(api: APIRequestContext, resource: string): Promise<Item[]> {
  const res = await api.get(`/api/${resource}?per_page=0`);
  expect(res.ok(), `GET ${resource}`).toBeTruthy();
  return ((await res.json()) as { data: Item[] }).data;
}

async function put(
  api: APIRequestContext,
  resource: string,
  uuid: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await api.put(`/api/${resource}/${uuid}`, {
    data: body,
    headers: { 'X-XSRF-TOKEN': await xsrf(api) },
  });
  expect(res.ok(), `PUT ${resource}/${uuid}: ${await res.text()}`).toBeTruthy();
}

/** Devolve o estado de partida: "Carro pipa" ativo e série 30 no nível 4. */
async function restore(api: APIRequestContext): Promise<void> {
  const water = (await list(api, 'water-supply-types')).find((i) => i.code === '4');
  if (water && !water.is_active) await put(api, 'water-supply-types', water.uuid, { is_active: true });

  const grades = await list(api, 'school-grades');
  const level4 = grades.find((g) => g.code === '23')?.schooling_level?.uuid;
  const g30 = grades.find((g) => g.code === '30');
  if (level4 && g30 && g30.schooling_level?.code !== '4') {
    await put(api, 'school-grades', g30.uuid, { schooling_level_uuid: level4 });
  }
}

async function gotoList(page: Page, route: string) {
  await page.goto(`/app/${route}`);
  await page.waitForLoadState('networkidle');
  await dismissPlatformUpdates(page);
  await expect(page.locator('tbody tr').first()).toBeVisible();
}

async function search(page: Page, term: string) {
  await page.getByPlaceholder('Buscar por nome ou código...').fill(term);
  await expect(page.locator('tbody tr')).toHaveCount(1);
}

async function rowMenu(page: Page, item: string) {
  await page.locator('tbody tr').filter({ hasText: item }).first()
    .getByRole('button', { name: 'Mais ações' }).click();
}

const HOUSING: Array<{ route: string; rows: number; sample: string }> = [
  { route: 'wall-materials', rows: 2, sample: 'Alvenaria ou madeira aparelhada' },
  { route: 'electricity-access-types', rows: 4, sample: 'Sim, com medidor próprio' },
  { route: 'water-supply-types', rows: 5, sample: 'Carro pipa' },
  { route: 'sanitation-types', rows: 5, sample: 'Fossa séptica' },
  { route: 'garbage-collection-types', rows: 3, sample: 'Sim, coleta direta' },
  { route: 'home-accessibility-types', rows: 3, sample: 'Não possui condições de acessibilidade' },
];

test.describe.serial('US-DIAG2-01 — domínios do diagnóstico completo no Painel Global (admin)', () => {
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

  test('CA01/CT01 — as seis listas de habitação, com o número de itens do instrumento e sem "Novo" nem "Excluir"', async ({
    page,
  }) => {
    for (const { route, rows, sample } of HOUSING) {
      await gotoList(page, route);
      await expect(page.locator('tbody tr'), `${route}: itens`).toHaveCount(rows);
      await expect(page.getByText(sample, { exact: true })).toBeVisible();
      // CT01: lista fechada — nenhum controle de criar/excluir.
      await expect(page.getByRole('button', { name: /^novo|^nova|adicionar/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /excluir/i })).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/CA01-habitacao-${route}.png`, fullPage: true });
    }
    // O código do primeiro item é literal do instrumento.
    await gotoList(page, 'water-supply-types');
    await expect(page.locator('tbody tr').first().getByTestId('dom-code')).toHaveText('1');
  });

  test('CA02 — a série mostra os 20 códigos, com zero à esquerda e as lacunas do instrumento', async ({
    page,
  }) => {
    await gotoList(page, 'school-grades');
    const codes = async () =>
      (await page.getByTestId('dom-code').allInnerTexts()).map((c) => c.trim());

    const first = await codes();
    await page.screenshot({ path: `${SHOTS}/CA02-series-1.png`, fullPage: true });
    await page.getByRole('button', { name: 'Próxima página' }).click();
    await expect(page.getByTestId('dom-code').first()).not.toHaveText(first[0] ?? '');
    const second = await codes();
    await page.screenshot({ path: `${SHOTS}/CA02-series-2.png`, fullPage: true });

    expect([...first, ...second]).toEqual([
      '00', '01', '02', '11', '12', '13', '14', '15', '16', '17', '18', '19',
      '21', '22', '23', '30', '31', '40', '41', '99',
    ]);
  });

  test('CA03/CA04/CA05 — o detalhe da série mostra nível fixo (23), sem correspondência (99) e titulações (31)', async ({
    page,
  }) => {
    await gotoList(page, 'school-grades');
    const detail = page.getByTestId('grade-detail');

    const open = async (code: string) => {
      await search(page, code);
      await rowMenu(page, code);
      await page.getByRole('menuitem', { name: 'Ver correspondência' }).click();
      await expect(detail).toBeVisible();
    };
    const close = async () => {
      await page.keyboard.press('Escape');
      await expect(detail).toBeHidden();
    };

    await open('23');
    await expect(detail).toContainText('Ensino médio');
    await page.waitForTimeout(800); // fim da animação do painel
    await page.screenshot({ path: `${SHOTS}/CA03-depara.png` });
    await close();

    await open('99');
    await expect(detail).toContainText('Sem correspondência');
    await page.waitForTimeout(800); // fim da animação do painel
    await page.screenshot({ path: `${SHOTS}/CA04-sem-correspondencia.png` });
    await close();

    await open('31');
    await expect(detail).toContainText('Admite complemento de titulação');
    await expect(page.getByTestId('grade-title-option')).toHaveCount(4);
    for (const title of ['Pós-graduação', 'Mestrado', 'Doutorado', 'Pós-doutorado']) {
      await expect(detail).toContainText(title);
    }
    await page.waitForTimeout(800); // fim da animação do painel
    await page.screenshot({ path: `${SHOTS}/CA05-titulacao.png` });
  });

  test('CA06 — inativar "Carro pipa" atualiza o selo e persiste', async ({ page }) => {
    await gotoList(page, 'water-supply-types');
    const row = page.locator('tbody tr').filter({ hasText: 'Carro pipa' });
    const badge = row.getByTestId('dom-badge-status');
    await expect(badge).toHaveText('Ativo');

    await badge.click();
    await expect(badge).toHaveText('Inativo');
    await page.screenshot({ path: `${SHOTS}/CA06-inativado.png`, fullPage: true });

    // Persistiu no servidor: recarrega e o selo continua "Inativo".
    await gotoList(page, 'water-supply-types');
    await expect(
      page.locator('tbody tr').filter({ hasText: 'Carro pipa' }).getByTestId('dom-badge-status'),
    ).toHaveText('Inativo');
  });

  test('CT04 — alterar o nível da série 30 grava a trilha com o de-para', async ({ page }) => {
    await gotoList(page, 'school-grades');
    await search(page, '30');
    await rowMenu(page, '30');
    await page.getByRole('menuitem', { name: 'Editar nome' }).click();

    await page.getByTestId('grade-level').click();
    await page.getByRole('option', { name: /^3 — / }).click();
    await page.getByTestId('dom-submit').click();
    await expect(page.getByTestId('dom-submit')).toBeHidden();

    await dismissPlatformUpdates(page);
    await rowMenu(page, '30');
    await page.getByRole('menuitem', { name: 'Ver histórico' }).click();

    const updated = page.getByTestId('dom-history-updated').first();
    await expect(updated).toBeVisible();
    await expect(updated).toContainText('→');
    await page.waitForTimeout(800); // fim da animação do painel
    await page.screenshot({ path: `${SHOTS}/CT04-trilha.png` });

    // O servidor guardou o novo nível; o afterAll devolve o 4.
    const g30 = (await list(api, 'school-grades')).find((g) => g.code === '30');
    expect(g30?.schooling_level?.code).toBe('3');
  });
});
