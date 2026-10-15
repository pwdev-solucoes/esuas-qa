import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createTenantApiClient } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * US-SERIE-01 (HU #11225) — plano 03: diagnóstico como série de retratos, no
 * frontend do TENANT (`client/`). Spec MANUAL: o cenário declarativo E2E-011
 * cobre os três retratos com "Mudou", a pergunta, o formulário preenchido, o
 * 4º retrato assinado (CA01/CA02/CA03/CA05) e a data futura (CA07). Aqui ficam
 * o que ele não expressa:
 *
 *  - CA04: a correção NÃO cria retrato (a contagem da série fica igual) e a
 *    assinatura mostra "Corrigido por";
 *  - CT02: atualização com data no mês da remessa COMPLETED mostra o banner de
 *    retroatividade com o mês de referência;
 *  - CA08: a aba de composição não tem ação de registrar atualização (a
 *    evidência é a AUSÊNCIA do botão);
 *  - CA02 sobre a família S2: o primeiro registro abre o formulário direto
 *    (não há o que corrigir) e com os campos vazios.
 *
 * ## Massa e re-execução
 *
 * `E2EDiagnosisSeriesSeeder` (api): S1 com três retratos de habitação, S2 sem
 * retrato e remessa do mês de hoje − 60 d. ⚠️ Este spec ALTERA a massa (CA04
 * corrige, CT02 cria um retrato retroativo): rode DEPOIS do E2E-011 e
 * reexecute o seeder antes de repetir (ele poda retratos extras e repõe os
 * valores). Sessão herdada do project `chromium-tenant` (sem relogar: o
 * login tem throttle de 6/min). Nunca imprime CPF, nome ou dado pessoal.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_S1 = "00000000-0000-4000-8000-0000000f0201";
const FAMILY_S2 = "00000000-0000-4000-8000-0000000f0202";
const UNIT_NAME = "E2E CRAS Centro";

let api: APIRequestContext;

type SeriesMeta = { total: number; today: string };

async function seriesMeta(familyUuid: string): Promise<SeriesMeta> {
  const response = await api.get(
    `/api/client/families/${familyUuid}/diagnosis-snapshots?block=housing_conditions&per_page=1`,
  );
  expect(response.status(), "série de retratos da família").toBe(200);
  const body = await response.json();
  return {
    total: Number(body.meta?.total ?? 0),
    today: String(body.meta?.today ?? ""),
  };
}

async function openFamilyTab(
  page: Page,
  familyUuid: string,
  tab: string,
): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=${tab}`);
  await dismissPlatformUpdates(page);
}

async function chooseUnit(page: Page): Promise<void> {
  await page.getByTestId("diagnosis-snapshot-unit-select").click();
  await page.getByRole("option", { name: UNIT_NAME }).click();
}

/** Hoje − `days` (UTC puro, sem fuso: `today` já vem do servidor). */
function minusDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

function monthsBetween(fromIso: string, toIso: string): number {
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  return (fy - ty) * 12 + (fm - tm);
}

test.beforeAll(async () => {
  if (!BASE) return;
  api = await createTenantApiClient();
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe("US-SERIE-01 — diagnóstico como série (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 900 },
  });

  test("CA08 — composição sem ação de atualização", async ({ page }) => {
    await openFamilyTab(page, FAMILY_S1, "composicao");
    await expect(
      page.getByRole("tab", { name: /composição familiar/i }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator('[data-testid^="member-row-"]').first(),
    ).toBeVisible();

    // A ausência é a evidência: nenhuma ação de registrar atualização/retrato.
    await expect(
      page.getByRole("button", { name: /registrar atualiza/i }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid^="snapshot-alter-"]:visible'),
    ).toHaveCount(0);
    await expect(page.getByTestId("snapshot-register")).toBeHidden();
    await page.screenshot({
      path: "test-results/serie11225-ca08-composicao-ausencia.png",
    });
  });

  test("CA02 (S2) — primeiro registro abre o formulário com os campos vazios", async ({
    page,
  }) => {
    expect((await seriesMeta(FAMILY_S2)).total, "S2 nasce sem retrato").toBe(0);

    await openFamilyTab(page, FAMILY_S2, "habitacao");
    await expect(page.getByTestId("snapshot-series-empty")).toBeVisible();

    await page.getByTestId("snapshot-register").click();
    // Sem retrato não há o que corrigir: nada de pergunta, o formulário abre direto.
    await expect(page.getByTestId("snapshot-change-kind-dialog")).toHaveCount(
      0,
    );
    const sheet = page.getByTestId("diagnosis-snapshot-form-sheet");
    await expect(sheet).toBeVisible();
    await expect(
      page.getByTestId("housing-condition-residence-type"),
    ).toContainText(/sem informa/i);
    await expect(
      page.getByTestId("housing-condition-risk-area-unknown"),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/serie11225-ca02-s2-primeiro-registro.png",
    });

    // Fecha sem salvar: S2 precisa seguir sem retrato.
    await page.getByRole("button", { name: /^cancelar$/i }).click();
    expect((await seriesMeta(FAMILY_S2)).total).toBe(0);
  });

  test('CA04 — a correção não cria retrato e mostra "Corrigido por"', async ({
    page,
  }) => {
    const before = await seriesMeta(FAMILY_S1);
    expect(before.total, "S1 tem ao menos um retrato").toBeGreaterThan(0);

    await openFamilyTab(page, FAMILY_S1, "habitacao");
    await expect(page.getByTestId("snapshot-series")).toBeVisible();

    const latest = page.locator('[data-testid^="snapshot-column-"]').first();
    const typeBefore = await latest
      .getByTestId("snapshot-value-residence_type_uuid")
      .innerText();

    await page.locator('[data-testid^="snapshot-alter-"]').click();
    await expect(page.getByTestId("snapshot-change-kind-dialog")).toBeVisible();
    await page.getByTestId("snapshot-kind-correct").click();

    await expect(
      page.getByTestId("diagnosis-snapshot-correct-notice"),
    ).toBeVisible();
    // Troca o tipo para uma opção diferente da atual.
    await page.getByTestId("housing-condition-residence-type").click();
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    const target = typeBefore.includes("Alugada") ? "Cedida" : "Alugada";
    await options.filter({ hasText: target }).first().click();
    await page.getByTestId("diagnosis-snapshot-submit").click();

    await expect(
      page.getByTestId("diagnosis-snapshot-form-sheet"),
    ).toBeHidden();
    await expect(
      latest.getByTestId("snapshot-signature-correction"),
    ).toContainText(/corrigido por/i);
    await expect(
      latest.getByTestId("snapshot-value-residence_type_uuid"),
    ).toContainText(target);

    const after = await seriesMeta(FAMILY_S1);
    expect(after.total, "a correção não cria retrato").toBe(before.total);
    await page.screenshot({
      path: "test-results/serie11225-ca04-correcao.png",
    });
  });

  test("CT02 — aviso de retroatividade com a data no mês da remessa", async ({
    page,
  }) => {
    const { today } = await seriesMeta(FAMILY_S1);
    const target = minusDays(today, 60);

    await openFamilyTab(page, FAMILY_S1, "habitacao");
    await expect(page.getByTestId("snapshot-series")).toBeVisible();

    await page.locator('[data-testid^="snapshot-alter-"]').click();
    await page.getByTestId("snapshot-kind-update").click();
    await expect(
      page.getByTestId("diagnosis-snapshot-form-sheet"),
    ).toBeVisible();

    await page.locator("#diagnosis-snapshot-taken-on").click();
    for (let i = 0; i < monthsBetween(today, target); i += 1) {
      await page.getByRole("button", { name: "Previous page" }).click();
    }
    await page
      .locator(`[data-reka-calendar-cell-trigger][data-value="${target}"]`)
      .click();
    await chooseUnit(page);
    await page.getByTestId("diagnosis-snapshot-submit").click();

    await expect(
      page.getByTestId("diagnosis-snapshot-form-sheet"),
    ).toBeHidden();
    const [year, month] = target.split("-");
    const banner = page.getByTestId("housing-condition-remittance-warning");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(`${month}/${year}`);
    await page.screenshot({ path: "test-results/serie11225-ct02-aviso.png" });
  });
});
