import fs from "node:fs";
import path from "node:path";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * HU #11653 — ajustes pontuais da Sprint 28, Partes A (valor do contrato), C (encaminhamentos recebidos),
 * D (faixa em bloco nunca gravado e assinatura depois da correção) e E (diálogo de troca com nome longo), no
 * frontend do TENANT (`client/`). Spec MANUAL, 4 logins em ordem fixa (throttle `6,1`; BR-001 permite até 5):
 *
 *  1. Master: CA12 (diálogo de troca na família …11653302 escolhendo a unidade de nome longo, em 1366×768 e 390×844;
 *     NÃO confirma a troca);
 *  2. técnico do CREAS (add-on LGPD): CA05 (Recebidos: três linhas em 03/10, 10/10, 17/10), CA07 (o encaminhamento
 *     …114, com destino em texto livre, não aparece), CA06 (retorno na linha da primeira);
 *  3. técnico do CRAS (Centro, Operacional): CA01/CA02 (edita a entidade …11653003: 120000 e 1500,50), CA03 (detalhe
 *     de …001 "R$ 0,00" e de …002 "Não informado"), CA03b (apaga e tenta salvar), CA06 (Enviados sem o
 *     encaminhamento …111), CA10 (faixa na convivência de …201) e CA11 (bloco de educação de …202: "Registrado em
 *     05/11/2026" e "Corrigido por … em 12/11/2026"). A edição de entidade é do Operacional: o Master não tem
 *     `social-entities.update` (a tela devolve 403 "Editar");
 *  4. técnico sem add-on: CA08 (Recebidos ⇒ negativa SEM nome de unidade).
 * CA09 (isolamento) é provado pelo Pest `PendingReferralsReceivedIsolationTest` (apêndice do dossiê).
 *
 * Massa: `E2EAdjustments11653Seeder` (reaplique antes de cada rodada: a spec grava o valor da entidade …003 e o
 * retorno do …111). Credenciais só do ambiente; nenhum CPF, senha ou nome real é gravado aqui.
 * Com CAPTURE_EVIDENCE=1 grava um print por CA em `e2e/reports/11653-…-acceptance/screenshots/` (raiz do meta).
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const ENTITY_ZERO = "00000000-0000-4000-8000-000011653001";
const ENTITY_NULL = "00000000-0000-4000-8000-000011653002";
const ENTITY_EDIT = "00000000-0000-4000-8000-000011653003";
const REFERRALS = [
  "00000000-0000-4000-8000-000011653111",
  "00000000-0000-4000-8000-000011653112",
  "00000000-0000-4000-8000-000011653113",
];
const REFERRAL_EXTERNAL = "00000000-0000-4000-8000-000011653114";
const FAMILY_NO_LIVING = "00000000-0000-4000-8000-000011653201";
const FAMILY_CORRECTED = "00000000-0000-4000-8000-000011653202";
const FAMILY_SWAP = "00000000-0000-4000-8000-000011653302";
const LONG_UNIT_START = "Centro de Referência de Assistência Social Unidade";
const PENDING = "/app/cadastros/encaminhamentos-pendentes";

const SHOTS = path.resolve(
  __dirname,
  "../../../../e2e/reports/11653-ajustes-pontuais-contrato-idioma-recebidos-acceptance/screenshots",
);

let contexts: BrowserContext[] = [];

test.use({ baseURL: BASE, viewport: { width: 1440, height: 1000 } });
test.describe.configure({ mode: "serial" });

function credential(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Defina ${name} no ambiente do E2E.`);
  return value;
}

async function shot(page: Page, name: string, focus?: Locator): Promise<void> {
  if (process.env.CAPTURE_EVIDENCE !== "1") return;
  await fs.promises.mkdir(SHOTS, { recursive: true });
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function loginAs(
  browser: import("@playwright/test").Browser,
  prefix: string,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 1000 },
  });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto("/auth/login");
  await loginAsTenantUser(
    page,
    credential(`E2E_CLIENT_${prefix}_CPF`),
    credential(`E2E_CLIENT_${prefix}_PASSWORD`),
    { tenantUuid: TENANT_UUID },
  );
  await dismissPlatformUpdates(page);
  await expect(page).toHaveURL(/\/app/);
  return page;
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await dismissPlatformUpdates(page);
}

/** Valor da linha "Valor do Vínculo" do detalhe da entidade. */
function contractValue(page: Page): Locator {
  return page.locator("dt", { hasText: "Valor do Vínculo" }).locator("xpath=following-sibling::dd[1]");
}

async function saveContract(page: Page, typed: string): Promise<void> {
  await open(page, `/app/entidades/${ENTITY_EDIT}/editar`);
  const field = page.locator("#se-contract-amount");
  await expect(field).toBeVisible({ timeout: 20_000 });
  await field.fill(typed);
  await field.blur();
  await page.locator('form button[type="submit"]').last().click();
  await page.waitForTimeout(3000);
  const problems = await page
    .locator('[data-sonner-toast], p.text-destructive')
    .allInnerTexts();
  expect(page.url(), `salvar não saiu da edição: ${problems.join(" | ")}`).not.toMatch(/\/editar/);
}

test.afterAll(async () => {
  for (const context of contexts) await context.close();
});

test.describe("HU #11653 — Partes A, C, D e E (client)", () => {
  let master: Page;
  let creas: Page;
  let cras: Page;
  let noAddon: Page;

  for (const viewport of [
    { width: 1366, height: 768, tag: "1366" },
    { width: 390, height: 844, tag: "390" },
  ]) {
    test(`CA12 — diálogo de troca com nome longo dentro da caixa (${viewport.tag}×${viewport.height}), sem confirmar`, async ({ browser }) => {
      master ??= await loginAs(browser, "MASTER");
      await master.setViewportSize({ width: viewport.width, height: viewport.height });
      await open(master, `/app/cadastros/familias/${FAMILY_SWAP}`);
      await expect(master.getByTestId("family-change-unit")).toBeVisible({ timeout: 20_000 });
      await master.getByTestId("family-change-unit").click();
      const dialog = master.getByTestId("change-reference-unit-dialog");
      await expect(dialog).toBeVisible();
      await master.getByTestId("change-unit-trigger").click();
      await master
        .getByRole("option", { name: new RegExp(LONG_UNIT_START, "i") })
        .first()
        .click();
      await master.getByTestId("change-submit").click();
      // 1º clique NÃO grava: devolve o aviso, e a ação vira "confirmar a troca". Nenhum 2º clique.
      await expect(master.getByTestId("change-submit")).toContainText(/confirmar a troca/i, {
        timeout: 20_000,
      });
      await expect(master.getByTestId("change-previous-unit-warning")).toBeVisible();

      for (const id of [
        "change-current-unit",
        "change-unit-trigger",
        "change-previous-unit-warning",
        "change-submit",
      ]) {
        const el = master.getByTestId(id);
        await el.scrollIntoViewIfNeeded();
        const inner = await el.boundingBox();
        const outer = await dialog.boundingBox();
        expect(inner, `${id} com caixa`).not.toBeNull();
        expect(outer, "diálogo com caixa").not.toBeNull();
        const tol = 1;
        expect(inner!.x, `${id}: esquerda`).toBeGreaterThanOrEqual(outer!.x - tol);
        expect(inner!.x + inner!.width, `${id}: direita`).toBeLessThanOrEqual(outer!.x + outer!.width + tol);
        expect(inner!.y, `${id}: topo`).toBeGreaterThanOrEqual(outer!.y - tol);
        expect(inner!.y + inner!.height, `${id}: base`).toBeLessThanOrEqual(outer!.y + outer!.height + tol);
      }
      await shot(master, `CA12-dialogo-nome-longo-${viewport.tag}`);

      await master.getByRole("button", { name: "Cancelar" }).click();
      await expect(dialog).toHaveCount(0);
    });
  }

  test("login 2 — técnico do CREAS: CA05 Recebidos em 03/10, 10/10 e 17/10; CA07 o texto livre não aparece", async ({
    browser,
  }) => {
    creas = await loginAs(browser, "CREAS_OPERADOR");
    await open(creas, `${PENDING}?view=received`);
    await expect(creas.getByTestId("pending-referrals-tab-received")).toBeVisible({ timeout: 20_000 });
    const rows = creas.locator('[data-testid^="pending-referral-row-"]');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    for (const uuid of REFERRALS) {
      await expect(creas.getByTestId(`pending-referral-row-${uuid}`)).toBeVisible();
    }
    // Ordem: do mais antigo para o mais novo (03/10, 10/10, 17/10).
    const ids = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid") ?? ""),
    );
    const mine = ids.filter((id) => REFERRALS.some((u) => id.endsWith(u)));
    expect(mine.map((id) => id.slice(-4))).toEqual(["3111", "3112", "3113"]);
    const texts = await Promise.all(REFERRALS.map((u) => creas.getByTestId(`pending-referral-row-${u}`).innerText()));
    expect(texts[0]).toContain("03/10/2026");
    expect(texts[1]).toContain("10/10/2026");
    expect(texts[2]).toContain("17/10/2026");
    await shot(creas, "CA05-recebidos-tres-linhas");

    // CA07: prova de ausência — a evidência é o encaminhamento …114 NÃO estar na lista.
    await expect(creas.getByTestId(`pending-referral-row-${REFERRAL_EXTERNAL}`)).toHaveCount(0);
    await shot(creas, "CA07-texto-livre-ausente");
  });

  test("CA06 — retorno direto da linha: a primeira some de Recebidos", async () => {
    const row = creas.getByTestId(`pending-referral-row-${REFERRALS[0]}`);
    await expect(row).toBeVisible();
    await creas.getByTestId(`pending-referral-return-${REFERRALS[0]}`).click();
    await creas.getByTestId("counter-reference-note").fill("Retorno E2E #11653: família atendida.");
    await creas.getByTestId("counter-reference-outcome").click();
    await creas
      .locator('[role="option"]:has-text("Atendido"):not(:has-text("Não"))')
      .click();
    await creas.getByTestId("register-counter-reference-confirm").click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await expect(creas.getByTestId(`pending-referral-row-${REFERRALS[1]}`)).toBeVisible();
    await expect(creas.getByTestId(`pending-referral-row-${REFERRALS[2]}`)).toBeVisible();
    await shot(creas, "CA06-recebidos-sem-a-primeira");
  });

  test("login 3 — técnico do CRAS (Operacional): abre a sessão", async ({ browser }) => {
    cras ??= await loginAs(browser, "OPERADOR");
  });

  test("CA01 — valor inteiro (120000 ⇒ R$ 120.000,00)", async ({ browser }) => {
    cras ??= await loginAs(browser, "OPERADOR");
    await saveContract(cras, "120000");
    await open(cras, `/app/entidades/${ENTITY_EDIT}`);
    await expect(contractValue(cras)).toHaveText("R$ 120.000,00", { timeout: 20_000 });
    await shot(cras, "CA01-valor-inteiro", contractValue(cras));
  });

  test("CA02 — valor com centavos (1500,50 ⇒ R$ 1.500,50)", async () => {
    await saveContract(cras, "1500,50");
    await open(cras, `/app/entidades/${ENTITY_EDIT}`);
    await expect(contractValue(cras)).toHaveText("R$ 1.500,50", { timeout: 20_000 });
    await shot(cras, "CA02-valor-com-centavos", contractValue(cras));
  });

  test("CA03 — zero mostra R$ 0,00 e vazio mostra 'Não informado'", async () => {
    await open(cras, `/app/entidades/${ENTITY_ZERO}`);
    await expect(contractValue(cras)).toHaveText("R$ 0,00", { timeout: 20_000 });
    await shot(cras, "CA03-valor-zero", contractValue(cras));

    await open(cras, `/app/entidades/${ENTITY_NULL}`);
    await expect(contractValue(cras)).toHaveText("Não informado", { timeout: 20_000 });
    await shot(cras, "CA03-valor-nao-informado", contractValue(cras));
  });

  test("CA03b — apagar o valor e salvar: o formulário não envia e explica", async () => {
    await open(cras, `/app/entidades/${ENTITY_EDIT}/editar`);
    const field = page_field(cras);
    await expect(field).toBeVisible({ timeout: 20_000 });
    await field.fill("");
    await field.blur();
    await cras.locator('form button[type="submit"]').last().click();
    const message = cras.getByText(
      "Informe o valor do vínculo. Use R$ 0,00 quando não houver valor.",
    );
    await expect(message).toBeVisible({ timeout: 10_000 });
    await expect(cras).toHaveURL(/\/editar/);
    await shot(cras, "CA03b-vazio-nao-vira-zero", message);
  });

  test("CA06 — Enviados do CRAS não tem mais a primeira família; CA10 faixa; CA11 assinatura da correção", async () => {
    await open(cras, `${PENDING}?view=sent`);
    await expect(cras.getByTestId(`pending-referral-row-${REFERRALS[1]}`)).toBeVisible({ timeout: 20_000 });
    await expect(cras.getByTestId(`pending-referral-row-${REFERRALS[2]}`)).toBeVisible();
    await expect(cras.getByTestId(`pending-referral-row-${REFERRALS[0]}`)).toHaveCount(0);
    await shot(cras, "CA06-enviados-sem-a-primeira");

    await open(cras, `/app/cadastros/familias/${FAMILY_NO_LIVING}?tab=convivencia`);
    const band = cras.getByTestId("community-living-pending");
    await expect(band).toBeVisible({ timeout: 20_000 });
    await expect(band).toContainText("Perguntas ainda sem resposta");
    await shot(cras, "CA10-faixa-bloco-nunca-gravado", band);

    await open(cras, `/app/cadastros/familias/${FAMILY_CORRECTED}?tab=composicao`);
    await cras.getByTestId("member-series-tab-education_conditions").click({ timeout: 20_000 });
    const panel = cras.getByTestId("member-series-panel-education_conditions");
    await expect(panel).toBeVisible();
    const column = panel.locator('[data-testid^="member-series-column-"]').first();
    await expect(column).toBeVisible();
    // Registro o que a tela mostra para o relatório (CA11, H-D1).
    console.log("CA11 assinatura mostra: " + (await column.innerText()).replace(/\s+/g, " | "));
    await expect(column).toContainText("Registrado em 05/11/2026");
    await expect(column).toContainText(/Corrigido por .+ em 12\/11\/2026/);
    await shot(cras, "CA11-assinatura-registro-e-correcao", panel);
  });

  test("login 4 — técnico sem add-on: CA08 Recebidos ⇒ negativa sem nome de unidade", async ({ browser }) => {
    noAddon = await loginAs(browser, "NO_ADDON");
    await open(noAddon, `${PENDING}?view=received`);
    const denied = noAddon.getByTestId("pending-referrals-denied");
    await expect(denied).toBeVisible({ timeout: 20_000 });
    const text = await denied.innerText();
    expect(text).not.toMatch(/E2E CRAS|E2E CREAS|Centro de Referência/i);
    await expect(noAddon.locator('[data-testid^="pending-referral-row-"]')).toHaveCount(0);
    // CA08: a evidência é a negativa SEM nome de unidade (e nenhuma linha).
    await shot(noAddon, "CA08-negativa-sem-unidade");
  });
});

function page_field(page: Page): Locator {
  return page.locator("#se-contract-amount");
}
