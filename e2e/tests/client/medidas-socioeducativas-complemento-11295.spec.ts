import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-MSE-01 (HU #11295) — complemento do `medidas-socioeducativas-11295.spec.ts`
 * com a persona e a tela exatas do ticket:
 *
 *  - CA04: uma PSICÓLOGA do CRAS Centro (o principal usa a assistente social;
 *    a psicóloga só estava no Pest) registra uma medida e ela é salva;
 *  - CA06: um técnico abre o bloco de acolhimento e vê "adolescente cumprindo
 *    internação" derivado da internação em curso de Pedro (o principal provava
 *    só a regra, no Pest; a tela é entregue pela #11296).
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`)
 * Um login: `E2E_CLIENT_CENTRO_PSYCHOLOGIST` (massa da #11289, psicólogo social
 * 2515-30 no CRAS Centro).
 *
 * ## Massa (api; tudo fictício)
 * `E2ESocioEducationalMeasureSeeder`: família `…000011295001`, Pedro com LA
 * encerrada e internação em curso. Ressemear antes da rodada (o seeder remove as
 * medidas registradas pelas specs).
 *
 * Asserções pelo processo, nunca por contagem. Nunca imprime CPF ou nome em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY = "00000000-0000-4000-8000-000011295001";
const PROCESS_PSYCHOLOGIST = "0005555-56.2026.8.02.0001";
const EVIDENCE_SLUG = "11295-historico-medidas-socioeducativas";

const CENTRO_PSYCHOLOGIST = {
  cpf: process.env.E2E_CLIENT_CENTRO_PSYCHOLOGIST_CPF ?? "99000150701",
  password: process.env.E2E_CLIENT_CENTRO_PSYCHOLOGIST_PASSWORD ?? "senha123",
};

async function open(page: Page, tab: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=${tab}`);
  await dismissPlatformUpdates(page);
  await expect(
    page.getByRole("tab", { name: "Composição Familiar", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("US-MSE-01 — medidas socioeducativas, persona e tela do ticket (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });

  let user: Page;

  test.beforeAll(async ({ browser }) => {
    user = await browser.newPage({
      baseURL: BASE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1600 },
    });
    await loginAsTenantUser(
      user,
      CENTRO_PSYCHOLOGIST.cpf,
      CENTRO_PSYCHOLOGIST.password,
      { tenantUuid: TENANT_UUID },
    );
    await dismissPlatformUpdates(user);
  });

  test.afterAll(async () => {
    await user?.close();
  });

  test("CA04 — a psicóloga do CRAS Centro registra uma medida e ela é salva", async ({}, testInfo) => {
    await open(user, "medidas-socioeducativas");
    await expect(user.getByTestId("socio-educational-measure-block")).toBeVisible({
      timeout: 15_000,
    });
    await user.getByTestId("socio-educational-measure-register-action").click();
    await expect(
      user.getByTestId("socio-educational-measure-form-sheet"),
    ).toBeVisible({ timeout: 10_000 });
    await user.getByTestId("socio-educational-measure-form-member").click();
    await user.getByRole("option", { name: "E2E Pedro MSE", exact: true }).click();
    await user.getByTestId("socio-educational-measure-form-type").click();
    await user.getByRole("option", { name: "Advertência", exact: true }).click();
    await user
      .getByTestId("socio-educational-measure-form-process")
      .fill(PROCESS_PSYCHOLOGIST);
    await user.getByTestId("socio-educational-measure-form-started-month").click();
    await user.getByRole("option", { name: "Maio", exact: true }).click();
    await user.getByTestId("socio-educational-measure-form-submit").click();

    const row = user
      .locator('[data-testid^="socio-educational-measure-row-"]')
      .filter({ hasText: PROCESS_PSYCHOLOGIST });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const signature = row.locator(
      '[data-testid^="socio-educational-measure-signature-"]',
    );
    await expect(signature).toContainText("Registrado por");
    await expect(signature).toContainText("Psicólogo");
    await expect(
      user.getByTestId("socio-educational-measure-form-sheet"),
    ).toBeHidden();
    await row.scrollIntoViewIfNeeded();
    await captureEvidence(user, testInfo, EVIDENCE_SLUG, "psicologa-cras-registra");
  });

  test("CA06 — o técnico abre o acolhimento e vê \"adolescente cumprindo internação\" sem marcação à parte", async ({}, testInfo) => {
    await open(user, "acolhimento");
    const derived = user.getByTestId("sheltering-derived-internment");
    await expect(derived).toBeVisible({ timeout: 15_000 });
    await expect(derived).toContainText(/cumprindo internação/i);
    await captureEvidence(user, testInfo, EVIDENCE_SLUG, "acolhimento-internacao-derivada");
  });
});
