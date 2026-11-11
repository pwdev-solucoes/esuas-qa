import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-MSE-01 (HU #11295) — complemento do `medidas-socioeducativas-11295.spec.ts`
 * com a persona e a tela exatas do ticket:
 *
 *  - CA04: uma PSICÓLOGA do CRAS Centro vê o bloco de medidas e NÃO tem
 *    "Registrar medida" (a condução é do CREAS — US-AJ-15 #11550, RN07);
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
    page.getByRole("tablist", { name: "Grupos do prontuário" }),
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

  test("CA04 — a psicóloga do CRAS Centro vê as medidas, mas não registra: a condução é do CREAS (US-AJ-15 RN07)", async ({}, testInfo) => {
    await open(user, "medidas-socioeducativas");
    await expect(user.getByTestId("socio-educational-measure-block")).toBeVisible({
      timeout: 15_000,
    });
    // A evidência é a ausência: o CRAS só identifica; registrar a medida cabe ao CREAS.
    await expect(
      user.getByTestId("socio-educational-measure-register-action"),
    ).toHaveCount(0);
    await captureEvidence(user, testInfo, EVIDENCE_SLUG, "psicologa-cras-sem-registrar");
  });

  test("CA06 — o técnico abre o acolhimento e vê \"adolescente cumprindo internação\" sem marcação à parte", async ({}, testInfo) => {
    await open(user, "acolhimento");
    const derived = user.getByTestId("sheltering-derived-internment");
    await expect(derived).toBeVisible({ timeout: 15_000 });
    await expect(derived).toContainText(/cumprindo internação/i);
    await captureEvidence(user, testInfo, EVIDENCE_SLUG, "acolhimento-internacao-derivada");
  });
});
