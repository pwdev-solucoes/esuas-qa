import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-VIOL-02 (HU #11291) — histórico de violências vividas pela família
 * (Quadro 1) na aba "Violência" do prontuário (`client/`). Spec MANUAL
 * multiusuário: o cenário declarativo E2E-031 cobre o registro (CA01), a
 * validação de "Outra" (CA05) e o não técnico (CA04); aqui ficam a atualização
 * por situação (CA02), o técnico do CREAS (CA03), a anotação sigilosa do bloco 18
 * (CA06), a recusa do `POST` e o Master (só lê).
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`)
 *
 * O project `chromium-tenant` entrega `page` autenticado como o operador do CRAS
 * Centro (técnico, assistente social) — os três primeiros casos o usam. Depois,
 * três logins (um por usuário; o login de um derruba a sessão do outro):
 *  1. técnico do CREAS (`E2E_CLIENT_CREAS_OPERADOR`): CA03;
 *  2. não técnico do CRAS Centro (`E2E_CLIENT_ADMIN_STAFF`): CA04 e CA06 (a
 *     evidência é a AUSÊNCIA) e `POST` → 403 `block_restricted`;
 *  3. Master (`E2E_CLIENT_MASTER`): lê, sem Registrar nem Alterar, e `POST` → 403
 *     `violence_history_requires_technical`.
 *
 * ## Massa (E2EViolenceHistorySeeder, api; tudo fictício)
 * `…000011291001` (A): anotações `…101` (Violência física) e `…102` (Trabalho
 * infantil), CRAS Centro, 09/2026, persiste; anotação do bloco 18 `…103` pelo
 * CREAS. `…000011291002` (B): sem anotação. Ressemear antes de cada rodada.
 *
 * Asserções pela linha (código da situação), nunca por contagem absoluta.
 * Nunca registra nem imprime CPF, nome ou situação em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY_A = "00000000-0000-4000-8000-000011291001";
const FAMILY_B = "00000000-0000-4000-8000-000011291002";

const CREAS_OPERADOR = {
  cpf: process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "99000140064",
  password: process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "senha123",
};
const ADMIN_STAFF = {
  cpf: process.env.E2E_CLIENT_ADMIN_STAFF_CPF ?? "99000150108",
  password: process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD ?? "senha123",
};
const MASTER = {
  cpf: process.env.E2E_CLIENT_MASTER_CPF ?? "52998224725",
  password: process.env.E2E_CLIENT_MASTER_PASSWORD ?? "senha123",
};

const NOTICE = "Parte deste prontuário é restrita à equipe técnica.";
const NOTE_CREAS = "E2E 11291 — violência registrada pelo CREAS";
const EVIDENCE_SLUG = "11291-historico-violencias-quadro-1";

// Códigos do produto no lookup da #11290.
const PHYSICAL = "04";
const CHILD_LABOR = "01";

async function open(page: Page, family: string, tab?: string): Promise<void> {
  await page.goto(
    `/app/cadastros/familias/${family}${tab ? `?tab=${tab}` : ""}`,
  );
  await dismissPlatformUpdates(page);
  await expect(
    page.getByRole("tab", { name: "Composição Familiar", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

function row(page: Page, code: string) {
  return page.getByTestId(`violence-history-row-${code}`);
}

async function chooseUnitIfNeeded(page: Page): Promise<void> {
  const select = page.getByTestId("violence-history-unit-select");
  if (await select.isVisible().catch(() => false)) {
    if (/Selecione a unidade/.test(await select.innerText())) {
      await select.click();
      await page.getByRole("option", { name: "CRAS Centro" }).first().click();
    }
  }
}

async function postViolenceHistory(user: Page): Promise<APIResponse> {
  const cookies = await user.context().cookies();
  const xsrf = decodeURIComponent(
    cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "",
  );
  // A recusa vem do authorize(), antes da validação: corpo vazio basta.
  return user
    .context()
    .request.post(
      `${API_BASE}/api/client/families/${FAMILY_A}/violence-history`,
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
}

async function loginNew(
  browserPage: Promise<Page>,
  user: { cpf: string; password: string },
): Promise<Page> {
  const page = await browserPage;
  await loginAsTenantUser(page, user.cpf, user.password, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(page);
  return page;
}

const newPage = (browser: import("@playwright/test").Browser) =>
  browser.newPage({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

test.describe("US-VIOL-02 — histórico de violências vividas, Quadro 1 (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  test.describe("técnico do CRAS Centro (sessão herdada)", () => {
    test("CA01 — o técnico registra Violência física como persistente em 09/2026 e a linha mostra mês, nome e função", async ({
      page,
    }, testInfo) => {
      await open(page, FAMILY_B, "violencia");
      await expect(page.getByTestId("violence-history-section")).toBeVisible({
        timeout: 15_000,
      });
      await expect(row(page, PHYSICAL)).toContainText("Sem registro");

      await page.getByTestId("violence-history-register").click();
      await expect(page.getByTestId("violence-history-form")).toBeVisible({
        timeout: 10_000,
      });
      await chooseUnitIfNeeded(page);
      await page.getByTestId("violence-history-situation-select").click();
      await page
        .getByRole("option", { name: "Violência física", exact: true })
        .click();
      await page.getByTestId("violence-history-persists-yes").click();
      await page.getByTestId("violence-history-month-input").fill("2026-09");
      await page.getByTestId("violence-history-submit").click();

      await expect(row(page, PHYSICAL)).toContainText("Vivida — persiste", {
        timeout: 10_000,
      });
      await expect(
        page.getByTestId(`violence-history-month-${PHYSICAL}`),
      ).toContainText("09/2026");
      const signature = row(page, PHYSICAL).getByTestId(
        "violence-history-signature",
      );
      await expect(signature).toContainText("CRAS Centro");
      await expect(signature).toContainText("·");
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, "registro");
    });

    test("CA02 — a atualização da Violência física no mês corrente não altera o Trabalho infantil e a de 09/2026 fica em ver anteriores", async ({
      page,
    }, testInfo) => {
      await open(page, FAMILY_A, "violencia");
      await expect(row(page, PHYSICAL)).toContainText("Vivida — persiste", {
        timeout: 15_000,
      });
      await expect(row(page, CHILD_LABOR)).toContainText("Vivida — persiste");

      await page.getByTestId(`violence-history-alter-${PHYSICAL}`).click();
      await expect(
        page.getByTestId("violence-history-change-dialog"),
      ).toBeVisible({ timeout: 10_000 });
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, "dialogo-alterar");
      await page.getByTestId("violence-history-change-update").click();
      await expect(page.getByTestId("violence-history-form")).toBeVisible({
        timeout: 10_000,
      });
      await chooseUnitIfNeeded(page);
      await page.getByTestId("violence-history-persists-no").click();
      // O mês do PO (11/2026) é futuro na data da execução: usa o mês corrente
      // informado pelo servidor (`max` do campo).
      const month = page.getByTestId("violence-history-month-input");
      const current = await month.getAttribute("max");
      expect(current, "mês corrente do servidor").toMatch(/^\d{4}-\d{2}$/);
      await month.fill(current!);
      await page.getByTestId("violence-history-submit").click();

      await expect(row(page, PHYSICAL)).toContainText(
        "Vivida — não persiste mais",
        { timeout: 10_000 },
      );
      await row(page, PHYSICAL)
        .getByTestId(`violence-history-history-toggle-${PHYSICAL}`)
        .click();
      await expect(
        row(page, PHYSICAL)
          .getByTestId("violence-history-item")
          .filter({ hasText: "09/2026" })
          .filter({ hasText: "Vivida — persiste" }),
      ).toBeVisible();
      // Trabalho infantil: mesma anotação de 09/2026, sem anterior.
      await expect(row(page, CHILD_LABOR)).toContainText("Vivida — persiste");
      await expect(
        page.getByTestId(`violence-history-month-${CHILD_LABOR}`),
      ).toContainText("09/2026");
      await expect(
        page.getByTestId(`violence-history-history-toggle-${CHILD_LABOR}`),
      ).toHaveCount(0);
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, "atualizacao");
    });

    test("CA06 — o técnico do CRAS Centro lê a anotação do bloco Violência e violações registrada pelo CREAS", async ({
      page,
    }, testInfo) => {
      await open(page, FAMILY_A, "anotacoes");
      await expect(page.getByTestId("family-notes-block")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByTestId("family-note-item").filter({ hasText: NOTE_CREAS }),
      ).toBeVisible({ timeout: 15_000 });
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, "tecnico-le");
    });
  });

  test.describe("técnico do CREAS", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(newPage(browser), CREAS_OPERADOR);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test("CA03 — o técnico do CREAS lê as anotações registradas pelo CRAS Centro", async ({}, testInfo) => {
      await open(user, FAMILY_A, "violencia");
      await expect(user.getByTestId("violence-history-section")).toBeVisible({
        timeout: 15_000,
      });
      await expect(row(user, CHILD_LABOR)).toContainText("Vivida — persiste", {
        timeout: 15_000,
      });
      await expect(
        user.getByTestId(`violence-history-month-${CHILD_LABOR}`),
      ).toContainText("09/2026");
      await expect(
        row(user, CHILD_LABOR).getByTestId("violence-history-signature"),
      ).toContainText("CRAS Centro");
      await expect(
        row(user, PHYSICAL).getByTestId("violence-history-signature"),
      ).toContainText("CRAS Centro");
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "creas-le");
    });
  });

  test.describe("não técnico do CRAS Centro", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(newPage(browser), ADMIN_STAFF);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test("CA04 — o não técnico não vê o Quadro 1 nem a aba Violência e vê só o aviso fixo (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, FAMILY_A);
      const notice = user.getByTestId("family-confidentiality-notice");
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect(notice).toContainText(NOTICE);
      await expect(
        user.getByRole("tab", { name: "Violência", exact: true }),
      ).toHaveCount(0);
      await expect(user.getByTestId("violence-history-section")).toHaveCount(0);
      await expect(user.getByTestId("violence-history-register")).toHaveCount(
        0,
      );
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "ausencia");

      // Mesmo endereço da aba: a tela volta ao resumo, sem o Quadro 1.
      await open(user, FAMILY_A, "violencia");
      await expect(user.getByTestId("violence-history-section")).toHaveCount(0);
      await expect(user.locator('[data-testid^="violence-history-row-"]')).toHaveCount(
        0,
      );
    });

    test("CA06 — a anotação do bloco Violência e violações não aparece para o não técnico e o POST do Quadro 1 é recusado (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, FAMILY_A, "anotacoes");
      await expect(user.getByTestId("family-notes-block")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        user.getByTestId("family-note-item").filter({ hasText: NOTE_CREAS }),
      ).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "nao-tecnico-ausencia",
      );

      const res = await postViolenceHistory(user);
      expect(res.status(), "POST do não técnico").toBe(403);
      expect(JSON.stringify(await res.json())).toContain("block_restricted");
    });
  });

  test.describe("Master", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(newPage(browser), MASTER);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test("CT10 — o Master lê o Quadro 1 e não tem Registrar nem Alterar; o POST dele é recusado (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, FAMILY_A, "violencia");
      await expect(user.getByTestId("violence-history-section")).toBeVisible({
        timeout: 15_000,
      });
      await expect(row(user, CHILD_LABOR)).toContainText("Vivida — persiste", {
        timeout: 15_000,
      });
      await expect(user.getByTestId("violence-history-register")).toHaveCount(
        0,
      );
      await expect(
        user.locator('[data-testid^="violence-history-alter-"]'),
      ).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "master-sem-acao");

      const res = await postViolenceHistory(user);
      expect(res.status(), "POST do Master").toBe(403);
      expect(JSON.stringify(await res.json())).toContain(
        "violence_history_requires_technical",
      );
    });
  });
});
