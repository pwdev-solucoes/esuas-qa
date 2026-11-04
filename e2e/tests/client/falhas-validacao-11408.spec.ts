import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-11 (HU #11408) — correções da validação. Spec MANUAL multiusuário
 * (o E2E-046 cobre CA01, CA02, CA05 e CA06 com um login por variante).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: 2 logins, sequenciais)
 *  1. técnico do CREAS Sul: CA03 — o menu do Mapa Consolidado aparece LOGO
 *     APÓS o login, SEM recarregar a página (era isso que mascarava o bug:
 *     o F5 trazia o `/auth/me` que o login do tenant único não trazia);
 *  2. operador do CRAS Centro: CA04 — o menu NÃO tem "Proteção Social
 *     Especial" (a evidência é a ausência); CA07 — lê a aba Saúde da
 *     "E2E Silva Saúde" como antes.
 *
 * ## Massa (api)
 * `E2ECreasRecordMapSeeder` (técnico do Sul), `E2EHealthVisibilitySeeder`
 * ("E2E Silva Saúde") e `E2EValidationFixesSeeder` (E2E-046).
 *
 * Credenciais só por variável de ambiente. Nunca registra nem imprime CPF,
 * nome ou dado de saúde em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const EVIDENCE_SLUG = "11408-falhas-validacao";

const SUL = [
  process.env.E2E_CLIENT_CREAS_SUL_TECNICO_CPF,
  process.env.E2E_CLIENT_CREAS_SUL_TECNICO_PASSWORD,
] as const;
const OPERADOR = [
  process.env.E2E_CLIENT_OPERADOR_CPF,
  process.env.E2E_CLIENT_OPERADOR_PASSWORD,
] as const;

const PSE = /Proteção Social Especial/i;
const MAPA = /Mapa Consolidado do CREAS/i;

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

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-11 #11408 — correções da validação", () => {
  test.skip(
    !BASE || !SUL[0] || !SUL[1] || !OPERADOR[0] || !OPERADOR[1],
    "sem URL do client ou credenciais",
  );
  test.afterAll(async () => {
    if (shared) await shared.context().close();
    shared = undefined;
  });

  test("CA03 — o técnico do CREAS Sul vê o menu do Mapa Consolidado logo após o login, sem recarregar", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, SUL[0]!, SUL[1]!);
    // Sem `page.goto` entre o login e a checagem: o menu tem de vir do login.
    await dismissPlatformUpdates(page);
    await expect(page.locator("aside, nav").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: PSE }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: MAPA })).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA04 — o operador do CRAS Centro não vê Proteção Social Especial no menu (a evidência é a ausência)", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, OPERADOR[0]!, OPERADOR[1]!);
    await dismissPlatformUpdates(page);
    await expect(page.locator("aside, nav").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: PSE })).toHaveCount(0);
    await expect(page.getByRole("button", { name: MAPA })).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA07 — o técnico do CRAS Centro lê a aba Saúde da Silva como antes", async ({}, testInfo) => {
    const page = shared!;
    await page.goto("/app/cadastros/pesquisa-pessoas");
    await dismissPlatformUpdates(page);
    await page.locator("input#person-search-family-code").fill("E2E11234");
    await page.locator('main form button[type="submit"]').click();
    await page
      .locator('tr:has([data-testid="rf-badge"]) button[aria-label="Visualizar Família"]')
      .first().click();
    await expect(
      page.getByRole("tab", { name: "Composição Familiar", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: "Saúde", exact: true }).click();
    await expect(page.getByTestId("health-block")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("health-restricted")).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });
});
