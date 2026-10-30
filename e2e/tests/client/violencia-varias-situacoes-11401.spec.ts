import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-03 (HU #11401) — várias situações, vários órgãos e medida protetiva no
 * Quadro 3 (aba "Violência"). Spec MANUAL de 1 login (operador do CREAS): o
 * cenário E2E-039 cobre CA01, CA02, CA04 e CA06; aqui ficam:
 *  - CA03: "Registrar notificação" no `…a01` com Conselho Tutelar (12/10/2026) e
 *    Ministério Público (13/10/2026) -> duas linhas de órgão no item;
 *  - CA05: o Mapa do CREAS conta cada situação UMA vez — prova por DIFERENÇA
 *    (lê as células de 09/2026, registra duas situações confirmadas num envio e
 *    relê: +1 em cada). Nunca asserção de valor absoluto.
 *
 * Massa: E2EViolenceMultiSituationSeeder (api; tudo fictício). ATENÇÃO: o Mapa conta
 * pessoa+situação uma vez por mês; o E2E-039 já registra "psicológica" para a Carla em
 * 09/2026. Reponha a massa (`db:seed --class=E2EViolenceMultiSituationSeeder`) entre o
 * E2E-039 e esta spec, senão a célula de psicológica não sobe (+0, não +1).
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY = "00000000-0000-4000-8000-000011401001";
const CREAS_UUID = "00000000-0000-4000-8000-0000000e0002";
const MAP_ROUTE = "/app/protecao-especial/mapa-creas";
const EVIDENCE_SLUG = "11401-violencia-varias-situacoes";

const OPERADOR = {
  cpf: process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "99000140064",
  password: process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "senha123",
};

function cell(code: string): string {
  return `cell-${CREAS_UUID}-2026-09-${code}-confirmed`;
}

async function readCell(page: Page, code: string): Promise<number> {
  const el = page.getByTestId(cell(code));
  await expect(el).toBeVisible({ timeout: 15_000 });
  return Number.parseInt((await el.innerText()).trim(), 10);
}

async function openMap(page: Page): Promise<void> {
  await page.goto(`${MAP_ROUTE}?start_month=2026-09&end_month=2026-09`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("creas-record-map-rule-notice")).toBeVisible({
    timeout: 15_000,
  });
}

async function openViolence(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=violencia`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("violence-records-section")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-03 #11401 — várias situações no Quadro 3 (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({
      baseURL: BASE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1600 },
    });
    await loginAsTenantUser(page, OPERADOR.cpf, OPERADOR.password, {
      tenantUuid: TENANT_UUID,
    });
    await dismissPlatformUpdates(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("CA03 — a notificação com dois órgãos mostra duas linhas no item", async ({}, testInfo) => {
    await openViolence(page);
    const item = page
      .getByTestId("violence-record-item")
      .filter({ hasText: "Violência física" })
      .filter({ hasText: "08/2026" });
    await expect(item).toBeVisible({ timeout: 15_000 });

    await item.getByTestId("violence-record-notify").click();
    const dialog = page.getByTestId("violence-notification-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByTestId("violence-record-notification-done-yes").click();

    const row = (i: number) =>
      dialog.locator(
        `[data-testid="violence-record-body-row"][data-index="${i}"]`,
      );
    await row(0).getByTestId("violence-record-notified-on").fill("2026-10-12");
    await row(0).getByTestId("violence-record-body-select").click();
    await page
      .getByRole("option", { name: "Conselho Tutelar", exact: true })
      .click();
    await dialog.getByTestId("violence-record-body-add").click();
    await expect(row(1)).toBeVisible();
    await row(1).getByTestId("violence-record-notified-on").fill("2026-10-13");
    await row(1).getByTestId("violence-record-body-select").click();
    await page
      .getByRole("option", { name: "Ministério Público", exact: true })
      .click();
    await dialog.getByTestId("violence-notification-submit").click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    const bodies = page
      .getByTestId("violence-record-item")
      .filter({ hasText: "Violência física" })
      .filter({ hasText: "08/2026" })
      .getByTestId("violence-record-notification-body");
    await expect(bodies).toHaveCount(2, { timeout: 10_000 });
    await expect(bodies.nth(0)).toContainText("12/10/2026");
    await expect(bodies.nth(1)).toContainText("13/10/2026");
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA05 — o Mapa conta cada situação registrada num envio uma vez (prova por diferença, 09/2026)", async ({}, testInfo) => {
    await openMap(page);
    const before = {
      psico: await readCell(page, "2"),
      negl: await readCell(page, "5"),
    };

    await openViolence(page);
    await page.getByTestId("violence-records-register").click();
    const sheet = page.getByTestId("violence-record-form-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheet.getByTestId("violence-record-member-select").click();
    await page
      .getByRole("option", { name: "E2E Multi Carla", exact: true })
      .click();

    const srow = (i: number) =>
      sheet.locator(
        `[data-testid="violence-record-situation-row"][data-index="${i}"]`,
      );
    await srow(0).getByTestId("violence-record-situation-select").click();
    await page
      .getByRole("option", { name: "Violência psicológica", exact: true })
      .click();
    await srow(0).getByTestId("violence-record-evidence-level").click();
    await page.getByRole("option", { name: "Confirmada", exact: true }).click();
    await sheet.getByTestId("violence-record-situation-add").click();
    await expect(srow(1)).toBeVisible();
    await srow(1).getByTestId("violence-record-situation-select").click();
    await page
      .getByRole("option", { name: "Negligência ou abandono", exact: true })
      .click();
    await srow(1).getByTestId("violence-record-evidence-level").click();
    await page.getByRole("option", { name: "Confirmada", exact: true }).click();
    await sheet.getByTestId("violence-record-month-select").click();
    await page.getByRole("option", { name: "Setembro", exact: true }).click();
    await sheet.getByTestId("violence-record-protective-measure-no").click();
    await sheet.getByTestId("violence-record-notification-done-no").click();
    await sheet.getByTestId("violence-record-submit").click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });

    await openMap(page);
    await expect.poll(() => readCell(page, "2")).toBe(before.psico + 1);
    await expect.poll(() => readCell(page, "5")).toBe(before.negl + 1);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });
});
