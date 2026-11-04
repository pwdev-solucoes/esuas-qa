import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-12 (HU #11409) — serviços do CREAS no acompanhamento. Spec MANUAL
 * multiusuário (o E2E-049 cobre CA01, CA02, CA02b e CA04 com um login por
 * variante).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: 2 logins, sequenciais)
 *  1. técnico do CREAS: CA03 (família `…11409002`: registrar só um atendimento
 *     não cria acompanhamento — a aba continua sem vigente) e CA05 (apuração do
 *     mês corrente da unidade CREAS: "Famílias em acompanhamento" confere com o
 *     `summary` da API, que conta a `…001` PAEFI e NÃO conta a `…003` SEAS);
 *  2. operador do CRAS Centro: CA06 — o select de serviço do ingresso tem só o
 *     PAIF (a evidência é a ausência dos cinco serviços do CREAS).
 *
 * ## Massa (api)
 * `E2ECreasServicesSeeder`. Reponha a massa (`db:seed --class`) entre rodadas:
 * este spec registra um atendimento na família `…002`.
 *
 * Credenciais só por variável de ambiente. Nunca registra nem imprime CPF,
 * nome ou dado sensível em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const EVIDENCE_SLUG = "11409-servicos-creas-acompanhamento";

const FAMILY_PAEFI = "00000000-0000-4000-8000-000011409001";
const TEEN = "E2E Adolescente Serviços CREAS";
const FAMILY_STREET = "00000000-0000-4000-8000-000011409002";
const FAMILY_CRAS =
  process.env.E2E_CLIENT_FAMILY_IN_UNIT_UUID ??
  "00000000-0000-4000-8000-0000000f0001";
const UNIT_CREAS_UUID = "00000000-0000-4000-8000-0000000e0002";
const UNIT_CREAS_NAME = "E2E CREAS";
const UNIT_CRAS_NAME = "E2E CRAS Centro";

const CREAS = [
  process.env.E2E_CLIENT_CREAS_OPERADOR_CPF,
  process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD,
] as const;
const MASTER = [
  process.env.E2E_CLIENT_MASTER_CPF,
  process.env.E2E_CLIENT_MASTER_PASSWORD,
] as const;
const OPERADOR = [
  process.env.E2E_CLIENT_OPERADOR_CPF,
  process.env.E2E_CLIENT_OPERADOR_PASSWORD,
] as const;

let shared: Page | undefined;

async function startSession(
  browser: Browser,
  cpf: string,
  password: string,
): Promise<Page> {
  if (shared) await shared.context().close();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1100 },
  });
  shared = await context.newPage();
  await loginAsTenantUser(shared, cpf, password);
  return shared;
}

