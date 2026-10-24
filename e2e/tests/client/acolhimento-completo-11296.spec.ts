import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-ACOLH2-01 (HU #11296) — bloco de acolhimento completo na aba "Acolhimento"
 * do prontuário (`client/`). Spec MANUAL: o cenário declarativo E2E-034 cobre o
 * técnico do CRAS Centro (CA01 a CA05) e o não técnico; aqui ficam a correção
 * (CA03 e RN07, sessão herdada do operador), o Master (CA06b) e a ausência do
 * não técnico com a API (CA06).
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`) — 2 logins, ordem fixa
 *  1. operador do CRAS Centro (sessão herdada do project `chromium-tenant`, sem login);
 *  2. Master: lê o acolhimento anterior e a internação derivada, sem ações de registrar;
 *  3. não técnico do CRAS Centro: aba ausente; API sem registros e PUT → 403.
 *
 * ## Massa (E2EShelteringCompleteSeeder, api; tudo fictício)
 * Família `…000011296001`. O seeder repõe a prisão em "não informado" mas não apaga
 * o que o E2E cria: as asserções são pelo item da execução (motivo com carimbo).
 * Nunca imprime CPF/nome em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY = "00000000-0000-4000-8000-000011296001";
const PRIOR_REASON = "Registro anterior da massa E2E";
const EVIDENCE_SLUG = "11296-bloco-acolhimento-completo";

const ADMIN_STAFF = {
  cpf: process.env.E2E_CLIENT_ADMIN_STAFF_CPF ?? "99000150108",
  password: process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD ?? "senha123",
};
const MASTER = {
  cpf: process.env.E2E_CLIENT_MASTER_CPF ?? "52998224725",
  password: process.env.E2E_CLIENT_MASTER_PASSWORD ?? "senha123",
};

async function open(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=acolhimento`);
  await dismissPlatformUpdates(page);
  await expect(
    page.getByRole("tab", { name: "Composição Familiar", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

async function api(
  user: Page,
  method: "get" | "post" | "put",
  suffix: string,
): Promise<APIResponse> {
  const cookies = await user.context().cookies();
  const xsrf = decodeURIComponent(
    cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "",
  );
  return user
    .context()
    .request[method](`${API_BASE}/api/client/families/${FAMILY}/${suffix}`, {
      ...(method !== "get" ? { data: {} } : {}),
      headers: {
        Accept: "application/json",
        Origin: BASE!,
        Referer: `${BASE}/app`,
        "X-Requested-With": "XMLHttpRequest",
        "X-Tenant-UUID": TENANT_UUID,
        "X-XSRF-TOKEN": xsrf,
      },
    });
}

async function loginNew(
  browser: import("@playwright/test").Browser,
  user: { cpf: string; password: string },
): Promise<Page> {
  const page = await browser.newPage({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });
  await loginAsTenantUser(page, user.cpf, user.password, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(page);
  return page;
}

test.describe("US-ACOLH2-01 — bloco de acolhimento completo (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");
  test.describe.configure({ mode: "serial" });

  test.describe("operador do CRAS Centro (sessão herdada)", () => {
    test.use({
      baseURL: BASE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1600 },
    });

    test("CA03 — corrige a marcação de prisão de Sim para Não informado e a data some", async ({
      page,
    }, testInfo) => {
      await open(page);
      await expect(
        page.getByTestId("sheltering-incarceration-card"),
      ).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("sheltering-incarceration-option-yes").check();
      await page.getByTestId("sheltering-incarceration-date").fill("2026-09-01");
      await page.getByTestId("sheltering-incarceration-save").click();
      await expect(
        page.locator(
          '[data-testid="sheltering-incarceration-state"][data-state="yes"]',
        ),
      ).toBeVisible({ timeout: 10_000 });

      await page
        .getByTestId("sheltering-incarceration-option-not_informed")
        .check();
      await expect(
        page.getByTestId("sheltering-incarceration-date"),
      ).toHaveCount(0);
      await page.getByTestId("sheltering-incarceration-save").click();
      await expect(
        page.locator(
          '[data-testid="sheltering-incarceration-state"][data-state="not_informed"]',
        ),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByTestId("sheltering-incarceration-date"),
      ).toHaveCount(0);
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, "prisao-corrigida");
    });

    test("RN07 — corrige o fim do acolhimento do grupo familiar e o item mostra o novo período e Corrigido por", async ({
      page,
    }, testInfo) => {
      const reason = `Correção do período ${Date.now()} (massa fictícia)`;
      await open(page);
      await page.getByTestId("sheltering-group-register-action").click();
      await expect(page.getByTestId("sheltering-group-form-sheet")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByTestId("sheltering-group-form-started").fill("2026-07");
      await page.getByTestId("sheltering-group-form-ended").fill("2026-08");
      await page.getByTestId("sheltering-group-form-reason").fill(reason);
      await page.getByTestId("sheltering-group-form-submit").click();

      const row = page
        .locator('[data-testid^="sheltering-group-row-"]')
        .filter({ hasText: reason });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toContainText("07/2026 a 08/2026");
      await expect(page.getByTestId("sheltering-group-form-sheet")).toBeHidden();

      await row.locator('[data-testid^="sheltering-group-correct-"]').click();
      await expect(page.getByTestId("sheltering-group-form-sheet")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByTestId("sheltering-group-form-ended").fill("2026-09");
      await page.getByTestId("sheltering-group-form-submit").click();

      await expect(page.getByTestId("sheltering-group-form-sheet")).toBeHidden({
        timeout: 10_000,
      });
      await expect(row).toContainText("07/2026 a 09/2026", { timeout: 10_000 });
      await expect(row).toContainText("Corrigido por");
      await page.waitForTimeout(1500);
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, "correcao");
    });
  });

  test.describe("Master", () => {
    let user: Page;
    test.beforeAll(async ({ browser }) => {
      user = await loginNew(browser, MASTER);
    });
    test.afterAll(async () => {
      await user?.close();
    });

    test("CA06b — o Master lê o acolhimento e a internação derivada, sem ação de registrar, e o POST é 403 (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user);
      await expect(user.getByTestId("sheltering-group-section")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        user
          .locator('[data-testid^="sheltering-group-row-"]')
          .filter({ hasText: PRIOR_REASON }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        user.getByTestId("sheltering-derived-internment"),
      ).toBeVisible();
      await expect(
        user.getByTestId("sheltering-group-register-action"),
      ).toHaveCount(0);
      await expect(
        user.getByTestId("sheltering-custody-register-action"),
      ).toHaveCount(0);
      await expect(
        user.getByTestId("sheltering-incarceration-save"),
      ).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "master-le");

      const post = await api(user, "post", "group-shelterings");
      expect(post.status(), "POST do Master").toBe(403);
      expect(JSON.stringify(await post.json())).toContain(
        "sheltering_master_read_only",
      );
    });
  });

  test.describe("não técnico do CRAS Centro", () => {
    let user: Page;
    test.beforeAll(async ({ browser }) => {
      user = await loginNew(browser, ADMIN_STAFF);
    });
    test.afterAll(async () => {
      await user?.close();
    });

    test("CA06 — o não técnico não vê a aba Acolhimento e a API não sinaliza registros (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user);
      await expect(
        user.getByRole("tab", { name: "Acolhimento", exact: true }),
      ).toHaveCount(0);
      await expect(user.getByTestId("sheltering-block")).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "aba-ausente");

      const groups = await api(user, "get", "group-shelterings");
      expect(groups.status(), "GET group-shelterings").toBe(200);
      expect((await groups.json()).data).toEqual([]);

      const marker = await api(user, "get", "incarceration-marker");
      expect(marker.status(), "GET incarceration-marker").toBe(200);
      expect((await marker.json()).data).toBeNull();

      const sh = await api(user, "get", "shelterings");
      expect(sh.status(), "GET shelterings").toBe(200);
      expect((await sh.json()).derived?.adolescent_in_internment).toBe(false);

      const put = await api(user, "put", "incarceration-marker");
      expect(put.status(), "PUT incarceration-marker").toBe(403);
      expect(JSON.stringify(await put.json())).toContain("block_restricted");
    });
  });
});
