import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence, captureFinalEvidence } from "../../helpers/evidence";

/**
 * US-VISIB-02 (HU #11289) — sigilo técnico no prontuário (`client/`). Spec MANUAL
 * multiusuário: a regra única "quem lê o sigilo é a equipe técnica da unidade de
 * acesso do caso (e o Master)". Os cenários E2E-027 (não técnico, abas e aviso) e
 * E2E-028 (técnico pela unidade de acesso) cobrem o núcleo; aqui ficam os prints
 * do dossiê e as asserções que o cenário não expressa (API do acolhimento).
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`)
 *
 * O login de um usuário derruba a sessão do outro. Ordem fixa, no máximo 5
 * logins além da sessão herdada do `chromium-tenant` (operador do CRAS Centro,
 * agora técnico):
 *  1. sessão herdada (`E2E_CLIENT_OPERADOR`): CA01 (aba Saúde da Silva) e CA04
 *     (anotação de violência do CREAS);
 *  2. `E2E_CLIENT_ADMIN_STAFF` (não técnico do Centro): CA02, CA03, CA08 — a
 *     evidência é a AUSÊNCIA;
 *  3. `E2E_CLIENT_CREAS_OPERADOR`: CA05 (família encaminhada ao CREAS);
 *  4. `E2E_CLIENT_DUAL_ROLE`: CA06 (família Rural sem a aba Saúde);
 *  5. `E2E_CLIENT_NO_FUNCTION`: CA07 (Silva sem a aba Saúde, com o aviso).
 *
 * ## Massa (E2EConfidentialitySeeder, api; CPFs fictícios da faixa 99000150xxx)
 * `…000011289001` Silva (CREAS acompanha), `…002` encaminhada ao CREAS,
 * `…003` Rural, `…004` sem registro sigiloso.
 *
 * Nunca registra nem imprime CPF ou nome real em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY_SILVA = "00000000-0000-4000-8000-000011289001";
const FAMILY_ENCAMINHADA = "00000000-0000-4000-8000-000011289002";
const FAMILY_RURAL = "00000000-0000-4000-8000-000011289003";
const FAMILY_SEM_REGISTRO = "00000000-0000-4000-8000-000011289004";

const ADMIN_STAFF = {
  cpf: process.env.E2E_CLIENT_ADMIN_STAFF_CPF ?? "99000150108",
  password: process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD ?? "senha123",
};
const CREAS_OPERADOR = {
  cpf: process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "99000140064",
  password: process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "senha123",
};
const DUAL_ROLE = {
  cpf: process.env.E2E_CLIENT_DUAL_ROLE_CPF ?? "99000150370",
  password: process.env.E2E_CLIENT_DUAL_ROLE_PASSWORD ?? "senha123",
};
const NO_FUNCTION = {
  cpf: process.env.E2E_CLIENT_NO_FUNCTION_CPF ?? "99000150450",
  password: process.env.E2E_CLIENT_NO_FUNCTION_PASSWORD ?? "senha123",
};

const NOTICE = "Parte deste prontuário é restrita à equipe técnica.";
const VIOLENCE_NOTE = "E2E 11289 — violência registrada pelo CREAS";
const EVIDENCE_SLUG = "us-visib-02-sigilo-tecnico";

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

test.describe("US-VISIB-02 — sigilo técnico no prontuário (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  test.describe("técnico do CRAS Centro (sessão herdada)", () => {
    test.afterEach(async ({ page }, testInfo) => {
      await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
    });

    test("CA01 — o técnico do CRAS Centro lê a aba Saúde da família que ele conduz", async ({
      page,
    }, testInfo) => {
      await open(page, FAMILY_SILVA, "saude");
      await expect(
        page.getByRole("tab", { name: "Saúde", exact: true }),
      ).toBeVisible();
      const block = page.getByTestId("health-block");
      await expect(block).toBeVisible({ timeout: 15_000 });
      await expect(block).toContainText("álcool");
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, "tecnico-le-saude");
    });

    test("CA04 — o técnico do Centro lê a anotação de violência registrada pelo CREAS", async ({
      page,
    }, testInfo) => {
      await open(page, FAMILY_SILVA, "anotacoes");
      await expect(page.getByTestId("family-notes-block")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByTestId("family-note-item").filter({ hasText: VIOLENCE_NOTE }),
      ).toBeVisible({ timeout: 15_000 });
      await captureEvidence(
        page,
        testInfo,
        EVIDENCE_SLUG,
        "tecnico-le-violencia-creas",
      );
    });
  });
  test.describe("não técnico do CRAS Centro", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await browser.newPage({
        baseURL: BASE,
        locale: "pt-BR",
        viewport: { width: 1440, height: 1600 },
      });
      await loginAsTenantUser(user, ADMIN_STAFF.cpf, ADMIN_STAFF.password, {
        tenantUuid: TENANT_UUID,
      });
      await dismissPlatformUpdates(user);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA02 — o assistente administrativo vê Composição, Atendimentos e Encaminhamentos; Saúde com aviso restrito (US-AJ-11 RN03); sem Acolhimento nem avaliações (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, FAMILY_SILVA);

      for (const name of [
        "Composição Familiar",
        "Atendimentos",
        "Encaminhamentos",
      ]) {
        await expect(
          user.getByRole("tab", { name, exact: true }),
        ).toBeVisible();
      }
      // US-AJ-11 RN03 (#11408): a aba Saúde é visível com o aviso restrito.
      await expect(
        user.getByRole("tab", { name: "Saúde", exact: true }),
      ).toBeVisible();
      await user.getByRole("tab", { name: "Saúde", exact: true }).click();
      await expect(user.getByTestId("health-restricted")).toBeVisible();
      await expect(user.getByTestId("health-block")).toHaveCount(0);
      await expect(
        user.getByRole("tab", { name: "Acolhimento", exact: true }),
      ).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "nao-tecnico-abas");

      // Convivência sem a seção de avaliação técnica das relações.
      await open(user, FAMILY_SILVA, "convivencia");
      await expect(
        user.getByTestId("family-confidentiality-notice"),
      ).toBeVisible();
      await expect(
        user.getByTestId("relationship-assessments-section"),
      ).toHaveCount(0);
      await expect(
        user.getByTestId("relationship-assessment-item"),
      ).toHaveCount(0);

      // Acompanhamento sem as avaliações de resultados.
      await open(user, FAMILY_SILVA, "acompanhamento");
      await expect(
        user.locator('[data-testid^="follow-up-evaluation"]'),
      ).toHaveCount(0);
    });

    test("CA03 — o aviso de sigilo é o mesmo, no mesmo lugar, na família com e na sem registro sigiloso", async ({}, testInfo) => {
      await open(user, FAMILY_SILVA);
      const notice = user.getByTestId("family-confidentiality-notice");
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect(notice).toContainText(NOTICE);
      const withRecord = (await notice.textContent())?.trim();
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "aviso-com-sigilo");

      await open(user, FAMILY_SEM_REGISTRO);
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect(notice).toContainText(NOTICE);
      expect((await notice.textContent())?.trim()).toBe(withRecord);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "aviso-sem-sigilo");
    });

    test("CA08 — o formulário de anotação não lista blocos sigilosos e o acolhimento é recusado pela API (block_restricted)", async ({}, testInfo) => {
      await open(user, FAMILY_SILVA, "anotacoes");
      await user.getByTestId("family-note-register-action").click();
      await user.getByTestId("family-note-block-select").click();
      await expect(
        user.getByRole("option", { name: "Geral (família)", exact: true }),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        user.getByRole("option", { name: "Condições de saúde", exact: true }),
      ).toHaveCount(0);
      await expect(
        user.getByRole("option", {
          name: "Violência e violações de direitos",
          exact: true,
        }),
      ).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "anotacao-sem-blocos",
      );

      // API: a recusa vem do authorize(), antes da validação (corpo vazio basta).
      const cookies = await user.context().cookies();
      const xsrf = decodeURIComponent(
        cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "",
      );
      const res: APIResponse = await user
        .context()
        .request.post(
          `${API_BASE}/api/client/families/${FAMILY_SILVA}/shelterings`,
          {
            data: {},
            headers: {
              Accept: "application/json",
              Origin: BASE!,
              Referer: `${BASE}/app`,
              "X-Requested-With": "XMLHttpRequest",
              "X-Tenant-UUID": TENANT_UUID,
              "X-XSRF-TOKEN": xsrf,
            },
          },
        );
      expect(res.status(), "POST shelterings do não técnico").toBe(403);
      expect(JSON.stringify(await res.json())).toContain("block_restricted");
    });
  });

  test.describe("técnico do CREAS", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await browser.newPage({
        baseURL: BASE,
        locale: "pt-BR",
        viewport: { width: 1440, height: 1600 },
      });
      await loginAsTenantUser(
        user,
        CREAS_OPERADOR.cpf,
        CREAS_OPERADOR.password,
        { tenantUuid: TENANT_UUID },
      );
      await dismissPlatformUpdates(user);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA05 — o CREAS lê a aba Saúde da família encaminhada a ele", async ({}, testInfo) => {
      await open(user, FAMILY_ENCAMINHADA, "saude");
      await expect(
        user.getByRole("tab", { name: "Saúde", exact: true }),
      ).toBeVisible();
      await expect(user.getByTestId("health-block")).toBeVisible({
        timeout: 15_000,
      });
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "encaminhamento-le-saude",
      );
    });
  });

  test.describe("dupla função", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await browser.newPage({
        baseURL: BASE,
        locale: "pt-BR",
        viewport: { width: 1440, height: 1600 },
      });
      await loginAsTenantUser(user, DUAL_ROLE.cpf, DUAL_ROLE.password, {
        tenantUuid: TENANT_UUID,
      });
      await dismissPlatformUpdates(user);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA06 — a dupla função (técnico no CREAS, não técnico no Rural) abre a família Rural com a aba Saúde restrita (US-AJ-11 RN03; a evidência é a ausência do dado)", async ({}, testInfo) => {
      await open(user, FAMILY_RURAL, "saude");
      await expect(user.getByTestId("family-access-denied")).toHaveCount(0);
      // US-AJ-11 RN03 (#11408): aba visível com aviso, sem dado de saúde.
      await expect(
        user.getByRole("tab", { name: "Saúde", exact: true }),
      ).toBeVisible();
      await expect(user.getByTestId("health-restricted")).toBeVisible();
      await expect(user.getByTestId("health-block")).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "dupla-funcao-sem-saude",
      );
    });
  });

  test.describe("sem função", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await browser.newPage({
        baseURL: BASE,
        locale: "pt-BR",
        viewport: { width: 1440, height: 1600 },
      });
      await loginAsTenantUser(user, NO_FUNCTION.cpf, NO_FUNCTION.password, {
        tenantUuid: TENANT_UUID,
      });
      await dismissPlatformUpdates(user);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA07 — o usuário sem função vê a aba Saúde da Silva só com o aviso restrito (US-AJ-11 RN03; a evidência é a ausência do dado)", async ({}, testInfo) => {
      await open(user, FAMILY_SILVA, "saude");
      // US-AJ-11 RN03 (#11408): aba visível com aviso, sem dado de saúde.
      await expect(
        user.getByRole("tab", { name: "Saúde", exact: true }),
      ).toBeVisible();
      await expect(user.getByTestId("health-restricted")).toBeVisible();
      await expect(user.getByTestId("health-block")).toHaveCount(0);
      await expect(
        user.getByTestId("family-confidentiality-notice"),
      ).toContainText(NOTICE);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "sem-funcao-sem-saude",
      );
    });
  });
});
