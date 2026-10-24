import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginAsTenantUser, TENANT_UUID } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-VIOL-05 (HU #11294) — Mapa Consolidado do CREAS, no frontend do TENANT.
 * Spec MANUAL multiusuário (o cenário declarativo E2E-032 cobre CA01 e CA04 em
 * um login cada). Aqui ficam os dois meses (CA02), o escopo por unidade (CA03),
 * a API (422/403, sem identificação no JSON) e o Master (CA05).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: 4 logins, sequenciais)
 *  1. técnico do CREAS Sul: CA01, CA02, CA03 (+ API);
 *  2. operador do E2E CREAS (técnico): contraprova do CA03 — não vê o Sul;
 *  3. administrativo do E2E CREAS (não técnico): CA04 — a evidência é a AUSÊNCIA;
 *  4. Master: CA05.
 *
 * ## Massa (`E2ECreasRecordMapSeeder`, api)
 * "E2E CREAS Sul" (`…011294051`): out/2026 psicológica (2) 3 indícios, física
 * (1) 1 confirmada; nov/2026 psicológica 1 confirmada (confirma a de outubro).
 * "E2E CREAS" (`…0e0002`): out/2026 situação 5, 1 confirmada.
 *
 * Nunca registra nem imprime CPF, nome ou corpo de resposta em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const EVIDENCE_SLUG = "11294-mapa-consolidado-creas";

const UNIT_SUL = "00000000-0000-4000-8000-000011294051";
const UNIT_NORTE = "00000000-0000-4000-8000-0000000e0002";
const FAMILIES = [
  "00000000-0000-4000-8000-000011294001",
  "00000000-0000-4000-8000-000011294002",
];
const MEMBER_NAMES = ["E2E Mapa CREAS Sul m", "E2E Mapa CREAS Norte m"];

const SUL_CPF = process.env.E2E_CLIENT_CREAS_SUL_TECNICO_CPF ?? "99000159407";
const SUL_PASSWORD =
  process.env.E2E_CLIENT_CREAS_SUL_TECNICO_PASSWORD ?? "senha123";
const OPERADOR_CPF = process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "99000140064";
const OPERADOR_PASSWORD = process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "senha123";
const ADMIN_CPF = process.env.E2E_CLIENT_CREAS_ADMIN_STAFF_CPF ?? "99000150299";
const ADMIN_PASSWORD =
  process.env.E2E_CLIENT_CREAS_ADMIN_STAFF_PASSWORD ?? "senha123";
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? "52998224725";
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? "senha123";

const MENU_ITEM = /Mapa Consolidado do CREAS/i;
const ROUTE = "/app/protecao-especial/mapa-creas";

let shared: Page | undefined;

