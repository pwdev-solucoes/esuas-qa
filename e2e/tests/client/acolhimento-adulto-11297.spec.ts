import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-ACOLH2-02 (HU #11297) — acolhimento de QUALQUER integrante, no frontend do
 * TENANT (`client/`). Spec MANUAL; o cenário declarativo E2E-035 cobre o fluxo
 * básico (registro, motivo obrigatório e ausência da aba). Aqui ficam o CA01 com
 * a assinatura, a igualdade do perfil de acolhimento (CA02/CA03) e a RN04.
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`) — 3 logins, ordem fixa
 *  1. Master: lê o perfil "sheltering" e o aviso de acolhimentos longos do CREAS (ANTES);
 *  2. técnico do CREAS: registra o acolhimento de "E2E Joana" (38 anos) — CA01;
 *  3. Master (mesma sessão do 1): relê o perfil e o aviso (DEPOIS) — iguais (CA02/CA03) —
 *     e lê o acolhimento de Joana (RN04);
 *  4. não técnico do CREAS: aba ausente (RN04).
 *
 * ## Massa (E2EAdultShelteringSeeder, api; tudo fictício)
 * Família `…000011297001` no CREAS E2E. A massa acumula entre execuções: as
 * asserções são de IGUALDADE antes/depois, nunca de valor absoluto, e a linha
 * lida é a mais recente. Nenhum CPF, senha ou nome real é gravado aqui.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const CREAS_UUID = "00000000-0000-4000-8000-0000000e0002";
const FAMILY = "00000000-0000-4000-8000-000011297001";
const EVIDENCE_SLUG = "11297-acolhimento-qualquer-integrante";

const TECH = {
  cpf: process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "99000140064",
  password: process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "senha123",
};
const NON_TECH = {
  cpf: process.env.E2E_CLIENT_CREAS_ADMIN_STAFF_CPF ?? "99000150299",
  password: process.env.E2E_CLIENT_CREAS_ADMIN_STAFF_PASSWORD ?? "senha123",
};
const MASTER = {
  cpf: process.env.E2E_CLIENT_MASTER_CPF ?? "52998224725",
  password: process.env.E2E_CLIENT_MASTER_PASSWORD ?? "senha123",
};

const pad = (n: number) => String(n).padStart(2, "0");
const today = new Date();
const FIRST_OF_MONTH = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`;
const REASON = `Situação de risco avaliada pela equipe (massa fictícia ${Date.now()})`;

async function loginNew(
  browser: import("@playwright/test").Browser,
  user: { cpf: string; password: string },
): Promise<Page> {
  const page = await browser.newPage({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });
  await loginAsTenantUser(page, user.cpf, user.password, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(page);
  return page;
}

async function openFamily(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=acolhimento`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("family-tab-resumo")).toBeVisible({
    timeout: 15_000,
  });
}

/** Lê o perfil de acolhimento e o aviso de acolhimentos longos do CREAS no mês corrente. */
async function readReport(
  page: Page,
): Promise<{ profile: number; stale: number }> {
  await page.goto("/app/prestacao-contas/apuracao-atendimentos");
  await dismissPlatformUpdates(page);
  const value = page.getByTestId(
    `new-family-value-profile_sheltering-${CREAS_UUID}`,
  );
  await expect(value).toBeVisible({ timeout: 20_000 });
  const profile = Number((await value.innerText()).replace(/\D/g, ""));
  const staleLoc = page.getByTestId(`stale-shelterings-count-${CREAS_UUID}`);
  const stale = (await staleLoc.count())
    ? Number((await staleLoc.first().innerText()).replace(/\D/g, ""))
    : 0;
  return { profile, stale };
}

test.use({
  baseURL: BASE,
  locale: "pt-BR",
  viewport: { width: 1440, height: 1600 },
});

test.describe("US-ACOLH2-02 — acolhimento de qualquer integrante (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");
  test.describe.configure({ mode: "serial" });

  let master: Page;
  let before: { profile: number; stale: number };

  test.afterAll(async () => {
    await master?.close();
  });

  test("CA02 — antes do registro, o Master lê o perfil de acolhimento do CREAS", async ({
    browser,
  }, testInfo) => {
    master = await loginNew(browser, MASTER);
    before = await readReport(master);
    expect(before.profile).toBeGreaterThanOrEqual(0);
    await captureEvidence(master, testInfo, EVIDENCE_SLUG, "perfil-antes");
  });

  test("CA01 — o técnico do CREAS registra o acolhimento de Joana (38 anos) e vê a linha Em curso assinada", async ({
    browser,
  }, testInfo) => {
    const tech = await loginNew(browser, TECH);
    try {
      await openFamily(tech);
      await tech.getByRole("tab", { name: "Acolhimento", exact: true }).click();
      await expect(tech.getByTestId("sheltering-block")).toBeVisible({
        timeout: 15_000,
      });
      await tech.getByTestId("sheltering-register-action").click();
      await expect(tech.getByTestId("sheltering-form-sheet")).toBeVisible({
        timeout: 10_000,
      });
      await tech.getByTestId("sheltering-form-member").click();
      await expect(
        tech.getByRole("option", { name: /E2E Pedro/ }),
      ).toBeVisible();
      await tech.getByRole("option", { name: /E2E Joana/ }).click();
      await tech.getByTestId("sheltering-form-started").fill(FIRST_OF_MONTH);
      await tech.getByTestId("sheltering-form-modality-institutional").click();
      await tech
        .getByTestId("sheltering-form-institution")
        .fill("Casa de Passagem E2E (fictícia)");
      await tech.getByTestId("sheltering-form-reason").fill(REASON);
      await tech.getByTestId("sheltering-form-submit").click();
      await expect(tech.getByTestId("sheltering-form-sheet")).toBeHidden({
        timeout: 10_000,
      });

      const row = tech
        .locator('[data-testid^="sheltering-row-"]')
        .filter({ hasText: "E2E Joana" })
        .first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toContainText("Em curso");
      await row.locator('[data-testid^="sheltering-expand-"]').click();
      await tech.waitForTimeout(800);
      await captureEvidence(tech, testInfo, EVIDENCE_SLUG, "acolhimento-joana");
    } finally {
      await tech.close();
    }
  });

  test("CA03 — depois do registro, o perfil de acolhimento e o aviso de acolhimentos longos do CREAS são iguais (a regressão é de números)", async ({}, testInfo) => {
    const after = await readReport(master);
    expect(after.profile, "perfil de acolhimento do CREAS").toBe(
      before.profile,
    );
    expect(after.stale, "aviso de acolhimentos longos do CREAS").toBe(
      before.stale,
    );
    await captureEvidence(master, testInfo, EVIDENCE_SLUG, "perfil-depois");
  });

  test("RN04 — o Master lê o acolhimento de Joana", async ({}, testInfo) => {
    await openFamily(master);
    await expect(master.getByTestId("sheltering-block")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      master
        .locator('[data-testid^="sheltering-row-"]')
        .filter({ hasText: "E2E Joana" })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    await captureEvidence(master, testInfo, EVIDENCE_SLUG, "master-le");
  });

  test("RN04 — o não técnico do CREAS não vê a aba Acolhimento (a evidência é a ausência)", async ({
    browser,
  }, testInfo) => {
    const user = await loginNew(browser, NON_TECH);
    try {
      await openFamily(user);
      await expect(
        user.getByRole("tab", { name: "Acolhimento", exact: true }),
      ).toHaveCount(0);
      await expect(user.getByTestId("family-tab-acolhimento")).toHaveCount(0);
      await expect(user.getByTestId("sheltering-block")).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "nao-tecnico-sem-aba",
      );
    } finally {
      await user.close();
    }
  });
});
