import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence, captureFinalEvidence } from "../../helpers/evidence";

/**
 * US-VISIB-02 (HU #11289) — complemento do `sigilo-tecnico-11289.spec.ts` com as
 * personas e o objeto exatos do texto do ticket, onde o spec principal usava
 * equivalentes:
 *
 *  - CA04: a assistente social do CRAS Centro lê o REGISTRO do Quadro 3 feito pelo
 *    CREAS (o principal prova a leitura de uma anotação do bloco 18);
 *  - CA05: um ADVOGADO (2410-05) do CREAS lê a Saúde da família encaminhada (o
 *    principal usa o operador do CREAS, assistente social);
 *  - CA08: o "orientador social" (sem CBO próprio — educador social, 5153-05) não
 *    tem ação de registrar em saúde, violência, medidas nem acolhimento.
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`)
 * Sessão herdada do `chromium-tenant` (`E2E_CLIENT_OPERADOR`, assistente social
 * do CRAS Centro) para o CA04; depois 2 logins: advogado do CREAS (CA05) e
 * educador social do Centro (CA08).
 *
 * ## Massa (api; tudo fictício, CPFs da faixa 99000150xxx)
 * `E2EConfidentialitySeeder` (famílias `…11289001` Silva e `…11289002`
 * encaminhada; usuários `E2E_CLIENT_CREAS_LAWYER` e `E2E_CLIENT_SOCIAL_EDUCATOR`)
 * e `E2EViolenceRecordSeeder` (`…11292001`, referenciada no Centro, com dois
 * registros do CREAS no Quadro 3).
 *
 * Nunca registra nem imprime CPF ou nome real em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY_SILVA = "00000000-0000-4000-8000-000011289001";
const FAMILY_ENCAMINHADA = "00000000-0000-4000-8000-000011289002";
const FAMILY_QUADRO3 = "00000000-0000-4000-8000-000011292001";

const CREAS_LAWYER = {
  cpf: process.env.E2E_CLIENT_CREAS_LAWYER_CPF ?? "99000150531",
  password: process.env.E2E_CLIENT_CREAS_LAWYER_PASSWORD ?? "senha123",
};
const SOCIAL_EDUCATOR = {
  cpf: process.env.E2E_CLIENT_SOCIAL_EDUCATOR_CPF ?? "99000150612",
  password: process.env.E2E_CLIENT_SOCIAL_EDUCATOR_PASSWORD ?? "senha123",
};

const NOTICE = "Parte deste prontuário é restrita à equipe técnica.";
const EVIDENCE_SLUG = "11289-sigilo-tecnico-e-master";

async function open(page: Page, family: string, tab?: string): Promise<void> {
  await page.goto(
    `/app/cadastros/familias/${family}${tab ? `?tab=${tab}` : ""}`,
  );
  await dismissPlatformUpdates(page);
  await expect(
    page.getByRole("tab", { name: "Composição Familiar", exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
}

/** Rola a barra de abas até o fim, para o print mostrar as últimas abas. */
async function showLastTabs(page: Page): Promise<void> {
  await page
    .getByTestId("family-tab-resumo")
    .evaluate((tab) => {
      const bar = tab.closest('[role="tablist"]') ?? tab.parentElement;
      if (bar) bar.scrollLeft = bar.scrollWidth;
    });
}

async function loggedPage(
  browser: import("@playwright/test").Browser,
  user: { cpf: string; password: string },
  viewport = { width: 1440, height: 1600 },
): Promise<Page> {
  const page = await browser.newPage({
    baseURL: BASE,
    locale: "pt-BR",
    viewport,
  });
  await loginAsTenantUser(page, user.cpf, user.password, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(page);

  return page;
}

test.describe("US-VISIB-02 — sigilo técnico, personas do ticket (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  test.describe("assistente social do CRAS Centro (sessão herdada)", () => {
    test.afterEach(async ({ page }, testInfo) => {
      await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
    });

    test("CA04 — a assistente social do CRAS Centro lê o registro do Quadro 3 feito pelo CREAS", async ({
      page,
    }, testInfo) => {
      await open(page, FAMILY_QUADRO3, "violencia");
      const section = page.getByTestId("violence-records-section");
      await expect(section).toBeVisible({ timeout: 15_000 });
      await expect(section.getByTestId("violence-record-item")).toHaveCount(2);
      await section.scrollIntoViewIfNeeded();
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, "cras-le-quadro3-creas");
    });
  });

  test.describe("advogado do CREAS", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loggedPage(browser, CREAS_LAWYER);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA05 — o advogado do CREAS lê a aba Saúde da família encaminhada sem desfecho", async ({}, testInfo) => {
      await open(user, FAMILY_ENCAMINHADA, "saude");
      await expect(
        user.getByRole("tab", { name: "Saúde", exact: true }),
      ).toBeVisible();
      const block = user.getByTestId("health-block");
      await expect(block).toBeVisible({ timeout: 15_000 });
      await expect(block).toContainText("álcool");
      await expect(user.getByTestId("family-confidentiality-notice")).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "advogado-le-saude");
    });
  });

  test.describe("orientador social (educador social) do CRAS Centro", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      // Viewport largo: a evidência é a AUSÊNCIA de abas, e a barra precisa caber no print.
      user = await loggedPage(browser, SOCIAL_EDUCATOR, {
        width: 2200,
        height: 1400,
      });
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA08 — o orientador social não tem ação de registrar em saúde, violência, medidas nem acolhimento (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, FAMILY_SILVA);
      await expect(
        user.getByTestId("family-confidentiality-notice"),
      ).toContainText(NOTICE);
      for (const id of ["saude", "medidas-socioeducativas", "acolhimento"]) {
        await expect(user.getByTestId(`family-tab-${id}`)).toHaveCount(0);
      }
      await showLastTabs(user);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "orientador-sem-abas");

      // Violência: só o Quadro 2 (não sigiloso, RN07); Quadros 1 e 3 e suas ações não existem.
      await open(user, FAMILY_SILVA, "violencia");
      await expect(user.getByTestId("violence-history-register")).toHaveCount(0);
      await expect(user.getByTestId("violence-records-register")).toHaveCount(0);
      await expect(user.getByTestId("violence-records-section")).toHaveCount(0);
      await showLastTabs(user);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "orientador-violencia");

      // URL direta das abas sigilosas: nenhum bloco nem ação de registrar.
      await open(user, FAMILY_SILVA, "saude");
      await expect(user.getByTestId("health-block")).toHaveCount(0);
      await open(user, FAMILY_SILVA, "medidas-socioeducativas");
      await expect(
        user.getByTestId("socio-educational-measure-register-action"),
      ).toHaveCount(0);
      await open(user, FAMILY_SILVA, "acolhimento");
      await expect(user.getByTestId("sheltering-register-action")).toHaveCount(0);
    });
  });
});
