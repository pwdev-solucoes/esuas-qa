import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import * as path from "node:path";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-VISIB-02 (HU #11289) — CA09 no client. O Administrador (Painel Global, via
 * API do guard `manager` com a sessão `.auth/api-client.json`) marca
 * `housing_conditions` como sigilosa: o não técnico deixa de ver a aba
 * "Condições habitacionais" e o técnico continua vendo. A seção SEMPRE volta a
 * `is_confidential=false` no `afterAll` (e antes, se sobrou de uma falha).
 *
 * Logins: 2 (não técnico e técnico do Centro) — respeita o throttle:6,1.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const ADMIN_ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:5175";
const TENANT_UUID = process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY_SILVA = "00000000-0000-4000-8000-000011289001";
const EVIDENCE_SLUG = "us-visib-02-sigilo-tecnico";
// A aba "Condições habitacionais" permanece (o client só esconde Saúde/Acolhimento);
// o efeito do sigilo é na ação de registrar/corrigir retrato e na série (D12/constrain).
const ACTIONS =
  '[data-testid="housing-condition-block"] [data-testid="snapshot-register"], [data-testid="housing-condition-block"] [data-testid^="snapshot-alter-"]';

const ADMIN_STAFF = {
  cpf: process.env.E2E_CLIENT_ADMIN_STAFF_CPF ?? "99000150108",
  password: process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD ?? "senha123",
};
const OPERADOR = {
  cpf: process.env.E2E_CLIENT_OPERADOR_CPF ?? "",
  password: process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? "",
};

type Row = { uuid: string; name: string; description?: string | null; key?: string; section?: string; is_confidential: boolean };

let admin: APIRequestContext;
let sectionUuid = "";
let sectionName = "";
let sectionDescription: string | null = null;

async function xsrf(): Promise<string> {
  const state = await admin.storageState();
  return decodeURIComponent(state.cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "");
}

async function rows(): Promise<Row[]> {
  const res = await admin.get("/api/record-sections?per_page=100");
  expect(res.status(), "GET record-sections").toBe(200);
  const body = await res.json();
  return body.data ?? body;
}

async function setConfidential(value: boolean): Promise<void> {
  const res = await admin.put(`/api/record-sections/${sectionUuid}`, {
    data: { name: sectionName, description: sectionDescription, is_confidential: value },
    headers: { "X-XSRF-TOKEN": await xsrf() },
  });
  expect(res.status(), "PUT record-sections").toBe(200);
}

async function confidentialCount(): Promise<number> {
  return (await rows()).filter((r) => r.is_confidential).length;
}

async function open(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY_SILVA}?tab=habitacao`);
  await dismissPlatformUpdates(page);
  await expect(page.getByRole("tab", { name: "Composição Familiar", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("housing-condition-block")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("housing-condition-block").getByTestId("snapshot-series")).toBeVisible({ timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });
test.use({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1600 } });

test.describe("US-VISIB-02 CA09 — seção ligada como sigilosa no Painel Global some para o não técnico no client", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");
  let baseline = 0;

  test.beforeAll(async () => {
    admin = await playwrightRequest.newContext({
      baseURL: API_BASE,
      storageState: path.resolve(__dirname, "..", "..", ".auth", "api-client.json"),
      extraHTTPHeaders: {
        Accept: "application/json",
        Origin: ADMIN_ORIGIN,
        Referer: `${ADMIN_ORIGIN}/app`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const list = await rows();
    const row = list.find((r) => (r.key ?? r.section) === "housing_conditions");
    expect(row, "seção housing_conditions").toBeTruthy();
    sectionUuid = row!.uuid;
    sectionName = row!.name;
    sectionDescription = row!.description ?? null;
    if (row!.is_confidential) await setConfidential(false);
    baseline = await confidentialCount();
  });

  test.afterAll(async () => {
    try {
      if (sectionUuid) await setConfidential(false);
      expect(await confidentialCount(), "seções sigilosas ao final").toBe(baseline);
    } finally {
      await admin?.dispose();
    }
  });

  test("CA09 — antes: o não técnico vê a aba; depois de ligar o sigilo, as ações de registrar/corrigir retrato somem (a evidência é a ausência)", async ({ browser }, testInfo) => {
    const user = await browser.newPage({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1600 } });
    try {
      await loginAsTenantUser(user, ADMIN_STAFF.cpf, ADMIN_STAFF.password, { tenantUuid: TENANT_UUID });
      await dismissPlatformUpdates(user);
      await open(user);
      await expect(user.locator(ACTIONS).first()).toBeVisible();
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "CA09-client-antes");

      await setConfidential(true);
      await open(user);
      await expect(user.locator(ACTIONS)).toHaveCount(0);
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "CA09-client-depois");
    } finally {
      await user.close();
    }
  });

  test("CA09 — com a seção sigilosa, o técnico do Centro continua vendo as ações de retrato", async ({ browser }, testInfo) => {
    const user = await browser.newPage({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1600 } });
    try {
      await loginAsTenantUser(user, OPERADOR.cpf, OPERADOR.password, { tenantUuid: TENANT_UUID });
      await dismissPlatformUpdates(user);
      await open(user);
      await expect(user.locator(ACTIONS).first()).toBeVisible();
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "CA09-client-tecnico");
    } finally {
      await user.close();
    }
  });
});
