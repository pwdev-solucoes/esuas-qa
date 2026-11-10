import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-14 (HU #11549) — incluir no painel a pessoa já conhecida pelo município.
 * Spec MANUAL multiusuário. O E2E-055 cobre CA01 e CA06 de forma declarativa; aqui
 * eles reaparecem só para gerar o print do dossiê (mesma massa, mesmo login).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: 2 logins, sequenciais — Q9 permite 3)
 *  1. técnico de UMA unidade (operador do CREAS): CA01, CA06, CA02, CA04, CA03, CA05,
 *     CA07 (prova de ausência), CA08 (CPF mascarado no Resumo) e CA09 (sem "Trocar unidade");
 *  2. Master: CA10 ("Trocar unidade" visível).
 *
 * ## Massa (api) — `E2EKnownPersonInclusionSeeder`
 * Famílias `…11549001..005`; o seeder desfaz as inclusões da rodada anterior. Rode-o
 * de novo antes de repetir esta spec. O operador do CRAS Centro tem DUAS lotações e por
 * isso não serve ao CA09: usa-se o do CREAS (uma só).
 *
 * Credenciais e CPFs só por variável de ambiente. Nunca registra CPF nem dado pessoal.
 */

const BASE = process.env.CLIENT_BASE_URL;
const EVIDENCE_SLUG = "11549-familia-incluir-pessoa-conhecida";

const TECNICO = [
  process.env.E2E_CLIENT_CREAS_OPERADOR_CPF,
  process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD,
] as const;
const MASTER = [
  process.env.E2E_CLIENT_MASTER_CPF,
  process.env.E2E_CLIENT_MASTER_PASSWORD,
] as const;

const CPF_UNLINKED = process.env.E2E_CLIENT_PERSON_UNLINKED_CPF;
const CPF_OTHER_FAMILY = process.env.E2E_CLIENT_PERSON_OTHER_FAMILY_CPF;
const CPF_OTHER_UNIT = process.env.E2E_11549_PERSON_OTHER_UNIT_CPF;
const CPF_TENANT_FREE = process.env.E2E_11549_PERSON_TENANT_FREE_CPF;
const CPF_OUTSIDE = process.env.E2E_11549_PERSON_OUTSIDE_CPF;
const CPF_OUTSIDE_SEARCH = process.env.E2E_11549_PERSON_OUTSIDE_SEARCH_CPF;
// Datas fictícias da massa (a certa é a do seeder; a errada nunca coincide com ela).
const OUTSIDE_BIRTH = process.env.E2E_11549_PERSON_OUTSIDE_BIRTH_DATE ?? "1990-03-15";
const WRONG_BIRTH = "1991-04-16";

const F2 = "00000000-0000-4000-8000-000011549002";
const F5 = "00000000-0000-4000-8000-000011549005";
const F5_RECORD_NUMBER = "E2E-11549-005";

// Nomes fictícios da massa.
const NAME_P = "E2E 11549 Pessoa Desvinculada";
const NAME_Q = "E2E 11549 Pessoa Cadastrada Sem Família";
const NAME_R = "E2E 11549 Pessoa De Outro Município";
const NAME_R2 = "E2E 11549 Pessoa De Outro Município Pesquisa";

let shared: Page | undefined;

async function startSession(browser: Browser, cpf: string, password: string): Promise<Page> {
  if (shared) await shared.context().close();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1100 },
  });
  shared = await context.newPage();
  await loginAsTenantUser(shared, cpf, password);
  await dismissPlatformUpdates(shared);
  return shared;
}

