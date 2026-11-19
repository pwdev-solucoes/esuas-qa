import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * HU #11651 — a anotação segue a regra do bloco; o Master desliga e avalia; o técnico só avalia na unidade
 * que acompanha. Spec MANUAL, 4 logins (⚠️ `throttle:6,1`), serial, com a massa reposta entre os logins:
 *  1. Master sem lotação técnica: CA01 (saúde sem anotar — a evidência é a ausência), CA14 (Convivência),
 *     CA12 (saúde do integrante), CA13 (medidas), CA05 (desliga o PAEFI), CA06 (avalia o PAIF), CA09 (corrige);
 *  2. técnico do CRAS Centro: CA03 (Quadro 3 sem anotar), CA07 (lê, não avalia), CA10 (por fora da tela, 403),
 *     CA16 (sem "Trocar unidade"), CA17 (sem acesso);
 *  3. técnico do CREAS: CA02 (nota antiga do Master), CA11 (aviso), CA08 (avalia), CA18 (retorno), CA04 (registra o retorno);
 *  4. técnico do CRAS Centro de novo: CA04 (volta a anotar).
 * O E2E-063 roda SEPARADO, antes. CA15 e CA19 ficam em `anotacao-regra-bloco-11651-acesso.spec.ts`.
 * Massa: `E2ENoteFollowsBlockSeeder` (reposta pelo container a cada login). Nunca imprime CPF, nome ou texto de nota.
 */

const BASE = process.env.CLIENT_BASE_URL ?? "http://localhost:5174";
const API = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID = process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const API_CONTAINER = process.env.E2E_API_CONTAINER ?? "api-laravel.test-1";
const REPORT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "e2e", "reports", "11651-anotacao-regra-bloco-master-troca-unidade-acceptance");
const SHOTS = path.join(REPORT_DIR, "screenshots");

const F = (n: string) => `00000000-0000-4000-8000-000011651${n}`;
const F1 = F("001"), F2 = F("002"), F3 = F("003"), F5 = F("005"), F6 = F("006"), F7 = F("007"), F8 = F("008"), F10 = F("010");
const FU_PAEFI_F2 = F("f02"), FU_PAIF_F3 = F("f03"), FU_PAEFI_F8 = F("f08"), FU_PAEFI_F10 = F("f10");
const REFERRAL_F1 = F("e01");

const OPERADOR = { cpf: process.env.E2E_CLIENT_OPERADOR_CPF ?? "", password: process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? "" };
const CREAS = { cpf: process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "", password: process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "" };
const MASTER = { cpf: process.env.E2E_CLIENT_MASTER_CPF ?? "", password: process.env.E2E_CLIENT_MASTER_PASSWORD ?? "" };

function reseed(): void {
  try {
    execFileSync("docker", ["exec", API_CONTAINER, "php", "artisan", "db:seed", "--class=Database\\Seeders\\E2ENoteFollowsBlockSeeder", "--force"], { stdio: "ignore", timeout: 120_000 });
  } catch {
    console.warn("[11651] não foi possível repor a massa pelo container; rode o E2ENoteFollowsBlockSeeder.");
  }
}

async function login(page: Page, who: { cpf: string; password: string }) {
  await loginAsTenantUser(page, who.cpf, who.password, { tenantUuid: TENANT_UUID });
  await dismissPlatformUpdates(page);
}

