import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createTenantApiClient } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * US-SERIE-02 (HU #11226) — plano 03: blocos entregues como série, no
 * frontend do TENANT (`client/`). Spec MANUAL: o cenário declarativo E2E-013
 * cobre CA01, CA02, CA03 e CA04 (endereço migrado e com histórico; renda
 * gerando retrato de trabalho com os três integrantes). Aqui ficam o que ele
 * não expressa:
 *
 *  - CA05: o drawer do integrante segue reunido (educação, renda e saúde
 *    juntas), cada seção com a data e a assinatura do retrato de origem;
 *  - CA05-SERIE01: a série de trabalho da família Souza tem três retratos e a
 *    renda de Maria aparece marcada com "Mudou" (marcador, não só cor);
 *  - CA03 (ausência): alterar só a renda cria UM retrato de trabalho e NENHUM
 *    de educação nem de saúde (contagem pela API antes e depois).
 *
 * ## Massa e re-execução
 *
 * `E2EDeliveredBlocksSeriesSeeder` (api): Silva (retratos migrados) e Souza
 * (três retratos de trabalho). ⚠️ O CA03 ALTERA a Silva (e o E2E-013 também):
 * reexecute o seeder antes de repetir (ele recompõe os cinco blocos). Sessão
 * herdada do project `chromium-tenant`. Nunca imprime CPF, nome ou dado
 * pessoal.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_SILVA = "00000000-0000-4000-8000-0000000f0301";
const FAMILY_SOUZA = "00000000-0000-4000-8000-0000000f0302";
const UNIT_NAME = "E2E CRAS Centro";

let api: APIRequestContext;

async function total(familyUuid: string, block: string): Promise<number> {
  const response = await api.get(
    `/api/client/families/${familyUuid}/diagnosis-snapshots?block=${block}&per_page=1`,
  );
  expect(response.status(), `série de ${block}`).toBe(200);
  const body = await response.json();
  return Number(body.meta?.total ?? 0);
}

async function openComposition(page: Page, familyUuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=composicao`);
  await dismissPlatformUpdates(page);
  // O contêiner existe mesmo quando a aba padrão (educação) está vazia, como na Souza.
  await expect(page.getByTestId("member-conditions-series")).toBeVisible({
    timeout: 15_000,
  });
}

test.beforeAll(async () => {
  if (!BASE) return;
  api = await createTenantApiClient();
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe("US-SERIE-02 — blocos entregues em série (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 900 },
  });

  test("CA05 — o drawer do integrante segue reunido, com data e assinatura por seção", async ({
    page,
  }) => {
    await openComposition(page, FAMILY_SILVA);

    await page.locator('button[data-testid^="member-conditions-"]').first().click();
    const drawer = page.getByTestId("member-conditions-drawer");
    await expect(drawer).toBeVisible();

    for (const block of [
      "education_conditions",
      "work_income_conditions",
      "health_conditions",
    ]) {
      const section = page.getByTestId(`member-section-${block}`);
      await expect(section, `seção ${block}`).toBeVisible();
      // Data do retrato de origem (dd/mm/aaaa) e a assinatura (autor).
      await expect(section).toContainText(/\d{2}\/\d{2}\/\d{4}/);
      await expect(section).toContainText(/E2E Operador/);
    }
    await expect(page.getByTestId("member-own-income")).toBeVisible();
    await expect(page.getByTestId("member-section-health_conditions")).toContainText(
      /doença grave/i,
    );
    await page.screenshot({ path: "test-results/serie11226-ca05-drawer.png" });
  });

  test('CA05-SERIE01 — série de trabalho da Souza com a renda de Maria marcada "Mudou"', async ({
    page,
  }) => {
    await openComposition(page, FAMILY_SOUZA);

    await page.getByTestId("member-series-tab-work_income_conditions").click();
    const panel = page.getByTestId("member-series-panel-work_income_conditions");
    await expect(
      panel.locator('[data-testid^="member-series-column-"]'),
    ).toHaveCount(3);

    // A renda de Maria vai de 800,00 a 300,00 só no retrato mais recente.
    await expect(panel).toContainText("R$ 300,00");
    await expect(panel).toContainText("R$ 800,00");
    const markers = panel.getByTestId("snapshot-change-marker");
    await expect(markers).toHaveCount(1);
    const mariaRow = panel.locator("tr", { hasText: "300,00" });
    await expect(mariaRow.getByTestId("snapshot-change-marker")).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "test-results/serie11226-ca05-serie01-trabalho.png",
    });
  });

  test("CA03 — alterar só a renda cria retrato de trabalho e nenhum de educação nem de saúde", async ({
    page,
  }) => {
    const before = {
      education: await total(FAMILY_SILVA, "education_conditions"),
      work: await total(FAMILY_SILVA, "work_income_conditions"),
      health: await total(FAMILY_SILVA, "health_conditions"),
    };
    expect(before.work, "a Silva nasce com retrato de trabalho").toBeGreaterThan(0);

    await openComposition(page, FAMILY_SILVA);
    await page.locator('button[data-testid^="member-conditions-"]').first().click();
    await expect(page.getByTestId("member-conditions-drawer")).toBeVisible();

    // Máscara em centavos: "180000" vira R$ 1.800,00.
    await page.getByTestId("member-own-income").fill("180000");
    await page.getByTestId("member-conditions-save").click();
    await page.getByTestId("snapshot-kind-update").click();
    await page.getByTestId("member-conditions-unit").click();
    await page.getByRole("option", { name: UNIT_NAME }).click();
    await page.getByTestId("member-conditions-confirm-update").click();
    // O drawer fica aberto após salvar: espera a gravação e fecha para ver a série.
    await expect
      .poll(() => total(FAMILY_SILVA, "work_income_conditions"))
      .toBe(before.work + 1);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("member-conditions-drawer")).toBeHidden();

    await expect
      .poll(() => total(FAMILY_SILVA, "work_income_conditions"))
      .toBe(before.work + 1);
    expect(await total(FAMILY_SILVA, "education_conditions")).toBe(
      before.education,
    );
    expect(await total(FAMILY_SILVA, "health_conditions")).toBe(before.health);

    // Ausência na tela: a aba de educação segue com o mesmo número de retratos.
    await page.getByTestId("member-series-tab-education_conditions").click();
    await expect(
      page
        .getByTestId("member-series-panel-education_conditions")
        .locator('[data-testid^="member-series-column-"]'),
    ).toHaveCount(before.education);
    await page.screenshot({
      path: "test-results/serie11226-ca03-so-trabalho-ausencia.png",
    });

    await page.getByTestId("member-series-tab-work_income_conditions").click();
    const work = page.getByTestId("member-series-panel-work_income_conditions");
    await expect(
      work.locator('[data-testid^="member-series-column-"]'),
    ).toHaveCount(before.work + 1);
    await expect(work).toContainText("R$ 1.800,00");
    await page.screenshot({
      path: "test-results/serie11226-ca04-familia-inteira.png",
    });
  });
});
