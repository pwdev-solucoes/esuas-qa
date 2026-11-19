import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * HU #11651 (parte 2, 2 logins — ⚠️ `throttle:6,1`): CA15 (técnico com lotação em dois CRAS troca a unidade de
 * referência entre elas, com o aviso e a auditoria) e CA19 (auxiliar com o add-on LGPD vê o Quadro 2, sem os
 * Quadros 1 e 3 — a evidência é a ausência). Roda 65 s depois do `anotacao-regra-bloco-11651.spec.ts`.
 * Massa: `E2ENoteFollowsBlockSeeder` (reposta pelo container). Nunca imprime CPF, nome ou texto de nota.
 */

const BASE = process.env.CLIENT_BASE_URL ?? "http://localhost:5174";
const TENANT_UUID = process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const API_CONTAINER = process.env.E2E_API_CONTAINER ?? "api-laravel.test-1";
const REPORT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "e2e", "reports", "11651-anotacao-regra-bloco-master-troca-unidade-acceptance");
const SHOTS = path.join(REPORT_DIR, "screenshots");
const F4 = "00000000-0000-4000-8000-000011651004";
const F9 = "00000000-0000-4000-8000-000011651009";

const TWO_CRAS = { cpf: process.env.E2E_CLIENT_TWO_CRAS_TECNICO_CPF ?? "", password: process.env.E2E_CLIENT_TWO_CRAS_TECNICO_PASSWORD ?? "" };
const AUX = { cpf: process.env.E2E_CLIENT_ADMIN_STAFF_CPF ?? "", password: process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD ?? "" };

function reseed(): void {
  try {
    execFileSync("docker", ["exec", API_CONTAINER, "php", "artisan", "db:seed", "--class=Database\\Seeders\\E2ENoteFollowsBlockSeeder", "--force"], { stdio: "ignore", timeout: 120_000 });
  } catch {
    console.warn("[11651] não foi possível repor a massa pelo container; rode o E2ENoteFollowsBlockSeeder.");
  }
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test.describe.configure({ mode: "serial" });

test.describe("HU #11651 — troca entre as lotações e Quadro 2 do auxiliar", () => {
  test.use({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1600 } });
  test.setTimeout(240_000);

  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1600 } });
  });
  test.afterAll(async () => {
    await page?.close();
    reseed();
  });

  test("CA15 — o técnico com dois CRAS troca a unidade entre as suas lotações", async () => {
    reseed();
    await loginAsTenantUser(page, TWO_CRAS.cpf, TWO_CRAS.password, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(page);
    await page.goto(`/app/cadastros/familias/${F4}`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("family-reference-unit")).toContainText("Centro", { timeout: 20_000 });
    await page.getByTestId("family-change-unit").click();
    await expect(page.getByTestId("change-reference-unit-dialog")).toBeVisible();
    await page.getByTestId("change-unit-trigger").click();
    await page.getByRole("option", { name: /Rural/i }).first().click();
    await page.getByTestId("change-submit").click();
    const aviso = page.getByTestId("change-previous-unit-warning");
    await expect(aviso).toContainText(/deixará de enxergar/i, { timeout: 15_000 });
    await expect(page.getByTestId("change-submit")).toContainText(/confirmar a troca/i);
    await shot(page, "CA15-aviso-de-acesso-antes-de-confirmar");
    await page.getByTestId("change-submit").click();
    await expect(page.getByTestId("change-reference-unit-dialog")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("family-reference-unit")).toContainText("Rural");
    await shot(page, "CA15-troca-concluida");
  });

  test("CA19 — o auxiliar com o add-on LGPD vê o Quadro 2, sem os Quadros 1 e 3", async () => {
    await loginAsTenantUser(page, AUX.cpf, AUX.password, { tenantUuid: TENANT_UUID });
    await dismissPlatformUpdates(page);
    await page.goto(`/app/cadastros/familias/${F9}?tab=violencia`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("violence-tab")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("creas-periods-section")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("violence-records-section")).toHaveCount(0);
    await expect(page.getByTestId("violence-history-form")).toHaveCount(0);
    await expect(page.getByTestId("violence-history-register")).toHaveCount(0);
    await shot(page, "CA19-quadro2-sem-quadros-1-e-3");
  });
});
