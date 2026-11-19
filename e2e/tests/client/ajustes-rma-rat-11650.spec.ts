import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * HU #11650 — ajustes do RMA do CREAS e do Relatório de Atividades, no frontend do TENANT.
 * Spec MANUAL de dois logins (⚠️ `throttle:6,1`): o cenário declarativo E2E-062 cobre o menu,
 * a confirmação da troca e a linha usada em logins próprios; aqui os CAs geram o print do dossiê.
 *
 *  1. técnico da "E2E CREAS RMA": CA09 (menu), CA01–CA03 (M.2), CA04 (I.1), CA05 (C.2),
 *     CA06 (registro do CRAS depois do retorno: C.3 e Mapa), CA14 (alerta de L.1, 2026-07),
 *     CA15 (baixa o PDF — `rma-impresso.pdf`) e CA08 (aviso do Bloco III, salvar e imprimir);
 *  2. Master: CA07 (novo encaminhamento ⇒ volta a contar), CA13/CA17 (indicação e código 14 no editor),
 *     CA18 (linha usada), CA16 (pré-visualização outubro × novembro), CA11/CA10 (cancela e confirma a
 *     troca), CA12/CA13 (outubro mantém a estrutura, com a indicação ao lado de "Calculada").
 *  CA19 (isolamento por tenant) não tem tela: a evidência é o Pest do escopo (apêndice do dossiê).
 *
 * Massa: `E2ERmaRatAdjustmentsSeeder` (reaplicada no `beforeAll` e no `afterAll`).
 * Esperado em 2026-10 (declarado no seeder): M.2 = 6 (2 lançamentos + 4 encontros; o cancelado não conta),
 * I.1 = 1, C.2 = 2 (um é da massa da #11543), C.3 = 0 até o novo encaminhamento.
 * Credenciais só por variável de ambiente; nunca imprime CPF, nome ou corpo de resposta.
 */

const BASE = process.env.CLIENT_BASE_URL ?? "http://localhost:4174";
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID = process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const TECNICO_CPF = process.env.E2E_CLIENT_CREAS_RMA_TECNICO_CPF ?? "";
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF ?? "";
const TECNICO_PASSWORD = process.env.E2E_CLIENT_CREAS_RMA_TECNICO_PASSWORD ?? "senha123";
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? "";
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? "";
const API_CONTAINER = process.env.E2E_API_CONTAINER ?? "api-laravel.test-1";

const RMA_ROUTE = "/app/prestacao-contas/rma-creas";
const MAP_ROUTE = "/app/protecao-especial/mapa-creas";
const TEMPLATES_ROUTE = "/app/configuracoes/modelos-relatorio-atividades";
const REPORT_ROUTE = "/app/prestacao-contas/relatorio-atividades";
const UNIT_RMA = "00000000-0000-4000-8000-000011543051";
const UNIT_CENTRO = "00000000-0000-4000-8000-0000000e0001";
const FAMILY_RETORNO = "00000000-0000-4000-8000-000011650030";
const TEMPLATE_2026 = "00000000-0000-4000-8000-000011650501";
const REPORT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "e2e", "reports", "11650-ajustes-rma-relatorio-atividades-acceptance");
const SHOTS = path.join(REPORT_DIR, "screenshots");

function reseed(): void {
  try {
    execFileSync(
      "docker",
      ["exec", API_CONTAINER, "php", "artisan", "db:seed", "--class=Database\\Seeders\\E2ERmaRatAdjustmentsSeeder", "--force"],
      { stdio: "ignore", timeout: 120_000 },
    );
  } catch {
    console.warn("[11650] não foi possível repor a massa pelo container; rode o E2ERmaRatAdjustmentsSeeder.");
  }
}

