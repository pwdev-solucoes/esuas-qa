import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-VIOL-02 (HU #11291) — complemento do `historico-violencias-11291.spec.ts`
 * com a persona exata do CA03: uma PSICÓLOGA do CREAS (o principal usa o
 * operador do CREAS, assistente social) lê o Quadro 1 registrado pelo CRAS
 * Centro na família que o CREAS acompanha.
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`)
 * Um login: `E2E_CLIENT_DUAL_ROLE` (massa da #11289), psicólogo social (2515-30)
 * no CREAS e assistente administrativo no CRAS Rural — aqui o acesso é pelo CREAS.
 *
 * ## Massa (api; tudo fictício)
 * `E2EViolenceHistorySeeder`: `…000011291001` com Violência física e Trabalho
 * infantil anotadas pelo CRAS Centro em 09/2026 e acompanhamento do CREAS.
 * Ressemear antes da rodada (o spec principal atualiza a Violência física).
 *
 * Nunca registra nem imprime CPF, nome ou situação em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY_A = "00000000-0000-4000-8000-000011291001";

const CREAS_PSYCHOLOGIST = {
  cpf: process.env.E2E_CLIENT_DUAL_ROLE_CPF ?? "99000150370",
  password: process.env.E2E_CLIENT_DUAL_ROLE_PASSWORD ?? "senha123",
};

const EVIDENCE_SLUG = "11291-historico-violencias-quadro-1";

// Códigos do produto no lookup da #11290.
const PHYSICAL = "04";
const CHILD_LABOR = "01";

test.describe("US-VIOL-02 — Quadro 1, persona do ticket (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  let user: Page;

  test.beforeAll(async ({ browser }) => {
    user = await browser.newPage({
      baseURL: BASE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1600 },
    });
    await loginAsTenantUser(user, CREAS_PSYCHOLOGIST.cpf, CREAS_PSYCHOLOGIST.password, {
      tenantUuid: TENANT_UUID,
    });
    await dismissPlatformUpdates(user);
  });

  test.afterAll(async () => {
    await user?.close();
  });

  test("CA03 — a psicóloga do CREAS lê o histórico registrado pelo CRAS Centro", async ({}, testInfo) => {
    await user.goto(`/app/cadastros/familias/${FAMILY_A}?tab=violencia`);
    await dismissPlatformUpdates(user);
    await expect(user.getByTestId("violence-history-section")).toBeVisible({
      timeout: 15_000,
    });
    await expect(user.getByTestId("family-confidentiality-notice")).toHaveCount(0);

    for (const code of [CHILD_LABOR, PHYSICAL]) {
      const line = user.getByTestId(`violence-history-row-${code}`);
      await expect(line).toContainText("Vivida — persiste", { timeout: 15_000 });
      await expect(
        user.getByTestId(`violence-history-month-${code}`),
      ).toContainText("09/2026");
      await expect(
        line.getByTestId("violence-history-signature"),
      ).toContainText("CRAS Centro");
    }
    await captureEvidence(user, testInfo, EVIDENCE_SLUG, "psicologa-creas-le");
  });
});
