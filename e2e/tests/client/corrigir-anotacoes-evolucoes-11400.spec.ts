import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-02 (HU #11400) — correção de anotações e evoluções, ordem das evoluções e
 * avaliações e tempo em dias (`client/`). Spec MANUAL multiusuário: o cenário
 * declarativo E2E-038 cobre a correção da anotação `…a01` (CA01), a ausência de
 * "Corrigir" no registro de outro técnico (CA03) e de qualquer botão de excluir (CA04).
 * Aqui ficam a evolução (CA02), a ordem (CA05), o tempo em dias (CA06) e o Master.
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`, máximo de 5 logins) — 2 logins
 *  1. operador do CRAS Centro (`E2E_CLIENT_OPERADOR`): CA02, CA05, CA06;
 *  2. Master (`E2E_CLIENT_MASTER`): abre a `…a01`, sem "Corrigir" (não é autor) e com
 *     "Versões anteriores".
 *
 * ## Massa (E2EFamilyNoteCorrectionSeeder, api; tudo fictício)
 * Família `…11400001` (anotações a01/a02, PAIF `…f01` com evoluções `…e01`–`e03` e
 * avaliações `…b01`/`…b02`) e família `…11400002` (PAIF `…f02`, ingresso hoje − 15
 * dias no fuso da organização, sem avaliação). Rode o seeder antes de cada execução.
 * Asserções pelo texto marcado da execução e pelos uuids fixos, nunca por contagem
 * de versões. Nunca registra nem imprime CPF ou texto de anotação em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY_ONE = "00000000-0000-4000-8000-000011400001";
const FAMILY_TWO = "00000000-0000-4000-8000-000011400002";
const F01 = "00000000-0000-4000-8000-000011400f01";
const F02 = "00000000-0000-4000-8000-000011400f02";
const EVAL_OLD = "00000000-0000-4000-8000-000011400b01";
const EVAL_NEW = "00000000-0000-4000-8000-000011400b02";
const EVIDENCE_SLUG = "11400-corrigir-anotacoes-evolucoes";

const RUN_TAG = `E2E11400-${Date.now()}`;
const EVOLUTION_TEXT = `${RUN_TAG} evolução corrigida com o texto completo`;
const NOTE_TEXT = `${RUN_TAG} anotação corrigida pelo operador`;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const newPage = (browser: import("@playwright/test").Browser) =>
  browser.newPage({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

async function loginNew(
  browserPage: Promise<Page>,
  user: { cpf: string; password: string },
): Promise<Page> {
  const page = await browserPage;
  await loginAsTenantUser(page, user.cpf, user.password, {
    tenantUuid: TENANT_UUID,
  });
  await dismissPlatformUpdates(page);
  return page;
}

async function openFollowUp(
  page: Page,
  family: string,
  followUp: string,
): Promise<void> {
  await page.goto(`/app/cadastros/familias/${family}?tab=acompanhamento`);
  await dismissPlatformUpdates(page);
  const expand = page.getByTestId(`follow-up-expand-${followUp}`);
  await expect(expand).toBeVisible({ timeout: 20_000 });
  await expand.click();
  await expect(
    page.getByTestId(`follow-up-evolutions-${followUp}`),
  ).toBeVisible({ timeout: 20_000 });
}

async function openNotes(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY_ONE}?tab=anotacoes`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("family-note-item").first()).toBeVisible({
    timeout: 20_000,
  });
}

async function order(container: Locator, first: string, second: string) {
  const html = await container.innerHTML();
  expect(html.indexOf(first), `${first} presente`).toBeGreaterThanOrEqual(0);
  expect(html.indexOf(second), `${second} presente`).toBeGreaterThanOrEqual(0);
  expect(html.indexOf(first)).toBeLessThan(html.indexOf(second));
}