function tinker(code: string): string {
  return execFileSync("docker", ["exec", API_CONTAINER, "php", "artisan", "tinker", `--execute=${code}`], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.promises.mkdir(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  if ("goto" in target) {
    await target.waitForTimeout(700);
    await target.screenshot({ path: file });
  } else {
    await target.scrollIntoViewIfNeeded();
    await target.page().waitForTimeout(700);
    await target.screenshot({ path: file });
  }
}

async function api(page: Page, method: "get" | "post", urlPath: string, data?: unknown): Promise<any> {
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "");
  const res = await page.context().request[method](`${API_BASE}/api/client/${urlPath}`, {
    ...(method === "post" ? { data: data ?? {} } : {}),
    headers: {
      Accept: "application/json",
      Origin: BASE,
      Referer: `${BASE}/app`,
      "X-Requested-With": "XMLHttpRequest",
      "X-Tenant-UUID": TENANT_UUID,
      "X-XSRF-TOKEN": xsrf,
    },
  });
  const failure = res.ok() ? "" : ` ${JSON.stringify((await res.json().catch(() => ({}))).errors ?? {})}`;
  expect(res.ok(), `${method} ${urlPath} => ${res.status()}${failure}`).toBeTruthy();
  const body = await res.json().catch(() => ({}));
  return body?.data ?? body;
}

/** O toast do sonner cobre o botão de salvar logo após uma gravação: tira os toasts antes do clique. */
async function clearToasts(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll("[data-sonner-toast]").forEach((el) => el.remove()));
}

async function openRma(page: Page, month: string, unit?: string): Promise<void> {
  await page.goto(`${RMA_ROUTE}?mes=${month}${unit ? `&unidade=${unit}` : ""}`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("creas-rma-header")).toBeVisible();
}

async function save(page: Page): Promise<void> {
  await clearToasts(page);
  const saved = page.waitForResponse((r) => r.url().includes("/creas-rmas/manual-values") && r.request().method() === "PUT");
  await page.getByTestId("rma-save-manual").click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId("rma-save-manual")).toBeDisabled();
}

async function fill(page: Page, cells: Record<string, string>): Promise<void> {
  for (const [id, value] of Object.entries(cells)) await page.getByTestId(`rma-cell-${id}`).fill(value);
}

const cellOf = (page: Page, item: string, key: string) => page.getByTestId(`creas-rma-cell-${item}-${key}`);
const itemOf = (page: Page, item: string) => page.getByTestId(`creas-rma-item-${item}`);

const K1 = {
  "K.1-m_0_12": "1", "K.1-m_13_17": "1", "K.1-m_18_59": "2", "K.1-m_60p": "2",
  "K.1-f_0_12": "2", "K.1-f_13_17": "2", "K.1-f_18_59": "5", "K.1-f_60p": "5",
};

function mapCell(unit: string, month: string, code: string, level: string): string {
  return `cell-${unit}-${month}-${code}-${level}`;
}

test.describe.configure({ mode: "serial" });

