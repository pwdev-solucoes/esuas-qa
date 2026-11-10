import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type Page,
} from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-13 (HU #11548) — o Master não registra informação sigilosa e a pesquisa
 * por CPF não revela família de outra unidade. Spec MANUAL multiusuário (o
 * E2E-054 cobre CA01, CA04 e CA08 com um login por variante).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: 4 logins, sequenciais, nesta ordem)
 *  1. Master: CA02 (abas sem ação de registrar), CA03 (POST direto → 403
 *     `block_restricted`, contagem igual) e CA07 (pesquisa do CPF escondido
 *     mostra a linha da família);
 *  2. técnico do CREAS Sul: CA05 (pesquisa do mesmo CPF → "não encontrada"),
 *     CA05b (cadastrar → "Procure o gestor Master") e CA06 (pessoa de fora →
 *     "já está cadastrada" + vincular);
 *  3. operador do CRAS Centro: CA09 (aviso da referência "Condições
 *     habitacionais" = "todas as unidades");
 *  4. auxiliar administrativo: DoD (sem leitura nem registro do sigiloso).
 *
 * ## Massa (api)
 * `E2ESigiloMasterPesquisaSeeder` (famílias …11548001 e …11548002), reaplicada
 * antes do arquivo. Credenciais e CPFs só por variável de ambiente; nada é
 * impresso nem gravado.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const EVIDENCE_SLUG = "11548-sigilo-registro-master-e-pesquisa";
const FAMILY = "00000000-0000-4000-8000-000011548001";

const MASTER = [
  process.env.E2E_CLIENT_MASTER_CPF,
  process.env.E2E_CLIENT_MASTER_PASSWORD,
] as const;
const SUL = [
  process.env.E2E_CLIENT_CREAS_SUL_TECNICO_CPF,
  process.env.E2E_CLIENT_CREAS_SUL_TECNICO_PASSWORD,
] as const;
const OPERADOR = [
  process.env.E2E_CLIENT_OPERADOR_CPF,
  process.env.E2E_CLIENT_OPERADOR_PASSWORD,
] as const;
const ADMIN_STAFF = [
  process.env.E2E_CLIENT_ADMIN_STAFF_CPF,
  process.env.E2E_CLIENT_ADMIN_STAFF_PASSWORD,
] as const;
const HIDDEN_CPF = process.env.E2E_CLIENT_PERSON_HIDDEN_FAMILY_CPF;
const OUTSIDE_CPF = process.env.E2E_CLIENT_PERSON_OUTSIDE_CPF;

// "Registrar observação" é a anotação (P1, segue permitida); o Quadro 2 (período anterior) e o formulário de vínculos da Convivência e o ingresso no acompanhamento não estão na lista sigilosa da RN01.
const REGISTER_ACTION = /^(?!Registrar observação|Registrar período anterior|Registrar (o primeiro )?ingresso)(Registrar|Corrigir)\b/i;

let shared: Page | undefined;

async function startSession(
  browser: Browser,
  user: readonly [string | undefined, string | undefined],
): Promise<Page> {
  if (shared) await shared.context().close();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1100 },
  });
  shared = await context.newPage();
  await loginAsTenantUser(shared, user[0]!, user[1]!, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(shared);
  return shared;
}

