import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loginAsTenantUser, TENANT_UUID } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * US-RMA-01 (HU #11543) — RMA do CREAS apurado do prontuário, no frontend do TENANT.
 * Spec MANUAL multiusuário (o cenário declarativo E2E-050 cobre CA01–CA03, CA05,
 * CA07, CA08 e CA10 em logins próprios). Aqui ficam também CA04, CA06, CA09 e CA11.
 *
 * ## Arranjo (⚠️ `throttle:6,1`: no máximo 5 logins, sequenciais — usa 2)
 *  1. técnico do "E2E CREAS RMA": CA01–CA08 e CA11 pela tela, com prints;
 *  2. Administrador (API do Painel Global, cookies do setup): retira a ligação
 *     "situação 9 → H.1" e imprime o formulário do admin com H.1 desmarcado (CA09, admin);
 *  3. o MESMO técnico recarrega o RMA: H.1 "Sem origem no prontuário" (CA09, client);
 *  4. `afterAll` SEMPRE restaura a ligação (o seeder também a repõe);
 *  5. técnico do CRAS Rural: sem item no menu e URL direta negada (CA10, prova de AUSÊNCIA).
 *
 * ## Massa (`E2ECreasRmaSeeder`, api)
 * Unidade "E2E CREAS RMA" (`…011543051`), mês 2026-10: A.1 12, A.2 3, B.1 2, B.6 f_0_12 1,
 * C.2 f_7_12 1, M.1 5, M.4 0, J.1/J.2/J.3 1. M.3 NÃO é afirmado (outra massa da cadeia grava
 * encaminhamentos código 14 na mesma unidade e mês).
 *
 * Credenciais só por variável de ambiente; nunca imprime CPF, nome ou corpo de resposta.
 * Prints só com `CAPTURE_EVIDENCE=1`, em `e2e/reports/11543-apurar-rma-creas-acceptance/screenshots/`.
 */

const BASE = process.env.CLIENT_BASE_URL ?? "http://localhost:4174";
const ADMIN_BASE = process.env.E2E_BASE_URL ?? "http://localhost:4173";
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";

const TECNICO_CPF = process.env.E2E_CLIENT_CREAS_RMA_TECNICO_CPF ?? "";
const TECNICO_PASSWORD = process.env.E2E_CLIENT_CREAS_RMA_TECNICO_PASSWORD ?? "senha123";
const RURAL_CPF = process.env.E2E_CLIENT_RURAL_CPF ?? "";
const RURAL_PASSWORD = process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? "senha123";

const UNIT_SUL = "00000000-0000-4000-8000-000011294051";
const ROUTE = "/app/protecao-especial/rma-creas";
const MONTH = "2026-10";
const SITUATION_CODE = "9";
const ITEM = "H.1";

const EVIDENCE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "e2e",
  "reports",
  "11543-apurar-rma-creas-acceptance",
  "screenshots",
);
const API_CLIENT_STATE = path.resolve(__dirname, "..", "..", ".auth", "api-client.json");
const ADMIN_STATE = path.resolve(__dirname, "..", "..", ".auth", "super-admin.json");

let shared: Page | undefined;
let adminApi: APIRequestContext | undefined;
let linkRemoved = false;

async function startSession(browser: Browser, cpf: string, password: string): Promise<Page> {
  if (shared) await shared.context().close();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1100 },
  });
  shared = await context.newPage();
  await loginAsTenantUser(shared, cpf, password);
  return shared;
}

async function openRma(page: Page): Promise<void> {
  await page.goto(`${ROUTE}?mes=${MONTH}`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("creas-rma-header")).toBeVisible();
}

