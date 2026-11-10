import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * US-RMA-02 (HU #11544) — digitação e impressão do RMA do CREAS, no frontend do TENANT.
 * Spec MANUAL multiusuário (o cenário declarativo E2E-051 cobre CA01, CA02, CA04 e CA07
 * em logins próprios; aqui os mesmos CAs também geram o print do dossiê, junto de
 * CA03, CA05 e CA06).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: no máximo 5 logins por spec — usa 2)
 *  1. técnico do "E2E CREAS RMA":
 *     - 2026-08: CA03 (marca "Não realiza oferta" no Bloco IV);
 *     - 2026-09: CA05 (L.1 de 30 para 32);
 *     - 2026-10: CA01, CA02, CA04, CA07 e CA06 (nesta ordem; o download vira `rma-impresso.pdf`);
 *  2. Master: CA05 na Auditoria (`/app/auditoria`).
 *  `beforeAll`/`afterAll` repõem a massa (`E2ECreasRmaManualSeeder`): apaga os valores digitados
 *  dos três meses e regrava L.1 = 30 em 2026-09 — a apuração da #11543 não muda.
 *
 * Credenciais só por variável de ambiente; nunca imprime CPF, nome ou corpo de resposta.
 */

const BASE = process.env.CLIENT_BASE_URL ?? "http://localhost:4174";
const TECNICO_CPF = process.env.E2E_CLIENT_CREAS_RMA_TECNICO_CPF ?? "";
const TECNICO_PASSWORD = process.env.E2E_CLIENT_CREAS_RMA_TECNICO_PASSWORD ?? "senha123";
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? "";
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? "";
const API_CONTAINER = process.env.E2E_API_CONTAINER ?? "api-laravel.test-1";

const ROUTE = "/app/protecao-especial/rma-creas";
const REPORT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "e2e", "reports", "11544-completar-imprimir-rma-acceptance");
const SHOTS = path.join(REPORT_DIR, "screenshots");

function reseed(): void {
  try {
    execFileSync(
      "docker",
      ["exec", API_CONTAINER, "php", "artisan", "db:seed", "--class=Database\\Seeders\\E2ECreasRmaManualSeeder", "--force"],
      { stdio: "ignore", timeout: 120_000 },
    );
  } catch {
    console.warn("[11544] não foi possível repor a massa pelo container; rode o E2ECreasRmaManualSeeder.");
  }
}

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.promises.mkdir(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  if ("goto" in target) {
    await target.screenshot({ path: file });
  } else {
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: file });
  }
}

async function openRma(page: Page, month: string): Promise<void> {
  await page.goto(`${ROUTE}?mes=${month}`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("creas-rma-header")).toBeVisible();
}

async function save(page: Page): Promise<void> {
  await page.getByTestId("rma-save-manual").click();
  await expect(page.getByTestId("rma-save-manual")).toBeDisabled();
}

async function fill(page: Page, cells: Record<string, string>): Promise<void> {
  for (const [id, value] of Object.entries(cells)) await page.getByTestId(`rma-cell-${id}`).fill(value);
}

const K1 = {
  "K.1-m_0_12": "1", "K.1-m_13_17": "1", "K.1-m_18_59": "2", "K.1-m_60p": "2",
  "K.1-f_0_12": "2", "K.1-f_13_17": "2", "K.1-f_18_59": "5", "K.1-f_60p": "5",
};

test.describe.configure({ mode: "serial" });

