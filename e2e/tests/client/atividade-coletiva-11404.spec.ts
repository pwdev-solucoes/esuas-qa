import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-07 (HU #11404) — atividade coletiva pelo menu (client). Spec MANUAL de 1 login
 * (operador do CRAS Centro), ordem fixa e serial: CA03 → RN04 → CA01 (prontuário) → RN05.
 * O cenário E2E-042 (4 logins, arquivo próprio) cobre o registro, a ausência de lista, a
 * validação e o menu sem o add-on; roda SEPARADO, 65 s antes ou depois.
 *
 * Massa: E2ECollectiveActivitySeeder (api; fictícia). Repor antes de rodar:
 * `db:seed --class='Database\Seeders\E2ECollectiveActivitySeeder'`. O RN05 cancela `a01`,
 * por isso vem por último. Asserções pelo item (uuid), nunca por contagem absoluta.
 * Nunca imprime CPF, nome ou descrição em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const EVIDENCE_SLUG = "11404-atividade-coletiva";

const FAMILY_ALVES = "00000000-0000-4000-8000-000011404001";
const FAMILY_BARROS = "00000000-0000-4000-8000-000011404002";
const FAMILY_CAMPOS = "00000000-0000-4000-8000-000011404003";
const A01 = "00000000-0000-4000-8000-000011404a01";
const A02 = "00000000-0000-4000-8000-000011404a02";
const ATT_A01_ALVES = "00000000-0000-4000-8000-000011404b01";
const ATT_A01_BARROS = "00000000-0000-4000-8000-000011404b02";
const ATT_A02_ALVES = "00000000-0000-4000-8000-000011404b03";
const ATT_A02_CAMPOS = "00000000-0000-4000-8000-000011404b04";

const NEW_DESCRIPTION = "Descrição corrigida pelo E2E da atividade coletiva.";
const CANCEL_REASON =
  "Atividade cancelada pelo E2E por indisponibilidade do espaço.";

const OPERADOR = {
  cpf: process.env.E2E_CLIENT_OPERADOR_CPF ?? "",
  password: process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? "",
};

async function openAttendances(page: Page, familyUuid: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${familyUuid}?tab=atendimentos`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("attendance-history")).toBeVisible({
    timeout: 20_000,
  });
}

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-07 #11404 — atividade coletiva pelo menu (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  let page: Page;

  test.afterAll(async () => {
    await page?.close();
  });

  test("CA03 — a relação mostra a atividade mais recente primeiro", async ({
    browser,
  }, testInfo) => {
    page = await browser.newPage({
      baseURL: BASE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1600 },
    });
    await loginAsTenantUser(page, OPERADOR.cpf, OPERADOR.password, {
      tenantUuid: TENANT_UUID,
    });
    await dismissPlatformUpdates(page);

    await page.goto("/app/atividades-coletivas");
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("collective-activities-page")).toBeVisible({
      timeout: 20_000,
    });

    const rows = page.getByTestId("collective-activity-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const uuids = await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-uuid")),
    );
    const indexA02 = uuids.indexOf(A02);
    const indexA01 = uuids.indexOf(A01);
    expect(indexA02, "a02 na relação").toBeGreaterThanOrEqual(0);
    expect(indexA01, "a01 na relação").toBeGreaterThanOrEqual(0);
    expect(indexA02).toBeLessThan(indexA01);

    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("RN04 — o atalho da aba Atendimentos abre o registro com os integrantes da família", async ({}, testInfo) => {
    await openAttendances(page, FAMILY_ALVES);
    await page.getByTestId("attendance-batch-action").click();

    const prefill = page.getByTestId("collective-activity-prefill");
    await expect(prefill).toBeVisible({ timeout: 15_000 });
    await expect(prefill).toContainText("E2E Coletiva Alves Ana");
    await expect(prefill).toContainText("E2E Coletiva Alves Bruno");
    await expect(prefill).not.toContainText("E2E Coletiva Barros");

    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA01 — o prontuário mostra o atendimento gerado com o selo e a pessoa", async ({}, testInfo) => {
    await openAttendances(page, FAMILY_ALVES);

    const row = page.getByTestId(`attendance-row-${ATT_A02_ALVES}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("attendance-collective-badge")).toBeVisible();
    await expect(row).toContainText("E2E Coletiva Alves Bruno");

    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "prontuario");
  });

  test("RN05 — corrigir a descrição e cancelar a atividade propagam aos atendimentos", async ({}, testInfo) => {
    // Correção de a02: a descrição nova chega ao prontuário da Campos.
    await page.goto(`/app/atividades-coletivas/${A02}`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("collective-activity-detail")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("collective-activity-correct").click();
    await page
      .getByTestId("collective-activity-description")
      .fill(NEW_DESCRIPTION);
    await page.getByTestId("collective-activity-submit").click();
    await expect(
      page.getByTestId("collective-activity-description-text"),
    ).toContainText(NEW_DESCRIPTION, { timeout: 15_000 });

    await openAttendances(page, FAMILY_CAMPOS);
    await page.getByTestId(`attendance-row-${ATT_A02_CAMPOS}`).click();
    await expect(
      page.getByTestId(`attendance-details-${ATT_A02_CAMPOS}`),
    ).toContainText(NEW_DESCRIPTION, { timeout: 15_000 });
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "correcao-propagada");

    // Cancelamento de a01 com motivo: Alves e Barros ficam cancelados.
    await page.goto(`/app/atividades-coletivas/${A01}`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("collective-activity-detail")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("collective-activity-cancel").click();
    await page
      .getByTestId("collective-activity-cancel-reason")
      .fill(CANCEL_REASON);
    await page.getByTestId("collective-activity-cancel-confirm").click();
    await expect(
      page.getByTestId("collective-activity-cancelled"),
    ).toBeVisible({ timeout: 15_000 });

    for (const [family, attendance] of [
      [FAMILY_ALVES, ATT_A01_ALVES],
      [FAMILY_BARROS, ATT_A01_BARROS],
    ] as const) {
      await openAttendances(page, family);
      await expect(
        page.getByTestId(`attendance-cancelled-badge-${attendance}`),
      ).toBeVisible({ timeout: 15_000 });
      await page.getByTestId(`attendance-row-${attendance}`).click();
      await expect(
        page.getByTestId(`attendance-details-${attendance}`),
      ).toContainText(CANCEL_REASON, { timeout: 15_000 });
    }
    await captureEvidence(
      page,
      testInfo,
      EVIDENCE_SLUG,
      "cancelamento-propagado",
    );

    // a02 da Alves segue registrado (só a01 foi cancelada).
    await openAttendances(page, FAMILY_ALVES);
    await expect(
      page.getByTestId(`attendance-cancelled-badge-${ATT_A02_ALVES}`),
    ).toHaveCount(0);
  });
});
