import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginAsTenantUser, TENANT_UUID } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-15 (HU #11550) — o CRAS identifica, o CREAS conduz. Spec MANUAL multiusuário.
 * O E2E-056 cobre CA01, CA04 e CA06 de forma declarativa; aqui eles reaparecem só para
 * gerar o print do dossiê (mesma massa, mesmo login).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: 4 logins, sequenciais — o limite da spec)
 *  1. técnico do CRAS Centro: CA06, CA01 (formulário com o lembrete e o registro assinado "(CRAS)"),
 *     CA02 (família encaminhada: leitura sem ações + POST 403 nos dois quadros), CA04 (retorno);
 *  2. técnico do E2E CREAS: CA03 (Quadros 1 e 3), CA07 (Liberdade assistida), CA05/CA05b/CA05c (Mapa de 2026-08);
 *  3. auxiliar administrativo: CA08 (a evidência é a ausência);
 *  4. Master: lê o Quadro 3 da família encaminhada sem as ações (sentinela da #11548).
 *
 * ## Massa (api) — `E2EViolenceCrasCreasSeeder`
 * Famílias `…11550001..005`; o seeder repõe o estado a cada rodada. Rode-o de novo antes de repetir.
 * O Mapa de agosto/2026 isola a massa da #11294 (outubro/novembro); as unidades são as do E2E.
 *
 * Credenciais só por variável de ambiente. Nunca registra CPF, nome real ou corpo de resposta.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const EVIDENCE_SLUG = "11550-violencia-medidas-cras-creas";

const CRAS = [
  process.env.E2E_CLIENT_OPERADOR_CPF,
  process.env.E2E_CLIENT_OPERADOR_PASSWORD,
] as const;
const CREAS = [
  process.env.E2E_CLIENT_CREAS_OPERADOR_CPF,
  process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD,
] as const;
const ADMIN = [
  process.env.E2E_CLIENT_ADMIN_STAFF_CPF,
  process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD,
] as const;
const MASTER = [
  process.env.E2E_CLIENT_MASTER_CPF,
  process.env.E2E_CLIENT_MASTER_PASSWORD,
] as const;

const F1 = "00000000-0000-4000-8000-000011550001";
const F2 = "00000000-0000-4000-8000-000011550002";
const F3 = "00000000-0000-4000-8000-000011550003";
const UNIT_CREAS = "00000000-0000-4000-8000-0000000e0002";
const MEASURE_UUID = "00000000-0000-4000-8000-000011550a01";
const PROCESS_LA = "0011551-35.2026.8.02.0001";
const MAP_SITUATION = "3";

let shared: Page | undefined;

async function startSession(browser: Browser, cpf: string, password: string): Promise<Page> {
  if (shared) await shared.context().close();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1100 },
  });
  shared = await context.newPage();
  await loginAsTenantUser(shared, cpf, password, { tenantUuid: TENANT_UUID });
  await dismissPlatformUpdates(shared);
  return shared;
}