test.describe("HU #11650 — ajustes do RMA do CREAS e do Relatório de Atividades", () => {
  let page: Page;

  test.beforeAll(() => {
    reseed();
  });

  test.afterAll(async () => {
    await page?.context().close();
    reseed();
  });

  test("técnico: CA09, CA01–CA06, CA14, CA15 e CA08", async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    page = await context.newPage();
    await loginAsTenantUser(page, TECNICO_CPF, TECNICO_PASSWORD);

    // CA09 — o RMA fica em Prestação de Contas, junto do Relatório de Atividades; o Mapa continua em PSE.
    await page.goto("/app");
    await dismissPlatformUpdates(page);
    const section = (title: string) => page.locator("aside nav > div", { has: page.locator("h3", { hasText: title }) });
    await expect(section("Prestação de Contas").locator("button", { hasText: "RMA do CREAS" })).toBeVisible();
    await expect(section("Prestação de Contas").locator("button", { hasText: "Relatório de Atividades" }).first()).toBeVisible();
    await expect(section("Proteção Social Especial").locator("button", { hasText: "Mapa Consolidado do CREAS" })).toBeVisible();
    await expect(section("Proteção Social Especial").locator("button", { hasText: "RMA do CREAS" })).toHaveCount(0);
    await shot(page.locator("aside"), "CA09-menu-prestacao-de-contas");
    await page.goto("/app/protecao-especial/rma-creas?mes=2026-10");
    await dismissPlatformUpdates(page);
    await expect(page).toHaveURL(/\/app\/prestacao-contas\/rma-creas/); // a URL antiga redireciona

    // CA01–CA05 — números apurados de 2026-10.
    await openRma(page, "2026-10");
    await expect(cellOf(page, "M-2", "total")).toHaveText("6"); // 2 lançamentos (5 e 3 famílias) + 4 encontros; o cancelado fora
    await shot(itemOf(page, "M-2"), "CA01-CA03-m2-por-lancamento");
    await expect(cellOf(page, "I-1", "total")).toHaveText("1");
    await shot(itemOf(page, "I-1"), "CA04-i1-so-quadro-3");
    await expect(cellOf(page, "C-2", "total")).toHaveText("2"); // sem o registro de 02/2026 do acompanhamento anterior
    await expect(cellOf(page, "C-2", "f_7_12")).toHaveText("2");
    await shot(itemOf(page, "C-2"), "CA05-c2-so-o-periodo-atual");

    // CA06 — registro do CRAS criado em 20/10 depois do retorno de 10/10: não conta no RMA nem no Mapa (a evidência é a ausência).
    await expect(cellOf(page, "C-3", "total")).toHaveText("0");
    await shot(itemOf(page, "C-3"), "CA06-c3-sem-registro-pos-retorno");
    await page.goto(`${MAP_ROUTE}?start_month=2026-10&end_month=2026-10`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("creas-record-map-rule-notice")).toBeVisible();
    await expect(page.getByTestId(mapCell(UNIT_RMA, "2026-10", "3", "confirmed"))).toHaveText("0");
    await shot(page.getByTestId(`creas-record-map-unit-${UNIT_RMA}`), "CA06-mapa-sem-registro-pos-retorno");

    // CA14 — 2026-07: K.1 = 20 e L.1 = 15 ⇒ alerta com a frase nova.
    await openRma(page, "2026-07");
    await fill(page, { ...K1, "L.1-total": "15" });
    await save(page);
    const alert = page.getByTestId("rma-alert-l1_lt_k1");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("O número de abordagens (L.1) não pode ser menor que o de pessoas abordadas (K.1).");
    await shot(alert.locator("xpath=../.."), "CA14-alerta-l1-k1");

    // CA15 — 2026-10 informado por inteiro: baixa o PDF (a apresentação é conferida no dossiê).
    await openRma(page, "2026-10");
    await fill(page, { ...K1, "K.2-total": "2", "K.3-total": "3", "K.4-total": "4", "K.5-total": "5", "K.6-total": "6", "L.1-total": "20", "B.5-total": "0" });
    await save(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("rma-print").click()]);
    await fs.promises.mkdir(SHOTS, { recursive: true });
    const pdf = path.join(REPORT_DIR, "rma-impresso.pdf");
    await download.saveAs(pdf);
    expect(fs.readFileSync(pdf).subarray(0, 5).toString()).toBe("%PDF-");
    for (const p of [1, 2]) {
      try {
        execFileSync("pdftoppm", ["-png", "-r", "70", "-f", String(p), "-l", String(p), "-singlefile", pdf, path.join(SHOTS, `CA15-rma-impresso-p${p}`)]);
      } catch {
        /* sem poppler ou PDF com menos páginas: o PDF fica no dossiê */
      }
    }

    // CA08 — Bloco III "não ofertado" com LA vigente em 10/2026: avisa, mas salva e imprime.
    await page.getByTestId("rma-not-offered-III").click();
    await expect(page.getByTestId("creas-rma-iii-warning")).toBeVisible();
    await shot(page.getByTestId("creas-rma-block-III"), "CA08-aviso-bloco-iii-ao-marcar");
    await save(page);
    const iiiAlert = page.getByTestId("rma-alert-iii_not_offered_with_measures");
    await expect(iiiAlert).toBeVisible();
    await expect(iiiAlert).toContainText("Bloco III está marcado como não ofertado");
    await shot(iiiAlert.locator("xpath=../.."), "CA08-alerta-bloco-iii-salvo");
    const [again] = await Promise.all([page.waitForEvent("download"), page.getByTestId("rma-print").click()]);
    expect(fs.readFileSync(await again.path()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("Master: CA07, CA13, CA17, CA18, CA16, CA11, CA10 e CA12", async ({ browser }) => {
    test.setTimeout(300_000);
    await page.context().close();
    const context = await browser.newContext({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1100 } });
    page = await context.newPage();
    await loginAsTenantUser(page, MASTER_CPF, MASTER_PASSWORD);

    // CA07 — novo encaminhamento CRAS → CREAS: o registro de 20/10 volta a contar no CREAS do novo encaminhamento.
    await page.goto("/app");
    await dismissPlatformUpdates(page);
    const ids = tinker(
      "$c = App\\Models\\ReferralCode::query()->where('code', '13')->value('uuid'); " +
        "$p = App\\Models\\TenantProfessional::withoutGlobalScopes()->whereHas('user', fn ($q) => $q->where('cpf', '" +
        OPERADOR_CPF +
        "'))->value('uuid'); echo 'IDS:' . $c . ':' . $p;",
    );
    const [codeUuid, professionalUuid] = (ids.match(/IDS:([0-9a-f-]{36}):([0-9a-f-]{36})/) ?? []).slice(1);
    expect(codeUuid && professionalUuid, "uuids do código 13 e do profissional").toBeTruthy();
    await api(page, "post", `families/${FAMILY_RETORNO}/referrals`, {
      referred_on: "2026-10-25",
      social_unit_uuid: UNIT_CENTRO,
      referral_code_uuid: codeUuid,
      destination_social_unit_uuid: UNIT_RMA,
      objective: "Novo encaminhamento fictício ao CREAS (HU #11650).",
      responsible_professional_uuid: professionalUuid,
    });
    await openRma(page, "2026-10", UNIT_RMA);
    await expect(cellOf(page, "C-3", "total")).toHaveText("1");
    await shot(itemOf(page, "C-3"), "CA07-c3-volta-a-contar");
    await page.goto(`${MAP_ROUTE}?start_month=2026-10&end_month=2026-10`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId(mapCell(UNIT_RMA, "2026-10", "3", "confirmed"))).toHaveText("1");
    await shot(page.getByTestId(`creas-record-map-unit-${UNIT_RMA}`), "CA07-mapa-volta-a-contar");

    // CA13 e CA17 — editor do modelo ativo: o que a linha conta e o código 14 marcado; salvar sem mexer mantém ['14'].
    await page.goto(`${TEMPLATES_ROUTE}/${TEMPLATE_2026}`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("art-editor")).toBeVisible();
    const b6 = page.getByTestId("art-line").filter({ hasText: "Encaminhamentos realizados" }).first();
    await b6.getByRole("button", { name: /editar/i }).first().click();
    await expect(page.getByTestId("art-line-form")).toBeVisible();
    await expect(page.getByTestId("art-line-counting-unit")).toContainText("encaminhamentos registrados no mês");
    await expect(page.getByTestId("art-line-code-14")).toBeChecked();
    // o print precisa mostrar o código 14 marcado: rola a lista de códigos até ele
    await page.getByTestId("art-line-code-14").scrollIntoViewIfNeeded();
    await shot(page, "CA13-CA17-editor-conta-e-codigo-14");
    await page.getByTestId("art-line-save").click();
    await expect(page.getByTestId("art-line-form")).toBeHidden();
    const detail = await api(page, "get", `activity-report-templates/${TEMPLATE_2026}`);
    expect(JSON.stringify(detail)).toContain('"source_codes":["14"]');

    // CA18 — excluir a B.15 (já usada): avisa de saída e oferece inativar, sem confirmação de exclusão.
    const b15 = page.getByTestId("art-line").filter({ hasText: "Reuniões de equipe" }).first();
    await b15.getByTestId("art-line-delete").click();
    await expect(page.getByTestId("art-in-use-dialog")).toBeVisible();
    await expect(page.getByTestId("art-in-use-deactivate")).toBeVisible();
    await expect(page.getByTestId("art-delete-dialog")).toHaveCount(0);
    await shot(page, "CA18-linha-usada-aviso");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("art-in-use-dialog")).toBeHidden();

    // CA16 — acrescenta a B.16 ao modelo: a pré-visualização de outubro (já iniciado) não a mostra; a de novembro mostra.
    await page.getByTestId("art-add-line").first().click();
    await page.getByTestId("art-line-number").fill("B.16");
    await page.getByTestId("art-line-text").fill("Estudos de caso");
    await page.getByTestId("art-line-source-type-manual").click();
    await page.getByTestId("art-line-save").click();
    await expect(page.getByTestId("art-line").filter({ hasText: "B.16 Estudos de caso" })).toBeVisible();
    await page.getByTestId("art-preview-unit").selectOption({ label: "E2E CREAS Sul" });
    await page.getByTestId("art-preview-month").fill("2026-10");
    await page.getByTestId("art-preview-run").click();
    await expect(page.getByTestId("art-preview-result")).toBeVisible();
    await expect(page.getByTestId("art-preview-frozen")).toBeVisible();
    await expect(page.getByTestId("art-preview-line").filter({ hasText: "B.16" })).toHaveCount(0);
    await shot(page.getByTestId("art-preview"), "CA16-preview-outubro-congelado");
    await page.getByTestId("art-preview-month").fill("2026-11");
    await page.getByTestId("art-preview-run").click();
    await expect(page.getByTestId("art-preview-line").filter({ hasText: "B.16" })).toBeVisible();
    await expect(page.getByTestId("art-preview-frozen")).toHaveCount(0);
    await shot(page.getByTestId("art-preview"), "CA16-preview-novembro-com-b16");

    // CA11 — cancelar a troca não muda nada.
    await page.goto(TEMPLATES_ROUTE);
    await dismissPlatformUpdates(page);
    const row2027 = page.getByTestId("art-row").filter({ hasText: "Relatório 2027" });
    const row2026 = page.getByTestId("art-row").filter({ hasText: "Relatório 2026" });
    await row2027.getByTestId("art-activate").click();
    await expect(page.getByTestId("art-replace-dialog")).toContainText("Relatório 2026");
    await expect(page.getByTestId("art-replace-dialog")).toContainText("será inativado");
    await shot(page, "CA10-confirmacao-troca");
    await page.getByTestId("art-replace-cancel").click();
    await expect(page.getByTestId("art-replace-dialog")).toHaveCount(0);
    await expect(row2026.getByTestId("art-status")).toHaveText(/Ativo/);
    await expect(row2027.getByTestId("art-status")).toHaveText(/Rascunho/);
    await shot(page.getByTestId("art-page"), "CA11-troca-cancelada");

    // CA10 — confirmar: o "2027" fica ativo e o "2026" inativo.
    await row2027.getByTestId("art-activate").click();
    await expect(page.getByTestId("art-replace-dialog")).toBeVisible();
    await page.getByTestId("art-replace-confirm").click();
    await expect(row2027.getByTestId("art-status")).toHaveText(/Ativo/);
    await expect(row2026.getByTestId("art-status")).toHaveText(/Inativo/);
    await shot(page.getByTestId("art-page"), "CA10-troca-concluida");

    // CA12 e CA13 — o relatório de outubro continua com a estrutura do "2026" (sem a B.16), e a linha calculada
    // declara o que conta junto do selo "Calculada".
    await page.goto(REPORT_ROUTE);
    await dismissPlatformUpdates(page);
    await page.getByTestId("activity-report-month").fill("2026-10");
    const unitSelect = page.getByTestId("activity-report-unit");
    if ((await unitSelect.count()) > 0) {
      await unitSelect.click();
      await page.getByRole("option", { name: "E2E CREAS Sul" }).click();
    }
    const lines = page.getByTestId("activity-report-line");
    await expect(lines.filter({ hasText: "Encaminhamentos realizados" })).toBeVisible();
    await expect(lines.filter({ hasText: "Internas" })).toBeVisible();
    await expect(lines.filter({ hasText: "B.16" })).toHaveCount(0);
    const calc = lines.filter({ hasText: "Encaminhamentos realizados" });
    await expect(calc).toContainText("Calculada");
    await expect(calc.getByTestId("activity-report-line-counting-unit")).toContainText("encaminhamentos registrados no mês");
    await shot(page.getByTestId("activity-report-block").first(), "CA12-CA13-outubro-mantem-estrutura-e-conta");
  });
});
