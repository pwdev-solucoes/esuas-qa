import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-VIOL-04 (HU #11293) — Quadro 2: períodos de acompanhamento pelo CREAS, na aba
 * Violência do frontend do TENANT (`client/`). Spec MANUAL; o cenário declarativo
 * E2E-036 cobre o fluxo básico. O CA05 (trilha de auditoria) fica no Pest (apêndice).
 *
 * ## Arranjo (⚠️ `throttle:6,1`) — 4 logins, uma página por usuário
 *  1. operador do CRAS Centro: CA01, CA02, CA03, CA04;
 *  2. não técnico do CRAS Centro: CT-RN05a (aba só com o Quadro 2 e o aviso fixo);
 *  3. operador do CREAS: CT-RN05b (sem o Quadro 2 — a evidência é a ausência);
 *  4. Master: lê o Quadro 2 da família …001.
 *
 * ## Massa (E2ECreasPeriodsSeeder, api; tudo fictício)
 * Família …11293001: PAEFI desligado no CREAS (03/2026–07/2026), PAEFI cancelado, PAIF
 * vigente e o manual …201 (2023, CREAS de outro município). Família …11293002: PAEFI vigente.
 * Os períodos que este spec registra são identificados por RUN_TAG e lidos por filtro,
 * nunca por contagem; o seeder os remove na rodada seguinte.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY_SILVA = "00000000-0000-4000-8000-000011293001";
const FAMILY_SOUZA = "00000000-0000-4000-8000-000011293002";
const DERIVED_UUID = "00000000-0000-4000-8000-000011293101";
const MANUAL_UUID = "00000000-0000-4000-8000-000011293201";
const EVIDENCE_SLUG = "11293-periodos-creas-quadro-2";
const RUN_TAG = `T${Date.now().toString(36).slice(-5)}`;
const EXTERNAL_NAME = `CREAS E2E ${RUN_TAG} de Outro Município`;

const CRAS = {
  cpf: process.env.E2E_CLIENT_OPERADOR_CPF ?? "11144477735",
  password: process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? "senha123",
};
const NON_TECH = {
  cpf: process.env.E2E_CLIENT_ADMIN_STAFF_CPF ?? "99000150108",
  password: process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD ?? "senha123",
};
const CREAS = {
  cpf: process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "99000140064",
  password: process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "senha123",
};
const MASTER = {
  cpf: process.env.E2E_CLIENT_MASTER_CPF ?? "52998224725",
  password: process.env.E2E_CLIENT_MASTER_PASSWORD ?? "senha123",
};

async function loginNew(
  browser: import("@playwright/test").Browser,
  user: { cpf: string; password: string },
): Promise<Page> {
  const page = await browser.newPage({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1200 },
  });
  await loginAsTenantUser(page, user.cpf, user.password, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(page);
  return page;
}

async function openViolence(page: Page, family: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${family}?tab=violencia`);
  await dismissPlatformUpdates(page);
}

const TALL = { viewport: { width: 1440, height: 3200 } };

const isListing = (url: string) =>
  url.includes("/creas-follow-up-periods") && !url.includes("/options");

test.use({
  baseURL: BASE,
  locale: "pt-BR",
  viewport: { width: 1440, height: 1200 },
});

test.describe("US-VIOL-04 — Quadro 2: períodos com o CREAS (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");
  test.describe.configure({ mode: "serial" });

  let cras: Page;

  test.afterAll(async () => {
    await cras?.close();
  });

  test("CA01 — o CRAS vê 03/2026 a 07/2026 no E2E CREAS, do acompanhamento PAEFI, sem o cancelado, o PAIF nem o texto da avaliação", async ({
    browser,
  }, testInfo) => {
    cras = await loginNew(browser, CRAS);
    const listing = cras.waitForResponse(
      (r) => isListing(r.url()) && r.request().method() === "GET",
    );
    await openViolence(cras, FAMILY_SILVA);
    const body = await (await listing).text();
    await expect(cras.getByTestId("creas-periods-section")).toBeVisible({
      timeout: 20_000,
    });

    const derived = cras.getByTestId(`creas-period-row-${DERIVED_UUID}`);
    await expect(derived).toBeVisible({ timeout: 10_000 });
    await expect(derived).toContainText("03/2026");
    await expect(derived).toContainText("07/2026");
    await expect(derived).toContainText("E2E CREAS");
    await expect(derived).toContainText("Do acompanhamento PAEFI");
    // cancelado (…102) e PAIF (…103) não são período do CREAS
    await expect(
      cras.getByTestId("creas-period-row-00000000-0000-4000-8000-000011293102"),
    ).toHaveCount(0);
    await expect(
      cras.getByTestId("creas-period-row-00000000-0000-4000-8000-000011293103"),
    ).toHaveCount(0);
    // nenhum conteúdo do acompanhamento chega à tela nem à resposta
    await expect(
      cras.getByText("E2E 11293 avaliação que não pode aparecer"),
    ).toHaveCount(0);
    expect(body).not.toContain("avaliação que não pode aparecer");
    await captureEvidence(cras, testInfo, EVIDENCE_SLUG, "derivado", TALL);
  });

  test("CA02 — o CRAS vê o PAEFI vigente da família Souza como Em curso", async ({}, testInfo) => {
    await openViolence(cras, FAMILY_SOUZA);
    const inProgress = cras
      .locator('[data-testid^="creas-period-in-progress-"]')
      .first();
    await expect(inProgress).toBeVisible({ timeout: 20_000 });
    await expect(inProgress).toContainText("Em curso");
    await captureEvidence(cras, testInfo, EVIDENCE_SLUG, "em-curso", TALL);
  });

  test("CA03 — o CRAS registra 02/2023 a 05/2023 num CREAS de outro município e o manual aparece como Registro manual", async ({}, testInfo) => {
    await openViolence(cras, FAMILY_SILVA);
    await expect(cras.getByTestId("creas-periods-section")).toBeVisible({
      timeout: 20_000,
    });
    await cras.getByTestId("creas-periods-register").click();
    await expect(cras.getByTestId("creas-period-form")).toBeVisible({
      timeout: 10_000,
    });
    await cras.getByTestId("creas-period-started-month").click();
    await cras.getByRole("option", { name: "Fevereiro", exact: true }).click();
    await cras.getByTestId("creas-period-started-year").click();
    await cras.getByRole("option", { name: "2023", exact: true }).click();
    await cras.getByTestId("creas-period-ended-month").click();
    await cras.getByRole("option", { name: "Maio", exact: true }).click();
    await cras.getByTestId("creas-period-ended-year").click();
    await cras.getByRole("option", { name: "2023", exact: true }).click();
    await cras.getByTestId("creas-period-form-creas-external").click();
    await cras.getByTestId("creas-period-external-name").fill(EXTERNAL_NAME);
    await captureEvidence(cras, testInfo, EVIDENCE_SLUG, "formulario", TALL);
    await cras.getByTestId("creas-period-form-submit").click();

    const registered = cras
      .locator('[data-testid^="creas-period-row-"]')
      .filter({ hasText: RUN_TAG })
      .first();
    await expect(registered).toBeVisible({ timeout: 10_000 });
    await expect(registered).toContainText("Registro manual");
    await expect(registered).toContainText("02/2023");
    await expect(registered).toContainText("05/2023");
    // o manual …201 da massa também é manual
    await expect(
      cras.getByTestId(`creas-period-origin-${MANUAL_UUID}`),
    ).toContainText("Registro manual");
    await captureEvidence(cras, testInfo, EVIDENCE_SLUG, "manual", TALL);
  });

  test("CA04 — a linha derivada não tem ação e o PUT do uuid derivado é 404 (a evidência é a ausência)", async ({}, testInfo) => {
    const listing = cras.waitForRequest(
      (r) => isListing(r.url()) && r.method() === "GET",
    );
    await openViolence(cras, FAMILY_SILVA);
    const request = await listing;
    const derived = cras.getByTestId(`creas-period-row-${DERIVED_UUID}`);
    await expect(derived).toBeVisible({ timeout: 20_000 });
    await expect(derived.locator("button")).toHaveCount(0);
    await expect(
      derived.locator('[data-testid^="creas-period-correct-"]'),
    ).toHaveCount(0);
    // o manual tem a ação; o derivado não
    await expect(
      cras
        .getByTestId(`creas-period-row-${MANUAL_UUID}`)
        .locator('[data-testid^="creas-period-correct-"]'),
    ).toBeVisible();

    const headers = { ...(await request.allHeaders()) };
    for (const name of ["host", "content-length", "content-type"]) {
      delete headers[name];
    }
    const response = await cras.request.put(
      `${request.url().split("?")[0]}/${DERIVED_UUID}`,
      {
        headers,
        data: {
          started_month: "2026-03",
          ended_month: "2026-07",
          external_creas_name: "E2E tentativa de alterar o derivado",
        },
      },
    );
    expect(response.status()).toBe(404);
    await captureEvidence(cras, testInfo, EVIDENCE_SLUG, "sem-acao", TALL);
  });

  test("CT-RN05a — o não técnico do CRAS vê a aba Violência só com o Quadro 2 e o aviso fixo", async ({
    browser,
  }, testInfo) => {
    const user = await loginNew(browser, NON_TECH);
    try {
      await openViolence(user, FAMILY_SILVA);
      await expect(user.getByTestId("creas-periods-section")).toBeVisible({
        timeout: 20_000,
      });
      await expect(user.getByTestId("creas-periods-notice")).toBeVisible();
      await expect(
        user.getByTestId(`creas-period-row-${DERIVED_UUID}`),
      ).toBeVisible();
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "nao-tecnico", TALL);
    } finally {
      await user.close();
    }
  });

  test("CT-RN05b — o operador do CREAS não vê o Quadro 2 (a evidência é a ausência)", async ({
    browser,
  }, testInfo) => {
    const user = await loginNew(browser, CREAS);
    try {
      await openViolence(user, FAMILY_SILVA);
      await expect(user.getByTestId("family-tab-resumo")).toBeVisible({
        timeout: 20_000,
      });
      await user.waitForTimeout(1500);
      await expect(user.getByTestId("creas-periods-section")).toHaveCount(0);
      await expect(
        user.locator('[data-testid^="creas-period-row-"]'),
      ).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "creas", TALL);
    } finally {
      await user.close();
    }
  });

  test("RN — o Master lê o Quadro 2 da família Silva", async ({
    browser,
  }, testInfo) => {
    const user = await loginNew(browser, MASTER);
    try {
      await openViolence(user, FAMILY_SILVA);
      await expect(user.getByTestId("creas-periods-section")).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        user.getByTestId(`creas-period-row-${DERIVED_UUID}`),
      ).toBeVisible();
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "master-le", TALL);
    } finally {
      await user.close();
    }
  });
});