test.describe("US-RMA-02 #11544 — digitação e impressão do RMA do CREAS", () => {
  let page: Page;

  test.beforeAll(() => {
    reseed();
  });

  test.afterAll(async () => {
    await page?.context().close();
    reseed();
  });

  test("técnico: CA03 (não oferta), CA05 (30 → 32), CA01/02/04/07 e CA06 (impressão)", async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1100 } });
    page = await context.newPage();
    await loginAsTenantUser(page, TECNICO_CPF, TECNICO_PASSWORD);

    // CA03 — 2026-08: "Não realiza oferta do serviço" no Bloco IV.
    await openRma(page, "2026-08");
    await page.getByTestId("rma-not-offered-IV").click();
    await save(page);
    const blockIv = page.getByTestId("creas-rma-block-IV");
    await expect(page.getByTestId("creas-rma-block-not-offered-IV")).toBeVisible();
    await expect(blockIv.getByText("Não se aplica").first()).toBeVisible();
    await shot(blockIv, "CA03-nao-ofertado");
    await page.getByTestId("rma-not-offered-IV").click();
    await save(page);

    // CA05 — 2026-09: L.1 de 30 para 32.
    await openRma(page, "2026-09");
    await expect(page.getByTestId("rma-cell-L.1-total")).toHaveValue("30");
    await fill(page, { "L.1-total": "32" });
    await save(page);
    await expect(page.getByTestId("rma-cell-L.1-total")).toHaveValue("32");

    // CA01/CA02/CA04/CA07/CA06 — 2026-10.
    await openRma(page, "2026-10");
    await fill(page, { ...K1, "K.2-total": "2", "K.3-total": "3", "K.4-total": "4", "K.5-total": "5", "K.6-total": "6", "L.1-total": "20" });
    await save(page);
    await expect(page.getByTestId("rma-informed-badge-K.1")).toBeVisible();
    await expect(page.getByTestId("rma-informed-badge-L.1")).toBeVisible();
    await shot(page.getByTestId("creas-rma-block-IV"), "CA01-bloco-iv-informado");

    const b5 = page.getByTestId("creas-rma-item-B-5");
    await expect(page.getByTestId("creas-rma-source-B-5")).toContainText("Não informado");
    await shot(b5, "CA02-b5-nao-informado");

    await fill(page, { "L.1-total": "15" });
    await save(page);
    const alert = page.getByTestId("rma-alert-l1_lt_k1");
    await expect(alert).toBeVisible();
    await shot(alert.locator("xpath=../.."), "CA04-alerta-l1-k1");
    await fill(page, { "L.1-total": "20" });
    await save(page);
    await expect(alert).toBeHidden();

    await page.getByTestId("rma-print").click();
    const dialog = page.getByTestId("rma-print-pending-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("rma-print-pending-item").first()).toContainText("B.5");
    await shot(page, "CA07-aviso-pendencias");
    await page.getByTestId("rma-print-back").click();
    await expect(dialog).toBeHidden();

    await fill(page, { "B.5-total": "0" });
    await save(page);
    await shot(page.getByTestId("creas-rma-item-B-5"), "CA06-b5-informado-zero");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("rma-print").click()]);
    await expect(dialog).toBeHidden();
    await fs.promises.mkdir(SHOTS, { recursive: true });
    const pdf = path.join(REPORT_DIR, "rma-impresso.pdf");
    await download.saveAs(pdf);
    expect(fs.readFileSync(pdf).subarray(0, 5).toString()).toBe("%PDF-");
    execFileSync("pdftoppm", ["-png", "-r", "80", "-f", "1", "-l", "1", "-singlefile", pdf, path.join(SHOTS, "CA06-rma-impresso")]);
  });

  test("Master: CA05 na Auditoria (de 30 para 32)", async ({ browser }) => {
    test.setTimeout(120_000);
    await page.context().close();
    const context = await browser.newContext({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    await loginAsTenantUser(page, MASTER_CPF, MASTER_PASSWORD);
    await page.goto("/app/auditoria");
    await dismissPlatformUpdates(page);

    const rows = page.getByTestId("tenant-audit-row").filter({ hasText: "Valor informado do RMA" });
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    const count = await rows.count();
    let found = false;
    for (let i = 0; i < count && !found; i++) {
      await rows.nth(i).getByTestId("tenant-audit-view-detail").click();
      const detail = page.getByTestId("tenant-audit-detail");
      await expect(detail).toBeVisible();
      if (await detail.getByTestId("audit-value-change").filter({ hasText: "de 30 para 32" }).count()) {
        await expect(detail).toContainText("L.1 · 09/2026 · E2E CREAS RMA");
        await shot(page, "CA05-auditoria-de-30-para-32");
        found = true;
      }
      await page.keyboard.press("Escape");
      await expect(detail).toBeHidden();
    }
    expect(found, "linha com 'de 30 para 32'").toBe(true);
  });
});
