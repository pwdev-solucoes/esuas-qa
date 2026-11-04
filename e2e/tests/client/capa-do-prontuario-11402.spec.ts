import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-04 (HU #11402) — capa do prontuário (client). Spec MANUAL de 2 logins; o
 * cenário E2E-040 (arquivo próprio, 2 logins, rodado SEPARADO e 65 s antes ou depois)
 * cobre CA01 e a edição do telefone primário. Aqui ficam:
 *  - operador do CRAS Centro: CA03 (nome social com o civil abaixo e apelido separado,
 *    na capa e na composição) e CA02/RN03 (edita o telefone secundário; a relação
 *    "Pendências para o CadÚnico" mostra a família com "Telefone secundário" e nenhum número);
 *  - assistente administrativo do Centro (não técnico, #11289): CA06 — vê os mesmos
 *    campos da capa; a evidência é a AUSÊNCIA de dado sigiloso.
 *
 * Massa: E2ERecordCoverSeeder (api; fictícia). Repor antes de rodar:
 * `db:seed --class=E2ERecordCoverSeeder`. Asserções por família e campo, nunca por
 * contagem. Nunca imprime telefone, CPF ou nome em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY = "00000000-0000-4000-8000-000011402001";
const FAMILY_CODE = "E2ECAPA0001";
const NEW_PHONE_2 = "8233330001";
const EVIDENCE_SLUG = "11402-capa-do-prontuario";

const OPERADOR = {
  cpf: process.env.E2E_CLIENT_OPERADOR_CPF ?? "",
  password: process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? "",
};
const ADMIN_STAFF = {
  cpf: process.env.E2E_CLIENT_ADMIN_STAFF_CPF ?? "",
  password: process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD ?? "",
};

async function openFamily(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("family-cover-facts")).toBeVisible({
    timeout: 20_000,
  });
}

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-04 #11402 — capa do prontuário (client)", () => {
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

  test("CA03 — nome social com o civil abaixo e o apelido separado, na capa e na composição", async ({
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
    await openFamily(page);

    await expect(page.getByText("Referência Familiar:")).toContainText(
      "E2E Capa Nome Social",
    );
    await expect(page.getByTestId("cover-civil-name")).toContainText(
      "E2E Capa Civil Responsável",
    );

    await page
      .getByRole("tab", { name: "Composição Familiar", exact: true })
      .click();
    const civil = page.locator('[data-testid^="member-civil-name-"]');
    const nick = page.locator('[data-testid^="member-nickname-"]');
    await expect(civil.first()).toContainText("E2E Capa Civil Responsável", {
      timeout: 15_000,
    });
    await expect(nick.first()).toContainText("E2E Capa Apelido");
    await captureEvidence(
      page,
      testInfo,
      EVIDENCE_SLUG,
      "nome-social-civil-apelido",
    );
  });

  test("CA02 — editar o telefone secundário gera a pendência no CadÚnico, sem exibir o número", async ({}, testInfo) => {
    await openFamily(page);
    await page.getByTestId("cover-edit-contact").click();
    await expect(page.getByTestId("family-contact-dialog")).toBeVisible();
    await page.getByTestId("contact-input-phone-2").fill(NEW_PHONE_2);
    await page.getByTestId("contact-submit").click();
    await expect(page.getByTestId("family-contact-dialog")).toBeHidden({
      timeout: 15_000,
    });
    await expect(
      page.getByTestId("cover-contact-pending-contact_phone_2"),
    ).toBeVisible({ timeout: 15_000 });

    await page.goto("/app/cadastros/familias-pendencias-cadunico");
    await dismissPlatformUpdates(page);
    // A mesma família pode ter outra linha (telefone primário, do E2E-040): filtra pelo campo.
    const row = page
      .getByTestId("cadunico-pending-row")
      .filter({ hasText: FAMILY_CODE })
      .filter({ hasText: "Telefone secundário" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId("cadunico-pending-field")).toContainText(
      "Telefone secundário",
    );
    // RN03: a relação diz o campo, nunca o valor.
    const body = (await page.locator("body").innerText()).replace(/\s/g, "");
    expect(body).not.toContain(NEW_PHONE_2);
    expect(body).not.toContain("82999990000");
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "pendencias-cadunico");
  });

  test("CA06 — o assistente administrativo vê os mesmos campos da capa, sem dado sigiloso (a evidência é a ausência)", async ({
    browser,
  }, testInfo) => {
    await page.close();
    page = await browser.newPage({
      baseURL: BASE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1600 },
    });
    await loginAsTenantUser(page, ADMIN_STAFF.cpf, ADMIN_STAFF.password, {
      tenantUuid: TENANT_UUID,
    });
    await dismissPlatformUpdates(page);
    await openFamily(page);

    await expect(page.getByTestId("cover-cadunico-updated-at")).toBeVisible();
    await expect(page.getByTestId("registry-alert-banner")).toBeVisible();
    await expect(page.getByTestId("cover-income-per-capita")).toContainText(
      "170,00",
    );
    await expect(page.getByTestId("cover-pbf")).toContainText("Recebe");
    await expect(page.getByTestId("cover-phone-1")).toBeVisible();
    await expect(page.getByTestId("cover-phone-2")).toBeVisible();
    for (const name of ["Saúde", "Acolhimento"]) {
      await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(0);
    }
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "capa-nao-tecnico");
  });
});