async function openDrawer(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${F2}?tab=composicao`);
  await dismissPlatformUpdates(page);
  await page.getByRole("button", { name: "Incluir integrante" }).click();
  await expect(page.getByTestId("add-member-drawer")).toBeVisible({ timeout: 15_000 });
}

async function searchCpf(page: Page, cpf: string): Promise<void> {
  await page.getByTestId("add-member-cpf-input").fill(cpf);
  await page.getByTestId("add-member-cpf-submit").click();
}

async function pickFirstKinship(page: Page): Promise<void> {
  await page.getByTestId("add-member-kinship-trigger").click();
  await page.locator('[role="option"]').first().click();
  // O print só sai com a lista fechada e o parentesco gravado no campo.
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByTestId("add-member-kinship-trigger")).not.toContainText(/Selecione/);
}

/**
 * Redação do print: o CPF digitado vira bolinhas e os CPFs listados na composição viram
 * máscara (a massa é fictícia, mas o dossiê não mostra CPF). O CA08 mantém o CPF da
 * referência no Resumo, porque é justamente o que ele prova.
 */
async function redactCpfs(page: Page, keepListedCpf: boolean): Promise<void> {
  await page.evaluate((keep) => {
    document
      .querySelectorAll<HTMLInputElement>('[data-testid="add-member-cpf-input"], #person-search-cpf')
      .forEach((el) => (el.type = "password"));
    if (keep) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      node.textContent = (node.textContent ?? "").replace(/\d{3}\.\d{3}\.\d{3}-\d{2}/g, "***.***.***-**");
    }
  }, keepListedCpf);
}

async function evidence(
  page: Page,
  testInfo: Parameters<typeof captureEvidence>[1],
  suffix?: string,
  keepListedCpf = false,
): Promise<void> {
  await redactCpfs(page, keepListedCpf);
  await captureEvidence(page, testInfo, EVIDENCE_SLUG, suffix);
}

test.describe.configure({ mode: "serial" });

test.describe("US-AJ-14 #11549 — incluir pessoa conhecida pelo município", () => {
  test.skip(
    !BASE ||
      !TECNICO[0] || !TECNICO[1] || !MASTER[0] || !MASTER[1] ||
      !CPF_UNLINKED || !CPF_OTHER_FAMILY || !CPF_OTHER_UNIT || !CPF_TENANT_FREE ||
      !CPF_OUTSIDE || !CPF_OUTSIDE_SEARCH,
    "sem URL do client, credenciais ou CPFs da massa",
  );
  test.afterAll(async () => {
    if (shared) await shared.context().close();
    shared = undefined;
  });

  test("CA01 — pessoa desvinculada entra em família fora do CadÚnico sem 2º dado nem código familiar", async ({
    browser,
  }, testInfo) => {
    const page = await startSession(browser, TECNICO[0]!, TECNICO[1]!);
    await openDrawer(page);
    await searchCpf(page, CPF_UNLINKED!);
    await expect(page.getByTestId("add-member-known-hint")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("add-member-identity")).toHaveCount(0);
    await pickFirstKinship(page);
    await evidence(page, testInfo);
    await page.getByTestId("add-member-submit").click();
    await expect(page.getByTestId("add-member-drawer")).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(NAME_P).first()).toBeVisible({ timeout: 15_000 });
    await evidence(page, testInfo, "incluida");
  });

  test("CA06 — pessoa ativa em outra família: aviso antes do clique, com o número do prontuário", async ({}, testInfo) => {
    const page = shared!;
    await openDrawer(page);
    await searchCpf(page, CPF_OTHER_FAMILY!);
    await expect(page.getByTestId("add-member-conflict-notice")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("add-member-conflict-family")).toBeVisible();
    await expect(page.getByTestId("add-member-conflict-open-family")).toBeVisible();
    await expect(page.getByTestId("add-member-submit")).toBeDisabled();
    await expect(page.getByRole("button", { name: /desvincular/i })).toHaveCount(0);
    await evidence(page, testInfo);
  });

  test("CA02 — pessoa cadastrada pelo município sem família é incluída sem confirmação de identidade", async ({}, testInfo) => {
    const page = shared!;
    await openDrawer(page);
    await searchCpf(page, CPF_TENANT_FREE!);
    await expect(page.getByTestId("add-member-known-hint")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("add-member-identity")).toHaveCount(0);
    await pickFirstKinship(page);
    await evidence(page, testInfo);
    await page.getByTestId("add-member-submit").click();
    await expect(page.getByTestId("add-member-drawer")).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(NAME_Q).first()).toBeVisible({ timeout: 15_000 });
    await evidence(page, testInfo, "incluida");
  });

  test("CA04 — confirmação que não coincide não inclui e não revela a data correta", async ({}, testInfo) => {
    const page = shared!;
    await openDrawer(page);
    await searchCpf(page, CPF_OUTSIDE!);
    await expect(page.getByTestId("add-member-identity")).toBeVisible({ timeout: 15_000 });
    await pickFirstKinship(page);
    await page.getByTestId("add-member-confirm-value").fill(WRONG_BIRTH);
    await page.getByTestId("add-member-confirm-submit").click();
    await expect(page.getByTestId("add-member-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("add-member-drawer")).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain(OUTSIDE_BIRTH);
    expect(html).not.toContain(OUTSIDE_BIRTH.split("-").reverse().join("/"));
    expect(html).not.toContain(NAME_R);
    await evidence(page, testInfo);
  });

  test("CA03 — pessoa de outro município confirma a identidade no painel e é incluída com o parentesco", async ({}, testInfo) => {
    const page = shared!;
    await openDrawer(page);
    await searchCpf(page, CPF_OUTSIDE!);
    await expect(page.getByTestId("add-member-identity")).toBeVisible({ timeout: 15_000 });
    await pickFirstKinship(page);
    await page.getByTestId("add-member-confirm-value").fill(OUTSIDE_BIRTH);
    await evidence(page, testInfo);
    await page.getByTestId("add-member-confirm-submit").click();
    await expect(page.getByTestId("add-member-drawer")).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(NAME_R).first()).toBeVisible({ timeout: 15_000 });
    await evidence(page, testInfo, "incluida");
  });

  test("CA05 — vincular pela Pesquisa de Pessoas informando o número do prontuário da família", async ({}, testInfo) => {
    const page = shared!;
    await page.goto("/app/cadastros/pesquisa-pessoas");
    await dismissPlatformUpdates(page);
    await page.locator("#person-search-cpf").fill(CPF_OUTSIDE_SEARCH!);
    await page.getByRole("button", { name: /pesquisar/i }).click();
    await page.getByTestId("global-person-link").click();
    await expect(page.getByTestId("confirm-family-mode-record-number")).toBeChecked();
    await page.locator("#confirm-family-code").fill(F5_RECORD_NUMBER);
    await page.getByTestId("confirm-locate-family").click();
    await expect(page.getByTestId("confirm-family-found")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("confirm-value").fill(OUTSIDE_BIRTH);
    await evidence(page, testInfo);
    await page.getByTestId("confirm-identity-submit").click();
    await expect(page.getByTestId("confirm-identity-dialog")).toHaveCount(0, { timeout: 15_000 });
    await page.goto(`/app/cadastros/familias/${F5}?tab=composicao`);
    await expect(page.getByText(NAME_R2).first()).toBeVisible({ timeout: 15_000 });
    await evidence(page, testInfo, "incluida");
  });

  test("CA07 — pessoa de família que o técnico não acessa: aviso genérico, sem número, nome nem unidade (a evidência é a ausência)", async ({}, testInfo) => {
    const page = shared!;
    await openDrawer(page);
    await searchCpf(page, CPF_OTHER_UNIT!);
    await expect(page.getByTestId("add-member-conflict-notice")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("add-member-conflict-generic")).toBeVisible();
    await expect(page.getByTestId("add-member-conflict-family")).toHaveCount(0);
    await expect(page.getByTestId("add-member-conflict-open-family")).toHaveCount(0);
    await expect(page.getByTestId("add-member-submit")).toBeDisabled();
    // A prova é sobre o HTML inteiro: nada de número do prontuário, nome da pessoa ou unidade.
    const html = await page.content();
    expect(html).not.toContain("E2E-11549-004");
    expect(html).not.toContain("Pessoa Em Unidade Fechada");
    expect(html).not.toContain("00000000-0000-4000-8000-000011549004");
    expect(html).not.toMatch(/E2E CRAS Centro/);
    await evidence(page, testInfo);
  });

  test("CA08 — o Resumo mostra o CPF da referência (mascarado como hoje) em família sem CPF importado", async ({}, testInfo) => {
    const page = shared!;
    await page.goto(`/app/cadastros/familias/${F2}?tab=resumo`);
    await dismissPlatformUpdates(page);
    const bloco = page.getByTestId("summary-responsible");
    await expect(bloco).toBeVisible({ timeout: 15_000 });
    await expect(bloco).toContainText(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    await evidence(page, testInfo, undefined, true);
  });

  test("CA09 — técnico de uma só unidade não vê o botão Trocar unidade (a evidência é a ausência)", async ({}, testInfo) => {
    const page = shared!;
    await page.goto(`/app/cadastros/familias/${F2}`);
    await dismissPlatformUpdates(page);
    const capa = page.getByTestId("family-record-cover");
    await expect(capa).toBeVisible({ timeout: 15_000 });
    await expect(capa.getByTestId("family-reference-unit")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("family-change-unit")).toHaveCount(0);
    await evidence(page, testInfo);
  });

  test("CA10 — o Master continua vendo o botão Trocar unidade", async ({ browser }, testInfo) => {
    const page = await startSession(browser, MASTER[0]!, MASTER[1]!);
    await page.goto(`/app/cadastros/familias/${F2}`);
    await dismissPlatformUpdates(page);
    const capa = page.getByTestId("family-record-cover");
    await expect(capa).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("family-change-unit")).toBeVisible({ timeout: 15_000 });
    await evidence(page, testInfo);
  });
});