test.describe("US-AJ-02 — corrigir anotações e evoluções (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  test.describe("operador do CRAS Centro", () => {
    let op: Page;

    test.beforeAll(async ({ browser }) => {
      op = await loginNew(newPage(browser), {
        cpf: env("E2E_CLIENT_OPERADOR_CPF"),
        password: env("E2E_CLIENT_OPERADOR_PASSWORD"),
      });
    });

    test.afterAll(async () => {
      await op?.close();
    });

    test("CA02 — o operador corrige a própria evolução e a versão anterior fica em Versões anteriores", async ({}, testInfo) => {
      await openFollowUp(op, FAMILY_ONE, F01);
      const list = op.getByTestId(`follow-up-evolutions-${F01}`);
      const item = list.getByTestId("follow-up-evolution-item").first();
      await expect(
        item.getByTestId("follow-up-evolution-correct"),
      ).toBeVisible();

      await item.getByTestId("follow-up-evolution-correct").click();
      await expect(
        op.getByTestId("family-note-correction-sheet"),
      ).toBeVisible();
      await op
        .getByTestId("family-note-correction-content")
        .fill(EVOLUTION_TEXT);
      await op.getByTestId("family-note-correction-submit").click();
      await expect(op.getByTestId("family-note-correction-sheet")).toBeHidden({
        timeout: 15_000,
      });

      const corrected = list
        .getByTestId("follow-up-evolution-item")
        .filter({ hasText: EVOLUTION_TEXT });
      await expect(corrected).toBeVisible({ timeout: 15_000 });
      await expect(
        corrected.getByTestId("follow-up-evolution-revised"),
      ).toBeVisible();

      await corrected.getByTestId("follow-up-evolution-revisions").click();
      const dialog = op.getByTestId("revision-history-dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText("evolução 3");
      await captureEvidence(op, testInfo, EVIDENCE_SLUG, "evolucao-corrigida");
      await op.keyboard.press("Escape");
      await expect(dialog).toBeHidden({ timeout: 10_000 });
    });

    test("CA05 — evoluções e avaliações do acompanhamento aparecem da mais recente para a mais antiga", async ({}, testInfo) => {
      await openFollowUp(op, FAMILY_ONE, F01);
      const evolutions = op.getByTestId(`follow-up-evolutions-${F01}`);
      const items = evolutions.getByTestId("follow-up-evolution-item");
      await expect(items.first()).toContainText(EVOLUTION_TEXT);
      await expect(items.nth(1)).toContainText("evolução 2");
      await expect(items.nth(2)).toContainText("evolução 1");

      const evaluations = op.getByTestId(`follow-up-evaluations-${F01}`);
      await expect(evaluations).toBeVisible({ timeout: 15_000 });
      await order(evaluations, EVAL_NEW, EVAL_OLD);
      await captureEvidence(
        op,
        testInfo,
        EVIDENCE_SLUG,
        "mais-recente-primeiro",
      );
    });

    test("CA06 — o Sheet de avaliação mostra o tempo em dias e a linha do tempo repete os dias", async ({}, testInfo) => {
      await openFollowUp(op, FAMILY_TWO, F02);
      await op.getByTestId(`follow-up-evaluate-${F02}`).click();
      await expect(op.getByTestId("discharge-form-sheet")).toBeVisible();
      await expect(op.getByTestId("discharge-form-days")).toHaveValue(
        /15 dias/,
      );
      await captureEvidence(op, testInfo, EVIDENCE_SLUG, "tempo-em-dias");

      const answers: Record<string, string> = {
        offers_provided: "yes",
        referrals_effective: "not_applicable",
        family_recognizes_service: "yes",
        outcome_classification: "progress",
      };
      for (const [field, value] of Object.entries(answers)) {
        await op
          .getByTestId(`discharge-form-answer-${field}-${value}`)
          .check();
      }
      await op
        .getByTestId("discharge-form-achieved-results")
        .fill(`${RUN_TAG} resultados da avaliação periódica`);
      await op.getByTestId("discharge-form-submit").click();
      await expect(op.getByTestId("discharge-form-sheet")).toBeHidden({
        timeout: 15_000,
      });

      const timeline = op.getByTestId(`follow-up-evaluations-${F02}`);
      await expect(timeline).toBeVisible({ timeout: 15_000 });
      await expect(timeline).toContainText("15 dias de acompanhamento");
    });

    test("CA02 — o operador corrige a própria anotação (base do Master abaixo)", async () => {
      await openNotes(op);
      const own = op
        .getByTestId("family-note-item")
        .filter({ has: op.getByTestId("family-note-correct") })
        .first();
      await own.getByTestId("family-note-correct").click();
      await expect(
        op.getByTestId("family-note-correction-sheet"),
      ).toBeVisible();
      await op.getByTestId("family-note-correction-content").fill(NOTE_TEXT);
      await op.getByTestId("family-note-correction-submit").click();
      await expect(
        op.getByTestId("family-note-item").filter({ hasText: NOTE_TEXT }),
      ).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe("Master", () => {
    let master: Page;

    test.beforeAll(async ({ browser }) => {
      master = await loginNew(newPage(browser), {
        cpf: env("E2E_CLIENT_MASTER_CPF"),
        password: env("E2E_CLIENT_MASTER_PASSWORD"),
      });
    });

    test.afterAll(async () => {
      await master?.close();
    });

    test("CA03 — o Master não é autor: abre a anotação sem Corrigir e com Versões anteriores (a evidência é a ausência do botão)", async ({}, testInfo) => {
      await openNotes(master);
      const item = master
        .getByTestId("family-note-item")
        .filter({ hasText: NOTE_TEXT });
      await expect(item).toBeVisible();
      await expect(item.getByTestId("family-note-correct")).toHaveCount(0);
      await expect(item.getByTestId("family-note-revisions")).toBeVisible();
      await captureEvidence(
        master,
        testInfo,
        EVIDENCE_SLUG,
        "master-nao-autor",
      );

      await item.getByTestId("family-note-revisions").click();
      await expect(master.getByTestId("revision-history-dialog")).toBeVisible({
        timeout: 10_000,
      });
    });
  });
});
