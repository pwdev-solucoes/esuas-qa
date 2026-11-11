import { expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * US-RAT-02 (HU #11546) — Relatório de Atividades do mês, frontend do TENANT.
 * Spec MANUAL (o cenário E2E-053 cobre CA01, CA02, CA03 e CA06 sem prints; aqui ficam CA04, CA05 e
 * CA07 e os prints de todos os CAs para o dossiê).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: 2 logins, sequenciais, ordem fixa)
 *  1. técnico do "E2E CREAS RMA": CA05 — grava pela API todas as linhas digitadas, abre
 *     2026-10, imprime sem diálogo, salva o download em `relatorio-atividades-impresso.pdf` e
 *     confere o nome do arquivo;
 *  2. técnico do "E2E CRAS Rural": CA04 (sem modelo para o CRAS ⇒ "o Master precisa montá-lo") e
 *     CA07 (o seletor não lista "E2E CREAS RMA" e a API com o uuid dele devolve 422 — a evidência
 *     é a AUSÊNCIA).
 *
 * ## Massa e limpeza
 * `E2EActivityReportMonthSeeder`. O `beforeAll` repõe a massa; o `afterAll` apaga os valores e o
 * relatório que o teste criou (reaplica o seeder).
 *
 * Credenciais só por variável de ambiente; nunca imprime CPF, nome ou corpo de resposta.
 */

const BASE = process.env.CLIENT_BASE_URL ?? "http://localhost:4174";
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID = process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const TECNICO_CPF = process.env.E2E_CLIENT_CREAS_RMA_TECNICO_CPF ?? "";
const TECNICO_PASSWORD = process.env.E2E_CLIENT_CREAS_RMA_TECNICO_PASSWORD ?? "senha123";
const RURAL_CPF = process.env.E2E_CLIENT_RURAL_CPF ?? "";
const RURAL_PASSWORD = process.env.E2E_CLIENT_RURAL_PASSWORD ?? "senha123";
const API_CONTAINER = process.env.E2E_API_CONTAINER ?? "api-laravel.test-1";

const ROUTE = "/app/prestacao-contas/relatorio-atividades";
const MONTH = "2026-10";
const UNIT_RMA_UUID = "00000000-0000-4000-8000-000011543051";
const LINE_A1 = "00000000-0000-4000-8000-000011546121";
const LINE_B15 = "00000000-0000-4000-8000-000011546125";
const LINE_B16 = "00000000-0000-4000-8000-000011546126";

const REPORT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "e2e", "reports", "11546-relatorio-atividades-mes-acceptance");
const SHOTS = path.join(REPORT_DIR, "screenshots");
const PDF_FILE = path.join(REPORT_DIR, "relatorio-atividades-impresso.pdf");

function reseed(): void {
  execFileSync(
    "docker",
    ["exec", API_CONTAINER, "php", "artisan", "db:seed", "--class=Database\\Seeders\\E2EActivityReportMonthSeeder", "--force"],
    { stdio: "ignore", timeout: 120_000 },
  );
}

async function shot(page: Page, name: string): Promise<void> {
  await fs.promises.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function apiCall(page: Page, method: "get" | "put", urlPath: string, data?: unknown) {
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "");
  return page.context().request[method](`${API_BASE}/api/client/${urlPath}`, {
    ...(method === "put" ? { data: data ?? {} } : {}),
    headers: {
      Accept: "application/json",
      Origin: BASE,
      Referer: `${BASE}/app`,
      "X-Requested-With": "XMLHttpRequest",
      "X-Tenant-UUID": TENANT_UUID,
      "X-XSRF-TOKEN": xsrf,
    },
  });
}

let shared: Page | undefined;

async function startSession(browser: Browser, cpf: string, password: string): Promise<Page> {
  if (shared) await shared.context().close();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  });
  shared = await context.newPage();
  await loginAsTenantUser(shared, cpf, password);
  return shared;
}

test.describe.configure({ mode: "serial" });