async function api(
  page: Page,
  method: "get" | "post",
  suffix: string,
  data: Record<string, unknown> = {},
): Promise<APIResponse> {
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(
    cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "",
  );
  return page
    .context()
    .request[method](`${API_BASE}/api/client/families/${FAMILY}/${suffix}`, {
      ...(method === "post" ? { data } : {}),
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

async function openTab(page: Page, tab: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=${tab}`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("family-record-nav")).toBeVisible({
    timeout: 15_000,
  });
}

async function searchByCpf(page: Page, cpf: string): Promise<void> {
  await page.goto("/app/cadastros/pesquisa-pessoas");
  await dismissPlatformUpdates(page);
  await page.locator("#person-search-cpf").fill(cpf);
  await page.getByRole("button", { name: /pesquisar/i }).click();
}

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-13 #11548 — sigilo do Master e pesquisa por CPF", () => {
  test.skip(
    !BASE ||
      !MASTER[0] ||
      !MASTER[1] ||
      !SUL[0] ||
      !SUL[1] ||
      !OPERADOR[0] ||
      !OPERADOR[1] ||
      !ADMIN_STAFF[0] ||
      !ADMIN_STAFF[1] ||
      !HIDDEN_CPF ||
      !OUTSIDE_CPF,
    "sem URL do client, credenciais ou CPFs da massa",
  );
  test.afterAll(async () => {
    if (shared) await shared.context().close();
    shared = undefined;
  });

  test("CA02 — o Master lê as abas sigilosas sem ação de registrar dados (a evidência é a ausência)", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, MASTER);
    for (const tab of [
      "saude",
      "violencia",
      "medidas-socioeducativas",
      "convivencia",
      "acompanhamento",
    ]) {
      await openTab(page, tab);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main").first()).toBeVisible();
      await expect(
        page.locator("main").getByRole("button", { name: REGISTER_ACTION }),
        `aba ${tab}`,
      ).toHaveCount(0);
      await captureEvidence(page, testInfo, EVIDENCE_SLUG, tab);
    }
    // P1: a anotação continua permitida ao Master.
    await openTab(page, "anotacoes");
    await expect(page.getByTestId("family-note-register-action")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("CA03 — o POST direto do Master em acolhimento, saúde e avaliação é 403 block_restricted e a contagem não muda", async ({}, testInfo) => {
    const page = shared!;
    await openTab(page, "acolhimento");
    const before = await api(page, "get", "shelterings");
    expect(before.status(), "GET shelterings").toBe(200);
    const count = ((await before.json()).data ?? []).length;

    for (const [suffix, body] of [
      ["shelterings", {}],
      ["diagnosis-snapshots", { block: "health_conditions" }],
      ["relationship-assessments", {}],
    ] as const) {
      const res = await api(page, "post", suffix, { ...body });
      expect(res.status(), `POST ${suffix}`).toBe(403);
      expect(JSON.stringify(await res.json())).toContain("block_restricted");
    }

    const after = await api(page, "get", "shelterings");
    expect(((await after.json()).data ?? []).length).toBe(count);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA07 — o Master pesquisa o CPF da família escondida e vê a linha com Visualizar Família", async ({}, testInfo) => {
    const page = shared!;
    await searchByCpf(page, HIDDEN_CPF!);
    await expect(
      page.getByRole("button", { name: /visualizar família/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("global-person-absent")).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA05 — o técnico do CREAS Sul pesquisa o mesmo CPF e vê a tela de não encontrada, sem pista da família (a evidência é a ausência)", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, SUL);
    await searchByCpf(page, HIDDEN_CPF!);
    await expect(page.getByTestId("global-person-absent")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("global-person-exists")).toHaveCount(0);
    await expect(page.getByTestId("global-person-link")).toHaveCount(0);
    await expect(page.getByText(/já está cadastrada/i)).toHaveCount(0);
    await expect(page.getByText(/vincular/i)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /visualizar família/i }),
    ).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA05b — ao cadastrar o mesmo CPF, o técnico recebe a orientação de procurar o gestor Master", async ({}, testInfo) => {
    const page = shared!;
    await page.getByTestId("global-person-create").click();
    await expect(page.getByTestId("person-create-form")).toBeVisible();
    await page.locator("#create-full-name").fill("E2E Pessoa Duplicada");
    await page.locator("#create-birth-date").fill("1990-01-01");
    await page.getByTestId("create-sex-trigger").click();
    await page.getByRole("option").first().click();
    await page.locator("#create-mother-name").fill("E2E Mãe Fictícia");
    await page.getByTestId("create-submit").click();
    const alert = page.getByTestId("person-create-managed-elsewhere");
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(/Procure o gestor Master/i);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA06 — a pessoa de fora do município segue com a mensagem de já cadastrada e o vínculo", async ({}, testInfo) => {
    const page = shared!;
    await searchByCpf(page, OUTSIDE_CPF!);
    await expect(page.getByTestId("global-person-exists")).toContainText(
      /já está cadastrada na plataforma/i,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("global-person-link")).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA09 — o técnico do CRAS Centro vê, na referência Condições habitacionais, o aviso de todas as unidades", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, OPERADOR);
    await openTab(page, "anotacoes");
    await page.getByTestId("family-note-register-action").click();
    await expect(page.getByTestId("family-note-form-sheet")).toBeVisible();
    await page.getByTestId("family-note-block-select").click();
    await page
      .getByRole("option", { name: "Condições habitacionais", exact: true })
      .click();
    const notice = page.getByTestId("family-note-readers-notice");
    await expect(notice).toContainText(/todas as unidades/i);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("DoD — o auxiliar administrativo não lê nem registra o sigiloso da família (a evidência é a ausência)", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, ADMIN_STAFF);
    await openTab(page, "acolhimento");
    await expect(
      page.getByRole("tab", { name: "Acolhimento", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("sheltering-block")).toHaveCount(0);
    await expect(page.getByTestId("sheltering-register-action")).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "sem-acolhimento");

    const res = await api(page, "post", "shelterings", {});
    expect([403, 404]).toContain(res.status());
  });
});
