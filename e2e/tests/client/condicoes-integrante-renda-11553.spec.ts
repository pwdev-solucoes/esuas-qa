import fs from "node:fs";
import path from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  createTenantApiClient,
  loginAsTenantUser,
} from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * US-AJ-18 (HU #11553) — condições do integrante e renda em reais, no frontend do TENANT (`client/`).
 * Spec MANUAL. O cenário E2E-059 cobre CA01, CA02, CA03, CA05, CA06 (happy_path) e CA04 (validation).
 * Aqui ficam o que ele não expressa, com 3 logins em ordem fixa (throttle `6,1` do login):
 *
 *  1. técnico de UMA unidade: CA01b (série + renda do integrante B → "corrigir" desabilitado com o
 *     motivo), CA07 (`1500,50` → API `own_income = 1500.5`), CA07b (bloco familiar: renda declarada 1500 e
 *     Bolsa Família 600), CA07c (`0` → "Renda declarada" e R$ 0,00), CA08 (Convivência: ameaça/
 *     discriminação em "Perguntas ainda sem resposta"), CA09 (aba e título "Trabalho e rendimentos");
 *  2. técnico de DUAS unidades: CA04 (sem unidade → campo e rodapé indicados; nenhum retrato novo);
 *  3. auxiliar administrativo (não técnico): abre o drawer sem a seção de saúde (sigilo, DoD do épico)
 *     e salva educação → o drawer fecha (RN05).
 *
 * ## Massa (E2EMemberConditionsFixesSeeder, api)
 * Família …11553001 "E2E Condições Ajuste" no CRAS Centro. Reaplique o seeder antes de cada rodada
 * (a spec GRAVA retratos). As credenciais vêm só do ambiente; nenhum CPF, senha ou nome real é gravado aqui.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY = "00000000-0000-4000-8000-000011553001";
const MEMBER_A = "00000000-0000-4000-8000-000011553011";
const UNIT_NAME = "E2E CRAS Centro";
const SHOTS = path.resolve(
  __dirname,
  "../../../../e2e/reports/11553-condicoes-integrante-renda-acceptance/screenshots",
);

let api: APIRequestContext;
// Uma só aba para toda a spec: cada login vale até o próximo (ordem fixa, serial).
let page: Page;
let context: BrowserContext;

test.use({
  baseURL: BASE,
  locale: "pt-BR",
  viewport: { width: 1440, height: 1100 },
});
test.describe.configure({ mode: "serial" });

function credential(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Defina ${name} no ambiente do E2E.`);
  return value;
}

/** Print por CA no dossiê (só com CAPTURE_EVIDENCE=1). */
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.CAPTURE_EVIDENCE !== "1") return;
  await fs.promises.mkdir(SHOTS, { recursive: true });
  await page.screenshot({
    path: path.join(SHOTS, `${name}.png`),
    fullPage: true,
  });
}

async function openComposition(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=composicao`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("member-series-table")).toBeVisible({
    timeout: 15_000,
  });
}

function memberButton(page: Page, name: string): Locator {
  return page.locator(
    `tr[data-testid^="member-row-"]:has-text("${name}") [data-testid^="member-conditions-"]`,
  );
}

async function openDrawer(page: Page, name: string): Promise<void> {
  await openComposition(page);
  await memberButton(page, name).click();
  await expect(page.getByTestId("member-conditions-drawer")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("member-school-grade")).toBeVisible({
    timeout: 15_000,
  });
}

async function reopenDrawer(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("member-conditions-drawer")).toBeHidden({
    timeout: 15_000,
  });
  await memberButton(page, name).click();
  await expect(page.getByTestId("member-conditions-drawer")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("member-own-income")).toBeVisible({
    timeout: 15_000,
  });
}

async function memberOwnIncome(uuid: string): Promise<number | null> {
  const response = await api.get(
    `/api/client/families/${FAMILY}/members/${uuid}/conditions`,
  );
  expect(response.status(), "condições do integrante").toBe(200);
  const body = await response.json();
  const blocks = body.data?.blocks ?? body.blocks;
  const value = blocks?.work_income_conditions?.values?.own_income;

  return value === null || value === undefined ? null : Number(value);
}

async function snapshotTotal(block: string): Promise<number> {
  const response = await api.get(
    `/api/client/families/${FAMILY}/diagnosis-snapshots?block=${block}&per_page=1`,
  );
  expect(response.status(), `série de ${block}`).toBe(200);
  const body = await response.json();

  return Number(body.meta?.total ?? 0);
}