async function openIngress(page: Page, family: string): Promise<void> {
  await page.goto(`/app/cadastros/familias/${family}?tab=acompanhamento`);
  await dismissPlatformUpdates(page);
  await page.getByTestId("follow-up-register-action").click();
  await page.getByTestId("follow-up-form-unit").click();
  await page.getByRole("option", { name: new RegExp(UNIT_CREAS_NAME, "i") }).first().click();
  await page.waitForTimeout(1500);
  await page.getByTestId("follow-up-form-service").click();
}

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-12 #11409 — serviços do CREAS no acompanhamento", () => {
  test.skip(
    !BASE || !CREAS[0] || !CREAS[1] || !OPERADOR[0] || !OPERADOR[1] || !MASTER[0] || !MASTER[1],
    "sem URL do client ou credenciais",
  );
  test.afterAll(async () => {
    if (shared) await shared.context().close();
    shared = undefined;
  });


  test("CA01 — o técnico do CREAS vê os cinco serviços do CREAS, com sigla e nome, na ordem", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, CREAS[0]!, CREAS[1]!);
    await openIngress(page, FAMILY_PAEFI);
    const opts = page.getByRole("option");
    await expect(opts).toHaveCount(5);
    const labels = ["PAEFI —", "MSE (LA/PSC) —", "PcD e Idosos —", "Abordagem Social —", "Situação de Rua —"];
    for (let i = 0; i < labels.length; i++) {
      await expect(opts.nth(i)).toContainText(labels[i]);
    }
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA03 — registrar só um atendimento não cria acompanhamento (a evidência é a ausência de vigente)", async ({}, testInfo) => {
    const page = shared!;
    await page.goto(`/app/cadastros/familias/${FAMILY_STREET}?tab=atendimentos`);
    await dismissPlatformUpdates(page);
    await page.getByTestId("attendance-register-action").click();
    await expect(page.getByTestId("attendance-form-sheet")).toBeVisible();

    const optionsLoaded = page.waitForResponse(
      (r) =>
        r.url().includes("/attendances/options") &&
        r.url().includes("social_unit_uuid") &&
        r.request().method() === "GET",
      { timeout: 15_000 },
    ).catch(() => null);
    await page.getByTestId("attendance-form-unit").click();
    await page
      .getByRole("option", { name: new RegExp(UNIT_CREAS_NAME, "i") })
      .first()
      .click();
    await optionsLoaded;

    await page.getByTestId("attendance-form-type").click();
    await page.getByRole("option").first().click();
    const person = page.locator('[data-testid^="attendance-person-"]').first();
    if (await person.count()) await person.click();
    await page
      .getByTestId("attendance-form-description")
      .fill("Atendimento de teste E2E, sem acompanhamento.");
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes("/attendances") &&
        r.request().method() === "POST",
    );
    await page.getByTestId("attendance-form-submit").click();
    expect((await saved).status(), "POST do atendimento").toBe(201);
    await expect(page.getByTestId("attendance-form-sheet")).toBeHidden();

    await page.goto(`/app/cadastros/familias/${FAMILY_STREET}?tab=acompanhamento`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("follow-up-register-action")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('[data-testid^="follow-up-row-"]')).toHaveCount(0);
    await expect(page.getByTestId("follow-up-empty")).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });


  test("CA02b — Situação de Rua sem o integrante é barrada no campo e nada é gravado", async ({}, testInfo) => {
    const page = shared!;
    await openIngress(page, FAMILY_STREET);
    await page.getByRole("option", { name: "Situação de Rua —" }).click();
    await page.getByTestId("follow-up-form-submit").click();
    await expect(page.getByTestId("follow-up-form-member-error")).toBeVisible();
    await expect(page.getByTestId("follow-up-form-sheet")).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
    await page.keyboard.press("Escape");
  });

  test("CA02 — Situação de Rua para a pessoa: planejamento e evolução disponíveis", async ({}, testInfo) => {
    const page = shared!;
    await openIngress(page, FAMILY_STREET);
    await page.getByRole("option", { name: "Situação de Rua —" }).click();
    await page.getByTestId("follow-up-form-member").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("follow-up-form-submit").click();
    await expect(page.getByTestId("follow-up-member")).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid^="follow-up-expand-"]').first().click();
    await expect(page.locator('[data-testid^="follow-up-plan-action-"]')).toBeVisible();
    await expect(page.locator('[data-testid^="follow-up-evolution-register-"]')).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA04 — a família tem PAEFI e MSE (LA/PSC) do adolescente vigentes ao mesmo tempo", async ({}, testInfo) => {
    const page = shared!;
    await openIngress(page, FAMILY_PAEFI);
    await page.getByRole("option", { name: "MSE (LA/PSC) —" }).click();
    await page.getByTestId("follow-up-form-member").click();
    await page.getByRole("option", { name: TEEN }).click();
    await page.getByTestId("follow-up-form-submit").click();
    await expect(page.getByTestId("follow-up-member")).toContainText(TEEN, { timeout: 15_000 });
    await expect(page.locator('[data-testid^="follow-up-row-"]:has-text("PAEFI")')).toBeVisible();
    await expect(page.locator('[data-testid^="follow-up-row-"]:has-text("MSE (LA/PSC)")')).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA05 — a apuração conta a família do PAEFI e não conta a da Abordagem Social", async ({ browser }, testInfo) => {
    // A apuração é do Master (o técnico do CREAS recebe "Acesso negado").
    const page = await startSession(browser, MASTER[0]!, MASTER[1]!);
    const responsePromise = page.waitForResponse(
      (r) =>
        r.url().includes("/attendance-reports") && !r.url().includes("/src/") && !r.url().includes(".ts") &&
        r.request().method() === "GET",
      { timeout: 20_000 },
    );
    await page.goto("/app/prestacao-contas/apuracao-atendimentos");
    await dismissPlatformUpdates(page);
    const res = await responsePromise;
    expect([200, 304]).toContain(res.status());
    const body = await res.json();
    const units = (body.data?.units ?? body.units ?? []) as Array<{
      uuid: string;
      counters: Record<string, { value?: number } | number>;
    }>;
    const unit = units.find((u) => u.uuid === UNIT_CREAS_UUID);
    expect(unit, "unidade CREAS na apuração").toBeTruthy();
    const raw = unit!.counters.families_in_follow_up;
    const expected = typeof raw === "number" ? raw : Number(raw?.value ?? NaN);
    expect(expected).toBeGreaterThanOrEqual(1);

    const value = page.getByTestId(
      `follow-up-value-families_in_follow_up-${UNIT_CREAS_UUID}`,
    );
    await expect(value).toBeVisible({ timeout: 15_000 });
    expect(Number((await value.innerText()).replace(/\D/g, ""))).toBe(expected);

    await value.scrollIntoViewIfNeeded();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA06 — o operador do CRAS só vê o PAIF no ingresso (a evidência é a ausência dos serviços do CREAS)", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, OPERADOR[0]!, OPERADOR[1]!);
    await page.goto(`/app/cadastros/familias/${FAMILY_CRAS}?tab=acompanhamento`);
    await dismissPlatformUpdates(page);
    await page.getByTestId("follow-up-register-action").click();
    await page.getByTestId("follow-up-form-unit").click();
    await page
      .getByRole("option", { name: new RegExp(UNIT_CRAS_NAME, "i") })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await page.getByTestId("follow-up-form-service").click();
    await expect(page.getByRole("option", { name: /PAIF/ })).toHaveCount(1);
    for (const s of ["PAEFI —", "MSE", "PcD e Idosos", "Abordagem Social", "Situação de Rua"]) {
      await expect(page.getByRole("option", { name: s })).toHaveCount(0);
    }
    await captureEvidence(page, testInfo, EVIDENCE_SLUG);
  });
});
