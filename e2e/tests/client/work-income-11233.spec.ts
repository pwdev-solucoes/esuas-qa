import { expect, test, type Page } from "@playwright/test";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-DIAG2-04 (HU #11233) — trabalho e rendimentos completos, no frontend do
 * TENANT (`client/`). Spec MANUAL. O cenário declarativo E2E-018 cobre
 * CA01/CA02/CA03 (declarado ao lado do calculado) e o CT02. Aqui ficam, NESTA
 * ORDEM:
 *
 *  - CA05 (Silva): o draft abre ANTES de existir retrato, com o selo "CadÚnico"
 *    nas duas rendas (por isso este caso vem primeiro e nunca grava);
 *  - CA04 (Souza): Bolsa Família R$ 600,00 e a soma com programas (1.800,00);
 *  - CA06 (Silva): BPC só leitura; a evidência inclui a AUSÊNCIA de campo de
 *    beneficiário do BPC no formulário;
 *  - CA07 (Silva): lembrete de elegibilidade com o texto do instrumento.
 *
 * ## Massa (E2EWorkIncomeSeeder, api)
 * "E2E Silva Renda" …0000000f1233 (CadÚnico, per capita 150,00, total 450,00,
 * sem Bolsa Família, BPC) e "E2E Souza Renda" …0000000f2233 (Bolsa Família).
 * Rode o seeder ANTES (reabre o CA05) e o E2E-018 (happy_path) ANTES deste
 * arquivo: o CA04 lê o retrato que ele grava na Souza. Sessão herdada do
 * `chromium-tenant` (Operacional). Nenhuma credencial é gravada aqui.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_SILVA = "00000000-0000-4000-8000-0000000f1233";
const FAMILY_SOUZA = "00000000-0000-4000-8000-0000000f2233";
const EVIDENCE_SLUG = "11233-trabalho-e-rendimentos-completos";

test.use({
  baseURL: BASE,
  locale: "pt-BR",
  viewport: { width: 1440, height: 1600 },
});
test.describe.configure({ mode: "serial" });

async function openBlock(page: Page, uuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${uuid}?tab=trabalho-renda`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("work-income-block")).toBeVisible({
    timeout: 15_000,
  });
}

async function openSilvaDraft(page: Page): Promise<void> {
  await openBlock(page, FAMILY_SILVA);
  const register = page
    .getByTestId("work-income-block")
    .getByTestId("snapshot-register");
  await expect(
    register,
    "a Silva nasce sem retrato de trabalho (rode o seeder)",
  ).toBeVisible({ timeout: 15_000 });
  await register.click();
  await expect(page.getByTestId("work-income-family-fields")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("US-DIAG2-04 — trabalho e rendimentos completos (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test("CA05 — o draft da Silva abre antes de existir retrato, com o selo CadÚnico nas duas rendas", async ({
    page,
  }, testInfo) => {
    await openSilvaDraft(page);

    for (const field of [
      "declared_total_income",
      "declared_per_capita_income",
    ]) {
      await expect(
        page.getByTestId(`work-income-${field}-cadunico`),
      ).toContainText(/CadÚnico/);
    }
    await expect(page.getByTestId("work-income-declared_total_income")).toHaveValue(
      "450,00",
    );
    await expect(
      page.getByTestId("work-income-declared_per_capita_income"),
    ).toHaveValue("150,00");
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "selo-cadunico");
    await page.keyboard.press("Escape");
  });

  test("CA04 — a Souza mostra Bolsa Família de R$ 600,00 e a soma com programas", async ({
    page,
  }, testInfo) => {
    await openBlock(page, FAMILY_SOUZA);
    const block = page.getByTestId("work-income-block");

    await expect(
      block.getByTestId("snapshot-series"),
      "rode o E2E-018 (happy_path) antes",
    ).toContainText("Bolsa Família: R$ 600,00");
    await expect(
      block.getByTestId("work-income-comparison-computed-total_income_with_programs"),
    ).toContainText("1.800,00");
    await expect(block.getByTestId("programs-received-bolsa-state")).toContainText(
      /Recebe/,
    );
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "renda-com-programas");
  });

  test("CA06 — o BPC da Silva é só leitura e o formulário não tem campo de beneficiário", async ({
    page,
  }, testInfo) => {
    await openSilvaDraft(page);
    const panel = page.getByTestId("programs-received-panel");

    await expect(panel.getByTestId("programs-received-bpc-value")).toContainText(
      /Benefici/,
    );
    // Ausência: o painel não tem nenhum controle editável, e o formulário não
    // oferece campo de beneficiário do BPC (só o valor recebido).
    await expect(panel.locator("input, select, textarea")).toHaveCount(0);
    await expect(
      page
        .getByTestId("work-income-snapshot-fields")
        .locator('[data-testid*="beneficiar"], [id*="beneficiar"]'),
    ).toHaveCount(0);
    await panel.scrollIntoViewIfNeeded();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "bpc-somente-leitura");
    await page.keyboard.press("Escape");
  });

  test("CA07 — a Silva vê o lembrete de elegibilidade com o texto do instrumento", async ({
    page,
  }, testInfo) => {
    await openSilvaDraft(page);

    await expect(page.getByTestId("eligibility-reminder-text")).toContainText(
      "Fique atento para identificar famílias potencialmente elegíveis",
    );
    await expect(page.getByTestId("eligibility-reminder-items")).toContainText(
      /Bolsa Família/,
    );
    await page.getByTestId("eligibility-reminder").scrollIntoViewIfNeeded();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "lembrete-elegibilidade");
    await page.keyboard.press("Escape");
  });
});