async function startSession(
  browser: Browser,
  cpf: string,
  password: string,
): Promise<Page> {
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

function cell(unit: string, month: string, code: string, level: string) {
  return `cell-${unit}-${month}-${code}-${level}`;
}

async function openMap(page: Page, start: string, end: string): Promise<void> {
  await page.goto(`${ROUTE}?start_month=${start}&end_month=${end}`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("creas-record-map-rule-notice")).toBeVisible();
}

async function mapApi(page: Page, query: string) {
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(
    cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "",
  );
  expect(xsrf, "XSRF-TOKEN da sessão").not.toBe("");
  return page.request.get(`${API_BASE}/api/client/creas-record-maps?${query}`, {
    headers: {
      Accept: "application/json",
      Origin: BASE ?? "",
      Referer: `${BASE}/app`,
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": xsrf,
      "X-Tenant-UUID": TENANT_UUID,
    },
  });
}

async function menuItemVisible(page: Page): Promise<boolean> {
  await page.goto("/app");
  await dismissPlatformUpdates(page);
  await expect(page.locator("aside, nav").first()).toBeVisible();
  const link = page.getByRole("button", { name: MENU_ITEM });
  return (await link.count()) > 0;
}

test.describe.configure({ mode: "serial" });

test.describe("US-VIOL-05 #11294 — Mapa Consolidado do CREAS", () => {
  test.use({ viewport: { width: 1440, height: 1100 }, locale: "pt-BR" });
  test.afterAll(async () => {
    if (shared) await shared.context().close();
    shared = undefined;
  });

  test("CA01 — o técnico do CREAS Sul lê outubro/2026: psicológica 3 indícios e física 1 confirmada, sem identificação", async ({
    browser,
  }, testInfo) => {
    test.skip(!SUL_CPF || !SUL_PASSWORD, "sem credenciais do técnico do Sul");
    const page = await startSession(browser, SUL_CPF, SUL_PASSWORD);

    expect(await menuItemVisible(page), "item no menu do técnico").toBe(true);

    await openMap(page, "2026-10", "2026-10");
    const table = page.getByTestId(`creas-record-map-unit-${UNIT_SUL}`);
    await expect(table).toBeVisible();
    await expect(table.getByText("E2E CREAS Sul").first()).toBeVisible();
    await expect(page.getByTestId(cell(UNIT_SUL, "2026-10", "2", "suspected"))).toHaveText("3");
    await expect(page.getByTestId(cell(UNIT_SUL, "2026-10", "2", "confirmed"))).toHaveText("0");
    await expect(page.getByTestId(cell(UNIT_SUL, "2026-10", "1", "suspected"))).toHaveText("0");
    await expect(page.getByTestId(cell(UNIT_SUL, "2026-10", "1", "confirmed"))).toHaveText("1");

    // nenhuma identificação na tela
    const text = (await page.locator("main").innerText()) ?? "";
    for (const name of MEMBER_NAMES) expect(text).not.toContain(name);
    for (const uuid of FAMILIES) expect(await page.content()).not.toContain(uuid);

    // nem no JSON da resposta
    const res = await mapApi(page, "start_month=2026-10&end_month=2026-10");
    expect(res.status()).toBe(200);
    const body = await res.text();
    for (const marker of [...FAMILIES, ...MEMBER_NAMES]) {
      expect(body.includes(marker), "JSON sem identificação").toBe(false);
    }

    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA02 — outubro a novembro/2026: indício em outubro, confirmada em novembro, e outubro mantém 3", async ({}, testInfo) => {
    const page = shared;
    test.skip(!page, "sem sessão do técnico do Sul");
    await openMap(page!, "2026-10", "2026-11");
    await expect(page!.getByTestId(cell(UNIT_SUL, "2026-10", "2", "suspected"))).toHaveText("3");
    await expect(page!.getByTestId(cell(UNIT_SUL, "2026-11", "2", "confirmed"))).toHaveText("1");
    await expect(page!.getByTestId(cell(UNIT_SUL, "2026-11", "2", "suspected"))).toHaveText("0");
    await captureEvidence(page!, testInfo, EVIDENCE_SLUG);
  });

  test("CA03 — o técnico do Sul só vê o Sul: sem filtro de unidade, e a unidade do E2E CREAS é recusada na API", async ({}, testInfo) => {
    const page = shared;
    test.skip(!page, "sem sessão do técnico do Sul");
    await openMap(page!, "2026-10", "2026-10");
    await expect(page!.locator('[data-testid^="creas-record-map-unit-"]')).toHaveCount(1);
    await expect(page!.getByTestId(`creas-record-map-unit-${UNIT_SUL}`)).toBeVisible();
    await expect(page!.getByTestId(`creas-record-map-unit-${UNIT_NORTE}`)).toHaveCount(0);
    await expect(page!.locator("#creas-map-unit")).toHaveCount(0);

    const res = await mapApi(
      page!,
      `start_month=2026-10&end_month=2026-10&social_unit_uuid=${UNIT_NORTE}`,
    );
    expect(res.status()).toBe(422);
    await captureEvidence(page!, testInfo, EVIDENCE_SLUG, "so-sul");
  });

  test("CA03 — o operador do E2E CREAS vê só o E2E CREAS, sem a tabela do Sul", async ({
    browser,
  }, testInfo) => {
    test.skip(!OPERADOR_CPF || !OPERADOR_PASSWORD, "sem credenciais do operador do CREAS");
    const page = await startSession(browser, OPERADOR_CPF, OPERADOR_PASSWORD);
    await openMap(page, "2026-10", "2026-10");
    await expect(page.getByTestId(`creas-record-map-unit-${UNIT_NORTE}`)).toBeVisible();
    await expect(page.getByTestId(`creas-record-map-unit-${UNIT_SUL}`)).toHaveCount(0);
    await expect(page.locator('[data-testid^="creas-record-map-unit-"]')).toHaveCount(1);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "so-norte");
  });

  test("CA04 — o administrativo do CREAS não vê o item no menu (a evidência é a ausência) e a URL direta é negada", async ({
    browser,
  }, testInfo) => {
    test.skip(!ADMIN_CPF || !ADMIN_PASSWORD, "sem credenciais do administrativo do CREAS");
    const page = await startSession(browser, ADMIN_CPF, ADMIN_PASSWORD);

    expect(await menuItemVisible(page), "item ausente do menu").toBe(false);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "sem-item");

    await page.goto(`${ROUTE}?start_month=2026-10&end_month=2026-10`);
    await dismissPlatformUpdates(page);
    // A guarda da rota (feature_access.creas_record_map) barra antes da página:
    // o usuário vê a tela global "Acesso negado"; o estado `creas-record-map-denied`
    // da página só aparece quando o item existe e a API devolve 403.
    await expect(
      page
        .getByRole("heading", { name: "Acesso negado" })
        .or(page.getByTestId("creas-record-map-denied")),
    ).toBeVisible();

    const res = await mapApi(page, "start_month=2026-10&end_month=2026-10");
    expect(res.status()).toBe(403);
    expect((await res.json()).code ?? (await res.text())).toContain("creas_record_map_denied");
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "negado");
  });

  test("CA05 — o Master vê as tabelas do E2E CREAS e do E2E CREAS Sul, com o filtro de unidade", async ({
    browser,
  }, testInfo) => {
    test.skip(!MASTER_CPF || !MASTER_PASSWORD, "sem credenciais do Master");
    const page = await startSession(browser, MASTER_CPF, MASTER_PASSWORD);
    await openMap(page, "2026-10", "2026-10");
    await expect(page.getByTestId(`creas-record-map-unit-${UNIT_NORTE}`)).toBeVisible();
    await expect(page.getByTestId(`creas-record-map-unit-${UNIT_SUL}`)).toBeVisible();
    await expect(page.locator("#creas-map-unit")).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });
});
