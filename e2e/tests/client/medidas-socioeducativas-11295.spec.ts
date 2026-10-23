import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-MSE-01 (HU #11295) — medidas socioeducativas na aba "Medidas
 * socioeducativas" do prontuário (`client/`). Spec MANUAL multiusuário: o
 * cenário declarativo E2E-033 cobre o técnico do CRAS Centro (CA02, CA03, CA04,
 * CA07, sessão herdada); aqui ficam o Master (lê, sem ação), o técnico do CREAS
 * (CA01 e CA08) e o não técnico (CA05).
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`) — 3 logins, ordem fixa
 *  1. Master: lê as duas medidas fixas de Pedro, sem Registrar nem Corrigir;
 *  2. técnico do CREAS (acessa pelo encaminhamento recebido): registra LA (CA01) e
 *     confere que a aba Acompanhamento segue sem acompanhamento (CA08);
 *  3. não técnico do CRAS Centro: aba ausente; API → `[]` e POST → 403 (CA05).
 *
 * ## Massa (E2ESocioEducationalMeasureSeeder, api; tudo fictício)
 * Família `…000011295001`, sem `family_follow_ups`. Ressemear antes de cada rodada.
 * Asserções pelo processo, nunca por contagem absoluta. Nunca imprime CPF/nome em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY = "00000000-0000-4000-8000-000011295001";
const PROCESS_LA_CLOSED = "0004321-73.2025.8.02.0001";
const PROCESS_INTERNMENT = "0007777-94.2026.8.02.0001";
const PROCESS_NEW = "0001234-75.2026.8.02.0001";
const TAB = "Medidas socioeducativas";
const EVIDENCE_SLUG = "11295-historico-medidas-socioeducativas";

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

async function open(page: Page, tab?: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}${tab ? `?tab=${tab}` : ""}`);
  await dismissPlatformUpdates(page);
  await expect(
    page.getByRole("tab", { name: "Composição Familiar", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

function measureRow(page: Page, processNumber: string) {
  return page
    .locator('[data-testid^="socio-educational-measure-row-"]')
    .filter({ hasText: processNumber });
}

async function api(
  user: Page,
  method: "get" | "post",
  suffix: string,
): Promise<APIResponse> {
  const cookies = await user.context().cookies();
  const xsrf = decodeURIComponent(
    cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "",
  );
  return user.context().request[method](`${API_BASE}/api/client/families/${FAMILY}/${suffix}`, {
    ...(method === "post" ? { data: {} } : {}),
    headers: {
      Accept: "application/json",
      Origin: BASE!,
      Referer: `${BASE}/app`,
      "X-Requested-With": "XMLHttpRequest",
      "X-Tenant-UUID": TENANT_UUID,
      "X-XSRF-TOKEN": xsrf,
    },
  });
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
    viewport: { width: 1440, height: 1200 },
  });

test.describe("US-MSE-01 — medidas socioeducativas do prontuário (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });

  test.describe("Master", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(newPage(browser), MASTER);
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test("CA10 — o Master lê as medidas e não tem Registrar medida nem Corrigir (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, "medidas-socioeducativas");
      await expect(user.getByTestId("socio-educational-measure-block")).toBeVisible({
        timeout: 15_000,
      });
      await expect(measureRow(user, PROCESS_LA_CLOSED)).toBeVisible({ timeout: 15_000 });
      await expect(measureRow(user, PROCESS_INTERNMENT)).toBeVisible();
      await expect(user.getByTestId("socio-educational-measure-register-action")).toHaveCount(0);
      await expect(
        user.locator('[data-testid^="socio-educational-measure-correct-"]'),
      ).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "master-le-sem-acao");
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

    test("CA01 — o técnico do CREAS registra LA acompanhada e a medida mostra nome, função e data da anotação", async ({}, testInfo) => {
      await open(user, "medidas-socioeducativas");
      await expect(user.getByTestId("socio-educational-measure-block")).toBeVisible({
        timeout: 15_000,
      });
      await user.getByTestId("socio-educational-measure-register-action").click();
      await expect(user.getByTestId("socio-educational-measure-form-sheet")).toBeVisible({
        timeout: 10_000,
      });
      await user.getByTestId("socio-educational-measure-form-member").click();
      await user.getByRole("option", { name: "E2E Pedro MSE", exact: true }).click();
      await user.getByTestId("socio-educational-measure-form-type").click();
      await user.getByRole("option", { name: "Liberdade assistida (LA)", exact: true }).click();
      await user.getByTestId("socio-educational-measure-form-process").fill(PROCESS_NEW);
      await user.getByTestId("socio-educational-measure-form-started-month").click();
      await user.getByRole("option", { name: "Maio", exact: true }).click();
      await user.getByTestId("socio-educational-measure-creas-yes").click();
      await user.getByTestId("socio-educational-measure-form-submit").click();

      const row = measureRow(user, PROCESS_NEW);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toContainText("Acompanhada pelo CREAS: Sim");
      const signature = row.locator('[data-testid^="socio-educational-measure-signature-"]');
      await expect(signature).toContainText("Registrado por");
      await expect(signature).toContainText("Assistente social");
      await expect(signature).toContainText(/\d{2}\/\d{2}\/\d{4}/);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "registro-creas");
    });

    test("CA08 — a aba Acompanhamento segue sem acompanhamento e a API devolve lista vazia (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, "acompanhamento");
      await expect(user.getByText("Esta família nunca foi acompanhada")).toBeVisible({
        timeout: 15_000,
      });
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "sem-acompanhamento-paefi");

      const res = await api(user, "get", "follow-ups");
      expect(res.status(), "GET follow-ups").toBe(200);
      expect((await res.json()).data).toEqual([]);
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

    test("CA05 — o não técnico não vê a aba, a URL direta cai no resumo e a API devolve lista vazia e 403 no POST (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user);
      await expect(user.getByRole("tab", { name: TAB, exact: true })).toHaveCount(0);

      await open(user, "medidas-socioeducativas");
      await expect(user.getByTestId("socio-educational-measure-block")).toHaveCount(0);
      await expect(user.getByRole("tab", { name: TAB, exact: true })).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "aba-ausente");

      const list = await api(user, "get", "socio-educational-measures");
      expect(list.status(), "GET medidas do não técnico").toBe(200);
      expect((await list.json()).data).toEqual([]);

      const post = await api(user, "post", "socio-educational-measures");
      expect(post.status(), "POST do não técnico").toBe(403);
      expect(JSON.stringify(await post.json())).toContain("block_restricted");
    });
  });
});