async function evidence(target: Page | Locator, name: string): Promise<void> {
  if (process.env.CAPTURE_EVIDENCE !== "1") return;
  await fs.promises.mkdir(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  if ("screenshot" in target && "goto" in target) {
    await (target as Page).screenshot({ path: file, fullPage: true });
  } else {
    await (target as Locator).scrollIntoViewIfNeeded();
    await (target as Locator).screenshot({ path: file });
  }
}

function cell(page: Page, item: string, key: string): Locator {
  return page.getByTestId(`creas-rma-cell-${item}-${key}`);
}

/** Contexto de API do Administrador, reaproveitando os cookies do projeto `setup`. */
async function getAdminApi(): Promise<APIRequestContext> {
  adminApi ??= await playwrightRequest.newContext({
    baseURL: API_BASE,
    storageState: API_CLIENT_STATE,
    extraHTTPHeaders: {
      Accept: "application/json",
      Origin: ADMIN_BASE,
      Referer: `${ADMIN_BASE}/auth/login`,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  return adminApi;
}

async function xsrf(api: APIRequestContext): Promise<string> {
  const state = await api.storageState();
  const value = state.cookies.find((c) => c.name === "XSRF-TOKEN")?.value;
  expect(value, "XSRF-TOKEN do Administrador").toBeTruthy();
  return decodeURIComponent(value ?? "");
}

async function situation(api: APIRequestContext): Promise<{ uuid: string; rma_items: string[] }> {
  const res = await api.get("/api/violence-record-situations", { params: { per_page: 100 } });
  expect(res.ok(), "GET violence-record-situations").toBe(true);
  const body = (await res.json()) as { data: { uuid: string; code: string; rma_items: string[] }[] };
  const found = body.data.find((row) => row.code === SITUATION_CODE);
  expect(found, `situação ${SITUATION_CODE} do Quadro 3`).toBeTruthy();
  return { uuid: found!.uuid, rma_items: found!.rma_items };
}

async function setLink(api: APIRequestContext, present: boolean): Promise<void> {
  const current = await situation(api);
  const rest = current.rma_items.filter((code) => code !== ITEM);
  const next = present ? [...rest, ITEM] : rest;
  const res = await api.patch(`/api/violence-record-situations/${current.uuid}`, {
    data: { rma_items: next },
    headers: { "X-XSRF-TOKEN": await xsrf(api) },
  });
  expect(res.ok(), "PATCH violence-record-situations (rma_items)").toBe(true);
}

async function clientApi(page: Page, query: string) {
  const cookies = await page.context().cookies();
  const token = decodeURIComponent(cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "");
  expect(token, "XSRF-TOKEN da sessão").not.toBe("");
  return page.request.get(`${API_BASE}/api/client/creas-rmas?${query}`, {
    headers: {
      Accept: "application/json",
      Origin: BASE,
      Referer: `${BASE}/app`,
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": token,
      "X-Tenant-UUID": TENANT_UUID,
    },
  });
}

test.describe.configure({ mode: "serial" });

test.describe("US-RMA-01 #11543 — RMA do CREAS apurado do prontuário", () => {
  test.use({ viewport: { width: 1440, height: 1100 }, locale: "pt-BR" });

  test.afterAll(async () => {
    // Regra: o catálogo global NUNCA fica alterado, mesmo com falha no meio.
    try {
      const api = await getAdminApi();
      await setLink(api, true);
      linkRemoved = false;
    } catch {
      // o seeder (E2ECreasRmaSeeder) também repõe a ligação 9 → H.1
    }
    await adminApi?.dispose();
    adminApi = undefined;
    if (shared) await shared.context().close();
    shared = undefined;
  });

  test("CA01 — cabeçalho da unidade e Bloco I: 12 casos acompanhados e 3 novos no mês", async ({
    browser,
  }) => {
    test.skip(!TECNICO_CPF, "E2E_CLIENT_CREAS_RMA_TECNICO_CPF ausente");
    const page = await startSession(browser, TECNICO_CPF, TECNICO_PASSWORD);
    await openRma(page);

    await expect(page.getByTestId("creas-rma-unit-name")).toHaveText("E2E CREAS RMA");
    await expect(page.getByTestId("creas-rma-mds-number")).toHaveText("MDS-E2E-11543");
    await expect(page.getByTestId("creas-rma-calculated-at")).toBeVisible();
    await expect(cell(page, "A-1", "total")).toHaveText("12");
    await expect(cell(page, "A-2", "total")).toHaveText("3");
    await evidence(page.getByTestId("creas-rma-header"), "CA01-rma-do-mes");
  });

  test("CA02 — perfis dos casos novos: duas famílias do Bolsa Família (B.1 = 2)", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await expect(cell(shared!, "B-1", "total")).toHaveText("2");
    await evidence(shared!.getByTestId("creas-rma-item-B-1"), "CA02-perfis-novos-casos");
  });

  test("CA03 — vítima por sexo e idade: menina de 9 anos (B.6 f_0_12 = 1, C.2 f_7_12 = 1)", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await expect(cell(shared!, "B-6", "f_0_12")).toHaveText("1");
    await expect(cell(shared!, "C-2", "f_7_12")).toHaveText("1");
    await evidence(shared!.getByTestId("creas-rma-item-B-6"), "CA03-vitima-sexo-idade");
  });

  test("CA04 — indício e confirmação da mesma pessoa contam uma vez (C.2 total = 1)", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await expect(cell(shared!, "C-2", "total")).toHaveText("1");
    await evidence(shared!.getByTestId("creas-rma-item-C-2"), "CA04-indicio-e-confirmacao");
  });

  test("CA05 — atendimentos repetidos da mesma pessoa contam cada um (M.1 = 5)", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await expect(cell(shared!, "M-1", "total")).toHaveText("5");
    await evidence(shared!.getByTestId("creas-rma-item-M-1"), "CA05-atendimentos-repetidos");
  });

  test("CA06 — o atendimento cancelado não conta: M.1 segue 5 com 7 lançamentos em outubro", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await expect(cell(shared!, "M-1", "total")).toHaveText("5");
    await evidence(shared!.getByTestId("creas-rma-item-M-1"), "CA06-atendimento-cancelado");
  });

  test("CA07 — adolescente em LA e PSC: J.1 = 1, J.2 = 1, J.3 = 1", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await expect(cell(shared!, "J-1", "total")).toHaveText("1");
    await expect(cell(shared!, "J-2", "total")).toHaveText("1");
    await expect(cell(shared!, "J-3", "total")).toHaveText("1");
    await evidence(shared!.getByTestId("creas-rma-block-III"), "CA07-adolescente-la-psc");
  });

  test("CA08 — item calculado sem ocorrência aparece como 0 (M.4); M.3 só existe e é numérico", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await expect(cell(shared!, "M-4", "total")).toHaveText("0");
    await expect(cell(shared!, "M-3", "total")).toHaveText(/^\d+$/);
    await evidence(shared!.getByTestId("creas-rma-item-M-4"), "CA08-item-sem-ocorrencia");
  });

  test("CA11 — o técnico só vê a própria unidade: sem filtro de unidade e a unidade de outro CREAS é recusada", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await expect(shared!.locator("#creas-rma-unit")).toHaveCount(0);
    await expect(shared!.getByTestId("creas-rma-unit-name")).toHaveText("E2E CREAS RMA");

    const res = await clientApi(shared!, `reference_month=${MONTH}&social_unit_uuid=${UNIT_SUL}`);
    expect(res.status()).toBe(422);
    await evidence(shared!, "CA11-so-a-propria-unidade");
  });

  test("CA09 (admin) — sem a ligação 9 → H.1 o formulário do Painel Global mostra H.1 desmarcado", async ({
    browser,
  }) => {
    const api = await getAdminApi();
    await setLink(api, false);
    linkRemoved = true;
    expect((await situation(api)).rma_items).not.toContain(ITEM);

    // Print do formulário do admin com H.1 desmarcado (sessão do setup, sem novo login).
    const context = await browser.newContext({
      baseURL: ADMIN_BASE,
      storageState: ADMIN_STATE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1100 },
    });
    try {
      const admin = await context.newPage();
      await admin.goto("/app/violence-record-situations");
      await dismissPlatformUpdates(admin);
      const row = admin.locator("tr", { has: admin.getByText(/^9$/) }).first();
      await row.getByRole("button", { name: /mais ações/i }).click();
      await admin.getByRole("menuitem", { name: /editar/i }).click();
      const box = admin.getByTestId("vrs-rma-items");
      await expect(box).toBeVisible();
      await expect(admin.getByTestId("vrs-rma-item-H-1")).not.toBeChecked();
      await evidence(box, "CA09-admin-correspondencia");
    } finally {
      await context.close();
    }
  });

  test("CA09 (client) — com a ligação retirada, H.1 mostra 'Sem origem no prontuário', sem valor", async () => {
    test.skip(!shared, "sem sessão do técnico");
    await openRma(shared!);
    await expect(shared!.getByTestId("creas-rma-source-H-1")).toHaveText("Sem origem no prontuário");
    await expect(cell(shared!, "H-1", "total")).toHaveText("—");
    await evidence(shared!.getByTestId("creas-rma-item-H-1"), "CA09-sem-origem");

    // Restaura já aqui; o afterAll é a rede de segurança.
    await setLink(await getAdminApi(), true);
    linkRemoved = false;
  });

  test("CA10 — técnico do CRAS Rural: sem item no menu e URL direta negada (a evidência é a ausência)", async ({
    browser,
  }) => {
    test.skip(!RURAL_CPF, "E2E_CLIENT_RURAL_CPF ausente");
    expect(linkRemoved, "catálogo restaurado antes do CA10").toBe(false);
    const page = await startSession(browser, RURAL_CPF, RURAL_PASSWORD);

    await page.goto("/app");
    await dismissPlatformUpdates(page);
    await expect(page.locator("aside, nav").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /RMA do CREAS/i })).toHaveCount(0);
    await expect(page.locator(`a[href="${ROUTE}"]`)).toHaveCount(0);

    await page.goto(ROUTE);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("creas-rma-denied")).toBeVisible();
    await expect(page.getByTestId("creas-rma-header")).toHaveCount(0);
    await evidence(page, "CA10-cras-sem-acesso");
  });
});