test.describe("US-RAT-02 #11546 — Relatório de Atividades do mês", () => {
  test.skip(!TECNICO_CPF || !RURAL_CPF, "sem credenciais");

  test.beforeAll(() => {
    reseed();
  });

  test.afterAll(async () => {
    if (shared) await shared.context().close();
    shared = undefined;
    reseed();
  });

  test("CA01, CA02, CA03 e CA06 — prints do dossiê pela tela do técnico do CREAS", async ({ browser }) => {
    const page = await startSession(browser, TECNICO_CPF, TECNICO_PASSWORD);
    const line = (n: string) => page.getByTestId("activity-report-line").filter({ hasText: n });

    await page.goto(ROUTE);
    await dismissPlatformUpdates(page);
    await page.getByTestId("activity-report-month").fill(MONTH);
    await expect(page.getByTestId("activity-report-header")).toBeVisible();

    // CA01 — o mês aberto: B.6 apurada pelo sistema (4) e as digitadas "Não informado".
    await expect(line("B.6").getByTestId("activity-report-line-value")).toHaveText(/4/);
    await expect(line("A.1").getByTestId("activity-report-line-status")).toContainText("Não informado");
    await shot(page, "CA01-relatorio-do-mes");

    // CA03 — a linha calculada não tem campo de edição.
    await expect(line("B.6").getByTestId("activity-report-line-input")).toHaveCount(0);
    await expect(line("B.6").getByTestId("activity-report-line-computed")).toBeVisible();
    await line("B.6").scrollIntoViewIfNeeded();
    await shot(page, "CA03-linha-calculada-sem-edicao");

    // CA06 — imprimir com A.1 e B.16 vazias abre o aviso de pendências (antes de gravar B.15).
    await line("B.15").getByTestId("activity-report-line-input").fill("6");
    await page.getByTestId("activity-report-save").click();
    await expect(line("B.15").getByTestId("activity-report-line-status")).toContainText("Informada pela equipe");
    await shot(page, "CA02-digitar-e-salvar");

    await page.getByTestId("activity-report-print").click();
    const dialog = page.getByTestId("activity-report-pending-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("activity-report-pending-item").filter({ hasText: "A.1" })).toBeVisible();
    await expect(dialog.getByTestId("activity-report-pending-item").filter({ hasText: "B.16" })).toBeVisible();
    await page.waitForTimeout(800); // fim da animação de abertura do diálogo
    await shot(page, "CA06-pendencias-antes-de-imprimir");
    await dialog.getByTestId("activity-report-print-back").click();
    await expect(dialog).toBeHidden();
  });

  test("CA05 — o técnico do CREAS imprime o relatório preenchido e baixa o PDF", async () => {
    const page = shared!;

    // Todas as linhas digitadas preenchidas pela API ⇒ a impressão não abre o aviso de pendências.
    const put = await apiCall(page, "put", "activity-reports/values", {
      reference_month: MONTH,
      social_unit_uuid: UNIT_RMA_UUID,
      values: [
        { line_uuid: LINE_A1, value: 18 },
        { line_uuid: LINE_B15, value: 6 },
        { line_uuid: LINE_B16, value: 3 },
      ],
    });
    expect(put.ok(), `put values => ${put.status()}`).toBeTruthy();

    await page.goto(ROUTE);
    await dismissPlatformUpdates(page);
    await page.getByTestId("activity-report-month").fill(MONTH);
    await expect(page.getByTestId("activity-report-header")).toBeVisible();
    await expect(page.getByTestId("activity-report-header")).toContainText(/E2E CREAS RMA/);
    const b6 = page.getByTestId("activity-report-line").filter({ hasText: "B.6" });
    await expect(b6.getByTestId("activity-report-line-value")).toHaveText(/4/);
    await expect(page.getByTestId("activity-report-line").filter({ hasText: "B.15" }).getByTestId("activity-report-line-input")).toHaveValue("6");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("activity-report-print").click(),
    ]);
    await expect(page.getByTestId("activity-report-pending-dialog")).toHaveCount(0);
    expect(download.suggestedFilename()).toMatch(/^relatorio-atividades-.*2026-10\.pdf$/);

    await fs.promises.mkdir(REPORT_DIR, { recursive: true });
    await download.saveAs(PDF_FILE);
    const pdf = await fs.promises.readFile(PDF_FILE);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    await expect(page.getByTestId("activity-report-print")).toBeEnabled();
    await page.waitForTimeout(800);
    await shot(page, "CA05-impressao");
  });

  test("CA04 e CA07 — o técnico do CRAS Rural vê a unidade sem modelo e não alcança o CREAS", async ({ browser }) => {
    const page = await startSession(browser, RURAL_CPF, RURAL_PASSWORD);

    await page.goto(ROUTE);
    await dismissPlatformUpdates(page);
    await page.getByTestId("activity-report-month").fill(MONTH);

    // CA04 — unidade do CRAS sem modelo: sem tabela e sem botões.
    const missing = page.getByTestId("activity-report-template-missing");
    await expect(missing).toBeVisible();
    await expect(missing).toContainText(/Master precisa montá-lo/);
    await expect(page.getByTestId("activity-report-save")).toHaveCount(0);
    await expect(page.getByTestId("activity-report-print")).toHaveCount(0);
    await shot(page, "CA04-unidade-sem-modelo");

    // CA07 — a evidência é a ausência: o seletor (quando existe) não lista a "E2E CREAS RMA"…
    const scope = await apiCall(page, "get", `activity-reports?reference_month=${MONTH}`);
    expect(scope.ok(), `get scope => ${scope.status()}`).toBeTruthy();
    const names: string[] = ((await scope.json())?.data?.scope?.units ?? []).map((u: { name: string }) => u.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("E2E CREAS RMA");

    const unit = page.getByTestId("activity-report-unit");
    if ((await unit.count()) > 0) {
      await unit.click();
      await expect(page.getByRole("option", { name: "E2E CREAS RMA" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await expect(page.getByText("E2E CREAS RMA")).toHaveCount(0);

    // …e a API, com o uuid da unidade do CREAS, recusa (422).
    const denied = await apiCall(page, "get", `activity-reports?reference_month=${MONTH}&social_unit_uuid=${UNIT_RMA_UUID}`);
    expect(denied.status()).toBe(422);

    await shot(page, "CA07-tecnico-de-outra-unidade");
  });
});