async function pickGrade(page: Page, label: RegExp): Promise<void> {
  await page.getByTestId("member-school-grade").click();
  await page.getByRole("option", { name: label }).first().click();
}

test.beforeAll(async ({ browser }) => {
  if (!BASE) return;
  api = await createTenantApiClient();
  context = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1100 },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await api?.dispose();
});

test.describe("US-AJ-18 — condições do integrante e renda em reais (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test("login 1 — técnico de uma unidade", async () => {
    await page.goto("/auth/login");
    await loginAsTenantUser(
      page,
      credential("E2E_CLIENT_CONDITIONS_ONE_UNIT_CPF"),
      credential("E2E_CLIENT_CONDITIONS_ONE_UNIT_PASSWORD"),
    );
    await dismissPlatformUpdates(page);
    await expect(page).toHaveURL(/\/app/);
  });

  test('CA01b — seção sem registro: "corrigir" fica desabilitado com a explicação', async () => {
    await openDrawer(page, "Integrante B");

    await pickGrade(page, /9º ano/);
    await page.getByTestId("member-own-income").fill("700");
    await page.getByTestId("member-conditions-save").click();

    await expect(page.getByTestId("snapshot-change-kind-dialog")).toBeVisible();
    await expect(page.getByTestId("snapshot-kind-correct")).toBeDisabled();
    await expect(
      page.getByTestId("snapshot-kind-correct-disabled-reason"),
    ).toContainText(/primeiro registro|data e unidade/i);
    await shot(page, "CA01b-corrigir-desabilitado");

    // Nada gravado: cancela a pergunta e o integrante B segue sem renda registrada.
    await page.getByTestId("snapshot-kind-cancel").click();
    expect(
      await memberOwnIncome("00000000-0000-4000-8000-000011553012"),
    ).toBeNull();
  });

  test("CA07 — renda com centavos: 1500,50 grava R$ 1.500,50", async () => {
    await openDrawer(page, "Integrante A");
    await page.getByTestId("member-own-income").fill("1500,50");
    await page.getByTestId("member-conditions-save").click();
    await page.getByTestId("snapshot-kind-update").click();
    await expect(
      page.getByTestId("member-conditions-update-panel"),
    ).toBeVisible();
    await page.getByTestId("member-conditions-confirm-update").click();
    await expect(page.getByTestId("member-conditions-drawer")).toBeHidden({
      timeout: 15_000,
    });

    await expect.poll(() => memberOwnIncome(MEMBER_A)).toBe(1500.5);
    await page.getByTestId("member-series-tab-work_income_conditions").click();
    await expect(
      page.getByTestId("member-series-panel-work_income_conditions"),
    ).toContainText("R$ 1.500,50");
    await shot(page, "CA07-renda-1500-50");
  });

  test('CA07c — zero continua resposta: R$ 0,00 e selo "Renda declarada"', async () => {
    await openDrawer(page, "Integrante A");
    await page.getByTestId("member-own-income").fill("0");
    await page.getByTestId("member-conditions-save").click();
    // Mesmo dia do retrato criado no CA07: a correção está habilitada.
    await page.getByTestId("snapshot-kind-correct").click();
    await expect(page.getByTestId("member-conditions-drawer")).toBeHidden({
      timeout: 15_000,
    });

    await expect.poll(() => memberOwnIncome(MEMBER_A)).toBe(0);
    await reopenDrawer(page, "Integrante A");
    await expect(page.getByTestId("member-own-income-declared")).toContainText(
      "Renda declarada",
    );
    await expect(page.getByTestId("member-own-income-unknown")).toHaveCount(0);
    await shot(page, "CA07c-zero-renda-declarada");
    await page.keyboard.press("Escape");
  });

  test("CA07b — bloco familiar em reais: renda declarada 1500 e Bolsa Família 600", async () => {
    await page.goto(`/app/cadastros/familias/${FAMILY}?tab=trabalho-renda`);
    await dismissPlatformUpdates(page);
    const block = page.getByTestId("work-income-block");
    await expect(block).toBeVisible({ timeout: 15_000 });

    const register = block.getByTestId("snapshot-register");
    if (await register.isVisible().catch(() => false)) {
      await register.click();
    } else {
      await block.locator('[data-testid^="snapshot-alter-"]').first().click();
      await page.getByTestId("snapshot-kind-update").click();
    }

    await expect(page.getByTestId("work-income-family-fields")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("work-income-declared_total_income").fill("1500");
    await page
      .getByTestId("work-income-program-bolsa_familia-amount")
      .fill("600");
    await page.getByTestId("diagnosis-snapshot-unit-select").click();
    await page.getByRole("option", { name: UNIT_NAME }).click();
    await page.getByTestId("diagnosis-snapshot-submit").click();

    await expect(block.getByTestId("snapshot-series")).toContainText(
      "R$ 1.500,00",
      { timeout: 15_000 },
    );
    await expect(block.getByTestId("snapshot-series")).toContainText(
      "R$ 600,00",
    );
    await shot(page, "CA07b-bloco-familiar-em-reais");
  });

  test('CA08 — "Sem informação" continua pendente na aba Convivência', async () => {
    await page.goto(`/app/cadastros/familias/${FAMILY}?tab=convivencia`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("community-living-form")).toBeVisible({
      timeout: 15_000,
    });

    const pending = page.getByTestId("community-living-pending");
    await expect(pending).toContainText("Perguntas ainda sem resposta");
    await expect(pending).toContainText(/ameaça ou discriminação/i);
    await pending.scrollIntoViewIfNeeded();
    await shot(page, "CA08-pergunta-pendente");
  });

  test('CA09 — a aba e o título dizem "Trabalho e rendimentos"', async () => {
    await page.goto(`/app/cadastros/familias/${FAMILY}?tab=trabalho-renda`);
    await dismissPlatformUpdates(page);

    await expect(
      page.getByRole("tab", { name: /Trabalho e rendimentos/ }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("work-income-block")).toContainText(
      "Trabalho e rendimentos",
    );
    await expect(
      page.getByRole("tab", { name: /Trabalho e rendimentos da família/ }),
    ).toHaveCount(0);
    await shot(page, "CA09-trabalho-e-rendimentos");
  });

  test("login 2 — técnico de duas unidades", async () => {
    await page.goto("/auth/login");
    await loginAsTenantUser(
      page,
      credential("E2E_CLIENT_CONDITIONS_TWO_UNITS_CPF"),
      credential("E2E_CLIENT_CONDITIONS_TWO_UNITS_PASSWORD"),
    );
    await dismissPlatformUpdates(page);
    await expect(page).toHaveURL(/\/app/);
  });

  test("CA04 — sem escolher a unidade: campo e rodapé indicados e nada gravado", async () => {
    const before = await snapshotTotal("work_income_conditions");

    await openDrawer(page, "Integrante A");
    await page.getByTestId("member-own-income").fill("900");
    await page.getByTestId("member-conditions-save").click();
    await page.getByTestId("snapshot-kind-update").click();
    await expect(
      page.getByTestId("member-conditions-update-panel"),
    ).toBeVisible();
    await page.getByTestId("member-conditions-confirm-update").click();

    await expect(
      page.getByTestId("member-conditions-footer-error"),
    ).toContainText("Escolha a unidade do registro para continuar.");
    await expect(page.getByTestId("member-conditions-drawer")).toBeVisible();
    await shot(page, "CA04-sem-unidade-rodape");

    expect(
      await snapshotTotal("work_income_conditions"),
      "nenhum retrato novo",
    ).toBe(before);
  });

  test("login 3 — auxiliar administrativo", async () => {
    await page.goto("/auth/login");
    await loginAsTenantUser(
      page,
      credential("E2E_CLIENT_ADMIN_STAFF_CPF"),
      credential("E2E_CLIENT_ADMIN_STAFF_PASSWORD"),
    );
    await dismissPlatformUpdates(page);
    await expect(page).toHaveURL(/\/app/);
  });

  test("sigilo — sem a seção de saúde, e salvar a educação fecha o drawer (RN05)", async () => {
    await openDrawer(page, "Integrante B");

    // Ausência: o auxiliar administrativo não vê a seção de saúde.
    await expect(
      page.getByTestId("member-section-education_conditions"),
    ).toBeVisible();
    await expect(
      page.getByTestId("member-section-health_conditions"),
    ).toHaveCount(0);
    await shot(page, "sigilo-saude-ausente");

    await pickGrade(page, /9º ano/);
    await page.getByTestId("member-conditions-save").click();
    await page.getByTestId("snapshot-kind-correct").click();
    await expect(page.getByTestId("member-conditions-drawer")).toBeHidden({
      timeout: 15_000,
    });
  });
});
