import { expect, test, type Page } from "@playwright/test";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-VISIB-02 (HU #11289) — lado Painel Global (`admin/`, guard `manager`):
 * função técnica no CBO, catálogo "Sigilo do prontuário" e consulta do Operacional
 * Global. Spec MANUAL (CA09, lado Painel Global); o E2E-026 cobre o núcleo.
 *
 * ## Estado — ALTERA dados globais e RESTAURA na mesma execução
 * - liga e desliga o sigilo de `follow_up_planning` (volta a "Não sigilosa");
 * O helper `setFollowUpConfidential` é idempotente: relê o estado antes de agir.
 * A marcação em lote do CBO fica no E2E-026 / Pest (aqui só o filtro).
 *
 * Sessão do Administrador herdada (`chromium`); 1 login do Operacional Global.
 */

const EVIDENCE_SLUG = "us-visib-02-sigilo-tecnico";
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";

async function openPage(page: Page, path: string, ready: string) {
  await page.goto(path);
  await dismissPlatformUpdates(page);
  await expect(page.locator(ready).first()).toBeVisible();
  await dismissPlatformUpdates(page);
}

async function setFollowUpConfidential(page: Page, wanted: "Sigilosa" | "Não sigilosa") {
  const badge = page.locator('[data-testid="record-section-confidential-follow_up_planning"]');
  if ((await badge.innerText()).trim() === wanted) return;
  await page.locator('[data-testid="record-section-edit-follow_up_planning"]').click();
  await expect(page.locator('[data-testid="record-section-form-sheet"]')).toBeVisible();
  await page.waitForTimeout(800);
  await page.locator('[data-testid="record-section-form-confidential"]').click();
  await page.locator('[data-testid="record-section-form-submit"]').click();
  await expect(badge).toHaveText(wanted);
  await page.waitForTimeout(1200);
}

test.describe.configure({ mode: "serial" });

test.describe("US-VISIB-02 #11289 — Sigilo do prontuário no Painel Global", () => {
  test.use({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 1440, height: 900 } });

  test("CA09 — o Administrador filtra a função técnica no CBO", async ({ page }, testInfo) => {
    await openPage(page, "/app/cbos", "tbody tr");
    await page.getByRole("button", { name: "Filtros" }).click();
    await page.locator('[data-testid="cbos-filter-technical"]').click();
    await page.getByRole("option", { name: "Sim", exact: true }).click();
    await page.getByPlaceholder("Buscar por código ou nome da ocupação...").fill("Assistente social");
    await page.waitForTimeout(1500);
    await expect(page.getByText("Assistente social", { exact: true }).first()).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "ca09-cbo-funcao-tecnica");
  });

  test("CA09 — a lista Sigilo do prontuário traz as 20 seções e o Administrador liga e desliga o sigilo", async ({ page }, testInfo) => {
    await openPage(page, "/app/record-sections", '[data-testid="record-sections-table"]');
    await expect(page.locator('[data-testid^="record-section-row-"]')).toHaveCount(20);
    await expect(page.locator('[data-testid="record-section-confidential-health_conditions"]')).toContainText("Sigilosa");
    await setFollowUpConfidential(page, "Não sigilosa");
    await setFollowUpConfidential(page, "Sigilosa");
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "ca09-admin-sigilo-edicao");
    await setFollowUpConfidential(page, "Não sigilosa");
    await expect(page.locator('[data-testid="record-section-confidential-follow_up_planning"]')).toContainText("Não sigilosa");
  });

  test.describe("Operacional Global", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("CA09 — o Operacional Global só lê o catálogo, sem a ação Editar", async ({ page }, testInfo) => {
    await page.goto("/auth/login");
    await page.locator("input#cpf").fill(process.env.E2E_ADMIN_OPERADOR_CPF ?? "");
    await page.locator("input#password").fill(process.env.E2E_ADMIN_OPERADOR_PASSWORD ?? "");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/app/);
    await openPage(page, "/app/record-sections", '[data-testid="record-sections-table"]');
    await expect(page.locator('[data-testid="record-section-row-health_conditions"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "ca09-operacional-so-le");
    });
  });
});
void API_BASE;