async function openTab(page: Page, family: string, tab: string) {
  await page.goto(`/app/cadastros/familias/${family}?tab=${tab}`);
  await dismissPlatformUpdates(page);
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Requisição "por fora da tela", com a sessão da página (cookie + XSRF), sem imprimir o corpo. */
async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  return page.evaluate(
    async ({ api, tenant, method, url, body }) => {
      const xsrf = decodeURIComponent(document.cookie.split("; ").find((c) => c.startsWith("XSRF-TOKEN="))?.split("=")[1] ?? "");
      const res = await fetch(`${api}/api/client/${url}`, {
        method,
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", "X-XSRF-TOKEN": xsrf, "X-Tenant-UUID": tenant },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
    { api: API, tenant: TENANT_UUID, method, url, body },
  );
}

const EVALUATION_BODY = {
  evaluated_on: new Date().toISOString().slice(0, 10),
  offers_provided: "yes",
  referrals_effective: "not_applicable",
  family_recognizes_service: "yes",
  outcome_classification: "progress",
  achieved_results: "Resultados fictícios do E2E da HU 11651.",
};

async function fillEvaluation(page: Page) {
  const sheet = page.getByTestId("discharge-form-sheet");
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  if (await page.getByTestId("discharge-form-exit-reason").count()) {
    await page.getByTestId("discharge-form-exit-reason").click();
    await page.locator('[role="option"]').first().click();
  }
  await page.getByTestId("discharge-form-answer-offers_provided-yes").check();
  await page.getByTestId("discharge-form-answer-referrals_effective-not_applicable").check();
  await page.getByTestId("discharge-form-answer-family_recognizes_service-yes").check();
  await page.getByTestId("discharge-form-answer-outcome_classification-progress").check();
  await page.getByTestId("discharge-form-achieved-results").fill("Resultados fictícios do E2E da HU 11651.");
}

const denied = (page: Page) =>
  page.getByTestId("family-access-denied").or(page.getByTestId("family-no-active-assignment")).or(page.getByTestId("family-not-found"));

test.describe.configure({ mode: "serial" });

test.describe("HU #11651 — a anotação segue o bloco; Master desliga e avalia; técnico só avalia na unidade que acompanha", () => {
  test.use({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1600 } });
  test.setTimeout(240_000);

  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1600 } });
  });
  test.afterAll(async () => {
    await page?.close();
    reseed();
  });

  test("Master: CA01, CA14, CA12, CA13, CA05, CA06 e CA09", async () => {
    reseed();
    await login(page, MASTER);

    // CA01 — lê a saúde, mas não tem a ação de anotar (a evidência é a ausência).
    await openTab(page, F3, "saude");
    await expect(page.getByTestId("health-denied")).toHaveCount(0);
    await expect(page.locator('[data-testid$="note-shortcut"]:visible')).toHaveCount(0);
    await shot(page, "CA01-saude-sem-atalho-de-anotar");
    await openTab(page, F3, "anotacoes");
    await page.getByTestId("family-note-register-action").click();
    await expect(page.getByTestId("family-note-form-sheet")).toBeVisible();
    await expect(page.getByTestId("family-note-unavailable-blocks")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("family-note-unavailable-health_conditions")).toBeVisible();
    await shot(page, "CA01-formulario-saude-indisponivel");

    // CA14 — Convivência: o Master anota.
    await openTab(page, F3, "convivencia");
    await page.getByTestId("community-living-note-shortcut").click();
    await expect(page.getByTestId("family-note-form-sheet")).toBeVisible();
    if (await page.getByTestId("family-note-unit-select").count()) {
      await page.getByTestId("family-note-unit-select").click();
      await page.getByRole("option", { name: "E2E CRAS Centro", exact: true }).click();
    }
    await page.getByTestId("family-note-content").fill("Anotação fictícia do Master na Convivência (HU 11651).");
    const created = page.waitForResponse((res) => res.url().includes("/notes") && res.request().method() === "POST");
    await page.getByTestId("family-note-submit").click();
    expect((await created).status(), "POST da anotação (Convivência)").toBe(201);
    await openTab(page, F3, "anotacoes");
    await expect(page.getByTestId("family-note-item").filter({ hasText: "Anotação fictícia do Master na Convivência" }).first()).toBeVisible({ timeout: 15_000 });
    await shot(page, "CA14-anotacao-convivencia-gravada");

    // CA12 — saúde do integrante: campos desabilitados, motivo único, salvar desabilitado.
    await openTab(page, F3, "composicao");
    const memberButton = page.locator('tr[data-testid^="member-row-"]:has-text("E2E 11651 Integrante 3") [data-testid^="member-conditions-"]');
    await expect(memberButton).toBeVisible({ timeout: 15_000 });
    await memberButton.click();
    const restricted = page.getByTestId("member-conditions-health_conditions-restricted");
    await expect(restricted).toBeVisible({ timeout: 15_000 });
    await expect(restricted).toContainText("O registro da saúde cabe à equipe técnica.");
    await expect(restricted).toHaveCount(1);
    await expect(page.getByTestId("member-conditions-save")).toBeDisabled();
    await shot(page, "CA12-saude-do-integrante-bloqueada");

    // CA13 — medidas: sem atalho, com o motivo; no formulário geral a referência aparece indisponível.
    await openTab(page, F3, "medidas-socioeducativas");
    await expect(page.getByTestId("measure-register-reason")).toContainText("cabe a técnico do CREAS", { timeout: 15_000 });
    await expect(page.getByTestId("socio-educational-measure-note-shortcut")).toHaveCount(0);
    await shot(page, "CA13-medidas-motivo-sem-atalho");
    await openTab(page, F3, "anotacoes");
    await page.getByTestId("family-note-register-action").click();
    await expect(page.getByTestId("family-note-unavailable-socio_educational_measures")).toBeVisible({ timeout: 15_000 });
    await shot(page, "CA13-formulario-medidas-indisponivel");

    // CA05 — desliga o PAEFI da família 2 (CREAS) com a avaliação de resultados.
    await openTab(page, F2, "acompanhamento");
    await expect(page.getByTestId(`follow-up-card-${FU_PAEFI_F2}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`follow-up-discharge-${FU_PAEFI_F2}`).click();
    await fillEvaluation(page);
    await page.getByTestId("discharge-form-submit").click();
    await expect(page.getByTestId(`follow-up-correct-discharge-${FU_PAEFI_F2}`)).toBeVisible({ timeout: 15_000 });
    await shot(page, "CA05-master-desligou-o-paefi");

    // CA06 — avalia o PAIF da família 3 sem desligar: o PAIF continua vigente (com o botão de desligar).
    await openTab(page, F3, "acompanhamento");
    await expect(page.getByTestId(`follow-up-card-${FU_PAIF_F3}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`follow-up-evaluate-${FU_PAIF_F3}`).click();
    await fillEvaluation(page);
    await page.getByTestId("discharge-form-submit").click();
    await expect(page.getByTestId("discharge-form-sheet")).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId(`follow-up-discharge-${FU_PAIF_F3}`)).toBeVisible();
    await shot(page, "CA06-master-avaliou-o-paif-vigente");

    // CA09 — corrige a data do desligamento (PAEFI da família 10 desligado com a data errada).
    await openTab(page, F10, "acompanhamento");
    await expect(page.getByTestId(`follow-up-card-${FU_PAEFI_F10}`)).toBeVisible({ timeout: 20_000 });
    await shot(page, "CA09-antes-da-correcao");
    await page.getByTestId(`follow-up-correct-discharge-${FU_PAEFI_F10}`).click();
    await expect(page.getByTestId("discharge-form-sheet")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("discharge-form-date").fill("2026-06-15");
    const corrected = page.waitForResponse((res) => res.url().includes("/discharge") && res.request().method() === "PUT");
    await page.getByTestId("discharge-form-submit").click();
    expect((await corrected).status(), "PUT da correção do desligamento").toBe(200);
    await expect(page.getByTestId("discharge-form-sheet")).toBeHidden({ timeout: 15_000 });
    await shot(page, "CA09-depois-da-correcao");
  });

  test("técnico do CRAS: CA03, CA07, CA10, CA16 e CA17", async () => {
    reseed();
    await login(page, OPERADOR);

    // CA03 — encaminhada ao CREAS e aguardando retorno: sem "Registrar situação" nem "Registrar observação".
    await openTab(page, F1, "violencia");
    await expect(page.getByTestId("violence-records-section")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("violence-records-note-shortcut")).toHaveCount(0);
    await expect(page.getByTestId("violence-records-register")).toHaveCount(0);
    await expect(page.getByTestId("violence-register-reason").first()).toBeVisible();
    await shot(page, "CA03-quadro3-sem-registrar-com-motivo");

    // CA07 — lê as avaliações do PAEFI do CREAS, sem a ação de avaliar (a evidência é a ausência).
    await openTab(page, F8, "acompanhamento");
    await expect(page.getByTestId(`follow-up-card-${FU_PAEFI_F8}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`follow-up-evaluate-${FU_PAEFI_F8}`)).toHaveCount(0);
    const read = await call(page, "GET", `families/${F8}/follow-ups/${FU_PAEFI_F8}/evaluations`);
    expect(read.status, "GET das avaliações").toBe(200);
    expect((read.json.data ?? []).length, "avaliações visíveis para leitura").toBeGreaterThan(0);
    await shot(page, "CA07-paefi-do-creas-sem-avaliar");

    // CA10 — por fora da tela: 403 com o motivo e nada gravado.
    const before = (read.json.data ?? []).length;
    const refused = await call(page, "POST", `families/${F8}/follow-ups/${FU_PAEFI_F8}/evaluations`, EVALUATION_BODY);
    expect(refused.status, "POST recusado").toBe(403);
    expect(refused.json.error_code).toBe("evaluation_unit_not_conducting");
    expect(String(refused.json.message ?? "").length).toBeGreaterThan(0);
    const after = await call(page, "GET", `families/${F8}/follow-ups/${FU_PAEFI_F8}/evaluations`);
    expect((after.json.data ?? []).length, "nada gravado").toBe(before);
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(
      path.join(SHOTS, "CA10-resposta-403.json"),
      JSON.stringify({ requisicao: "POST families/{família 8}/follow-ups/{PAEFI}/evaluations", status: refused.status, error_code: refused.json.error_code, message: refused.json.message, avaliacoes_antes: before, avaliacoes_depois: (after.json.data ?? []).length }, null, 2),
    );
    await shot(page, "CA10-paefi-inalterado-apos-403");

    // CA16 — família referenciada no CREAS, aberta pelo acompanhamento: sem "Trocar unidade"; o PUT é recusado.
    await openTab(page, F6, "resumo");
    await expect(page.getByTestId("family-reference-unit")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("family-change-unit")).toHaveCount(0);
    const unitBefore = await page.getByTestId("family-reference-unit").innerText();
    const options = await call(page, "GET", `families/${F6}/reference-unit-options`);
    expect(options.json.meta?.can_change, "meta.can_change").toBe(false);
    const target = (options.json.data ?? [])[0]?.id;
    const put = await call(page, "PUT", `families/${F6}/reference-unit`, { social_unit_id: target });
    expect(put.status, "PUT recusado").toBe(403);
    expect(put.json.error_code).toBe("reference_unit_origin_not_assigned");
    await page.reload();
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("family-reference-unit")).toHaveText(unitBefore);
    await shot(page, "CA16-sem-trocar-unidade");

    // CA17 — família do CREAS sem nenhum vínculo com o CRAS: negativa de acesso, sem dados da família.
    await page.goto(`/app/cadastros/familias/${F5}`);
    await dismissPlatformUpdates(page);
    await expect(denied(page).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("family-reference-unit")).toHaveCount(0);
    await shot(page, "CA17-negativa-de-acesso");
  });

  test("técnico do CREAS: CA02, CA11, CA08, CA18 e o retorno do CA04", async () => {
    reseed();
    await login(page, CREAS);

    // CA02 — a nota antiga do Master continua visível, com autor e data.
    await openTab(page, F1, "anotacoes");
    const old = page.getByTestId("family-note-item").filter({ hasText: "anotação antiga do Master no acolhimento" }).first();
    await expect(old).toBeVisible({ timeout: 20_000 });
    await shot(page, "CA02-nota-antiga-do-master-visivel");

    // CA11 — aviso da anotação em bloco sigiloso.
    await openTab(page, F2, "violencia");
    await page.getByTestId("violence-records-note-shortcut").click();
    await expect(page.getByTestId("family-note-form-sheet")).toBeVisible();
    await expect(page.getByTestId("family-note-block-notice")).toContainText("Esta anotação será lida apenas pela equipe técnica e pelo gestor Master.");
    await shot(page, "CA11-aviso-da-anotacao");

    // CA08 — o técnico da unidade que acompanha avalia durante o acompanhamento.
    await openTab(page, F2, "acompanhamento");
    await expect(page.getByTestId(`follow-up-card-${FU_PAEFI_F2}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`follow-up-evaluate-${FU_PAEFI_F2}`)).toBeVisible();
    await shot(page, "CA08-avaliar-disponivel");
    await page.getByTestId(`follow-up-evaluate-${FU_PAEFI_F2}`).click();
    await fillEvaluation(page);
    const saved = page.waitForResponse((res) => res.url().includes("/evaluations") && res.request().method() === "POST");
    await page.getByTestId("discharge-form-submit").click();
    expect((await saved).status(), "POST da avaliação").toBe(201);
    await expect(page.getByTestId("discharge-form-sheet")).toBeHidden({ timeout: 15_000 });
    await shot(page, "CA08-avaliacao-gravada");

    // CA18 — depois do retorno: sem acompanhamento no CREAS = negativa; com PAEFI vigente = abre.
    await page.goto(`/app/cadastros/familias/${F7}`);
    await dismissPlatformUpdates(page);
    await expect(denied(page).first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "CA18-sem-acompanhamento-negativa");
    await openTab(page, F8, "acompanhamento");
    await expect(page.getByTestId(`follow-up-card-${FU_PAEFI_F8}`)).toBeVisible({ timeout: 20_000 });
    await shot(page, "CA18-com-paefi-vigente-abre");

    // CA04 (parte do CREAS) — registra o retorno do encaminhamento da família 1.
    await openTab(page, F1, "encaminhamentos");
    await page.getByTestId(`referral-expand-${REFERRAL_F1}`).click();
    const outcome = page.waitForResponse((res) => res.url().includes("/outcome") && res.request().method() === "PATCH");
    await page.getByTestId(`referral-outcome-select-${REFERRAL_F1}`).click();
    await page.getByRole("option", { name: "Atendido", exact: true }).click();
    expect((await outcome).status(), "PATCH do desfecho").toBe(200);
    await shot(page, "CA04-retorno-registrado-pelo-creas");
  });

  test("técnico do CRAS de novo: CA04 (o retorno devolve a anotação)", async () => {
    await login(page, OPERADOR);
    await openTab(page, F1, "violencia");
    await expect(page.getByTestId("violence-records-section")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("violence-records-note-shortcut")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("violence-records-register")).toBeVisible();
    await expect(page.getByTestId("violence-register-reason").first()).toHaveCount(0);
    await shot(page, "CA04-quadro3-volta-a-registrar");
  });
});