async function open(page: Page, family: string, tab: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${family}?tab=${tab}`);
  await dismissPlatformUpdates(page);
}

async function api(page: Page, method: "get" | "post", path: string, data?: object) {
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "");
  expect(xsrf, "XSRF-TOKEN da sessão").not.toBe("");
  return page.context().request[method](`${API_BASE}/api/client/${path}`, {
    headers: {
      Accept: "application/json",
      Origin: BASE ?? "",
      Referer: `${BASE}/app`,
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": xsrf,
      "X-Tenant-UUID": TENANT_UUID,
    },
    data,
  });
}

async function chooseUnitIfNeeded(page: Page, testId: string, name: string): Promise<void> {
  const select = page.getByTestId(testId);
  if (await select.isVisible().catch(() => false)) {
    if (/Selecione/.test(await select.innerText())) {
      await select.click();
      await page.getByRole("option", { name }).first().click();
    }
  }
}

async function fillRecord(page: Page, member: string): Promise<void> {
  await page.getByTestId("violence-records-register").click();
  await expect(page.getByTestId("violence-record-form-sheet")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("violence-record-member-select").click();
  await page.getByRole("option", { name: member, exact: true }).click();
  await page
    .locator('[data-testid="violence-record-situation-row"][data-index="0"] [data-testid="violence-record-situation-select"]')
    .click();
  await page.getByRole("option", { name: "Violência psicológica", exact: true }).click();
  await page
    .locator('[data-testid="violence-record-situation-row"][data-index="0"] [data-testid="violence-record-evidence-level"]')
    .click();
  await page.getByRole("option", { name: "Indício", exact: true }).click();
  await page.getByTestId("violence-record-month-select").click();
  await page.getByRole("option", { name: "Setembro", exact: true }).click();
}

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-15 #11550 — o CRAS identifica, o CREAS conduz", () => {
  test.skip(
    !BASE || !CRAS[0] || !CRAS[1] || !CREAS[0] || !CREAS[1] || !ADMIN[0] || !ADMIN[1] || !MASTER[0] || !MASTER[1],
    "sem URL do client ou credenciais",
  );
  test.afterAll(async () => {
    if (shared) await shared.context().close();
    shared = undefined;
  });

  test("CA06 — o técnico do CRAS lê a medida e não tem Registrar medida nem Corrigir (a evidência é a ausência)", async ({ browser }, testInfo) => {
    const page = await startSession(browser, CRAS[0]!, CRAS[1]!);
    await open(page, F1, "medidas-socioeducativas");
    await expect(page.getByTestId(`socio-educational-measure-row-${MEASURE_UUID}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("socio-educational-measure-register-action")).toHaveCount(0);
    await expect(page.getByTestId(`socio-educational-measure-correct-${MEASURE_UUID}`)).toHaveCount(0);
    await expect(page.getByTestId("measure-register-reason")).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);

    const post = await api(page, "post", `families/${F1}/socio-educational-measures`, {});
    expect(post.status(), "POST de medida pelo CRAS").toBe(403);
    expect(JSON.stringify(await post.json())).toContain("socio_educational_measure_requires_creas_technical");
  });

  test("CA01 — o técnico do CRAS registra no Quadro 3: o formulário lembra do CREAS e a assinatura mostra (CRAS)", async ({}, testInfo) => {
    const page = shared!;
    await open(page, F1, "violencia");
    await expect(page.getByTestId("violence-records-section")).toBeVisible({ timeout: 15_000 });
    await fillRecord(page, "E2E 11550 Adolescente 1");
    await chooseUnitIfNeeded(page, "violence-record-unit-select", "CRAS Centro");
    await expect(page.getByTestId("violence-creas-referral-reminder")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("option", { name: "Janeiro", exact: true })).toHaveCount(0, { timeout: 10_000 });
    await page.getByRole("heading", { name: "Registrar situação de violência" }).click();
    await page.waitForTimeout(800);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "formulario-lembrete");
    await page.getByTestId("violence-record-submit").click();
    const item = page.locator('[data-testid="violence-record-item"]:has-text("09/2026")').first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item.getByTestId("violence-record-signature")).toContainText("(CRAS)");
    await item.scrollIntoViewIfNeeded();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "assinatura-cras");
  });

  test("CA02 — família encaminhada ao CREAS: o CRAS lê os Quadros 1 e 3, sem ações, e o POST é recusado (a evidência é a ausência)", async ({}, testInfo) => {
    const page = shared!;
    await open(page, F2, "violencia");
    await expect(page.getByTestId("violence-records-section")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("violence-history-section")).toBeVisible();
    await expect(page.locator('[data-testid="violence-person-card"]').first()).toBeVisible();
    await expect(page.getByTestId("violence-records-register")).toHaveCount(0);
    await expect(page.getByTestId("violence-history-register")).toHaveCount(0);
    await expect(page.getByTestId("violence-register-reason")).toHaveCount(2);
    const before = (await (await api(page, "get", `families/${F2}/violence-records`)).text()).length;
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);

    const q3 = await api(page, "post", `families/${F2}/violence-records`, {});
    expect(q3.status(), "POST do Quadro 3 pelo CRAS").toBe(403);
    expect(JSON.stringify(await q3.json())).toContain("violence_record_conducted_by_creas");
    const q1 = await api(page, "post", `families/${F2}/violence-history`, {});
    expect(q1.status(), "POST do Quadro 1 pelo CRAS").toBe(403);
    expect(JSON.stringify(await q1.json())).toContain("violence_history_conducted_by_creas");
    const after = (await (await api(page, "get", `families/${F2}/violence-records`)).text()).length;
    expect(after, "nada gravado").toBe(before);
  });

  test("CA04 — com o retorno do encaminhamento, o CRAS volta a ver as ações de registrar", async ({}, testInfo) => {
    const page = shared!;
    await open(page, F3, "violencia");
    await expect(page.getByTestId("violence-records-register")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("violence-history-register")).toBeVisible();
    await expect(page.getByTestId("violence-register-reason")).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA03 — o técnico do CREAS registra nos Quadros 1 e 3 depois do encaminhamento e o Quadro 3 assina (CREAS)", async ({ browser }, testInfo) => {
    const page = await startSession(browser, CREAS[0]!, CREAS[1]!);
    await open(page, F2, "violencia");
    await expect(page.getByTestId("violence-history-register")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("violence-history-register").click();
    await expect(page.getByTestId("violence-history-form")).toBeVisible({ timeout: 10_000 });
    await chooseUnitIfNeeded(page, "violence-history-unit-select", "E2E CREAS");
    await page.getByTestId("violence-history-situation-select").click();
    await page.getByRole("option", { name: "Trabalho infantil", exact: true }).click();
    await page.getByTestId("violence-history-persists-yes").click();
    await page.getByTestId("violence-history-month-input").fill("2026-09");
    await page.getByTestId("violence-history-submit").click();
    await expect(page.getByTestId("violence-history-form")).toBeHidden({ timeout: 10_000 });
    await expect(
      page.locator('[data-testid^="violence-history-row-"]').filter({ hasText: "Trabalho infantil" }),
    ).toContainText("Vivida", { timeout: 10_000 });

    await fillRecord(page, "E2E 11550 Adolescente 2");
    await chooseUnitIfNeeded(page, "violence-record-unit-select", "E2E CREAS");
    await page.getByTestId("violence-record-submit").click();
    const item = page.locator('[data-testid="violence-record-item"]:has-text("09/2026")').first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item.getByTestId("violence-record-signature")).toContainText("(CREAS)");
    await item.scrollIntoViewIfNeeded();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA07 — o técnico do CREAS registra uma Liberdade assistida para o adolescente", async ({}, testInfo) => {
    const page = shared!;
    await open(page, F2, "medidas-socioeducativas");
    await expect(page.getByTestId("socio-educational-measure-block")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("socio-educational-measure-register-action").click();
    await expect(page.getByTestId("socio-educational-measure-form-sheet")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("socio-educational-measure-form-member").click();
    await page.getByRole("option", { name: "E2E 11550 Adolescente 2", exact: true }).click();
    await page.getByTestId("socio-educational-measure-form-type").click();
    await page.getByRole("option", { name: "Liberdade assistida (LA)", exact: true }).click();
    await page.getByTestId("socio-educational-measure-form-process").fill(PROCESS_LA);
    await page.getByTestId("socio-educational-measure-form-started-month").click();
    await page.getByRole("option", { name: "Maio", exact: true }).click();
    await page.getByTestId("socio-educational-measure-creas-yes").click();
    await page.getByTestId("socio-educational-measure-form-submit").click();
    const row = page
      .locator('[data-testid^="socio-educational-measure-row-"]')
      .filter({ hasText: PROCESS_LA });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.scrollIntoViewIfNeeded();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA05/CA05b/CA05c — o Mapa de agosto/2026 conta a situação uma vez para o E2E CREAS e não soma a família não encaminhada", async ({}, testInfo) => {
    const page = shared!;
    await page.goto("/app/protecao-especial/mapa-creas?start_month=2026-08&end_month=2026-08");
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("creas-record-map-rule-notice")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`creas-record-map-unit-${UNIT_CREAS}`)).toBeVisible();
    // …11550004: CRAS + CREAS, mesma pessoa/situação/mês ⇒ 1. …11550005 (sem encaminhamento) não soma.
    await expect(
      page.getByTestId(`cell-${UNIT_CREAS}-2026-08-${MAP_SITUATION}-confirmed`),
    ).toHaveText("1");
    const res = await api(page, "get", "creas-record-maps?start_month=2026-08&end_month=2026-08");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("11550");
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA08 — o auxiliar administrativo não vê os quadros de violência nem a aba de medidas (a evidência é a ausência)", async ({ browser }, testInfo) => {
    const page = await startSession(browser, ADMIN[0]!, ADMIN[1]!);
    await open(page, F1, "violencia");
    await expect(page.getByTestId("family-confidentiality-notice")).toBeVisible({ timeout: 15_000 });
    // A aba Violência existe para o CRAS (Quadro 2), mas sem os Quadros 1 e 3 para o não técnico.
    await expect(page.getByRole("tab", { name: "Medidas socioeducativas", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("violence-records-section")).toHaveCount(0);
    await expect(page.getByTestId("violence-history-section")).toHaveCount(0);
    await expect(page.getByTestId("violence-records-register")).toHaveCount(0);
    await page.getByRole("tab", { name: "Proteção Social Especial", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Quadros de violência" })).toHaveCount(0);
    await page.waitForTimeout(600);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
    await open(page, F1, "medidas-socioeducativas");
    await expect(page.getByTestId("socio-educational-measure-block")).toHaveCount(0);
  });

  test("RN09 — o Master lê o Quadro 3 da família encaminhada sem as ações de registrar (sentinela da #11548)", async ({ browser }, testInfo) => {
    const page = await startSession(browser, MASTER[0]!, MASTER[1]!);
    await open(page, F2, "violencia");
    await expect(page.getByTestId("violence-records-section")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("violence-records-register")).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });
});
