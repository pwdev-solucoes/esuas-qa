import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence, captureFinalEvidence } from "../../helpers/evidence";

/**
 * US-VISIB-01 (HU #11227) — visibilidade restrita por bloco, no frontend do
 * TENANT (`client/`). Spec MANUAL multiusuário: o cenário declarativo E2E-012
 * cobre o CREAS lendo e o CRAS Centro com o filtro de violência vazio; aqui
 * ficam o total `(2)`, a anotação anterior à regra, o aviso restrito no
 * formulário, o toast e a auditoria.
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`)
 *
 * O login de um usuário derruba a sessão do outro; a ordem é fixa e há 2 logins
 * além da sessão herdada do `chromium-tenant`:
 *  1. sessão herdada (operador do CRAS Centro): CA02 e CA04 — a evidência é a
 *     AUSÊNCIA (nenhum texto, contagem ou aviso sugere conteúdo oculto);
 *  2. operador do CREAS: CA01 (lê as duas de violência) e CA05 (aviso restrito
 *     no lugar do geral, e o toast repete o aviso restrito ao salvar);
 *  3. Master: CA03 (lê todas) e CA07 ("Leitura de bloco restrito" na auditoria
 *     da organização, gravada pela leitura do CREAS no passo 2).
 *
 * ## Massa (`E2EBlockVisibilitySeeder`, api)
 *
 * Família `…0f0015` referenciada no CRAS Centro, com PAEFI do CREAS; anotações
 * do CREAS `b1101` (violência, 2026-09-20), `b1102` (violência, ontem),
 * `b1103` (geral), `b1104` (saúde). Anotações são IMUTÁVEIS: a do CA05 usa um
 * texto único por execução (`RUN_TAG`) e fica na massa; para restaurar o estado
 * original rode o seeder (as novas continuam, mas o CRAS Centro nunca as vê).
 *
 * Nunca registra nem imprime CPF, nome ou texto de anotação em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const FAMILY_UUID =
  process.env.E2E_CLIENT_FAMILY_BLOCK_VISIBILITY_UUID ??
  "00000000-0000-4000-8000-0000000f0015";

const CREAS_CPF = process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "";
const CREAS_PASSWORD = process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "";
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? "";
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? "";

const EVIDENCE_SLUG = "us-visib-01-visibilidade-bloco";
const RUN_TAG = `E2E 11227 — registro da execução ${Date.now()}`;

const TEXT = {
  violenceOld: "E2E 11227 — violência (anterior à regra)",
  violenceRecent: "E2E 11227 — violência (ontem)",
  general: "E2E 11227 — geral",
  health: "E2E 11227 — saúde",
};

const RESTRICTED_NOTICE =
  "lido apenas pela unidade pela qual você está registrando";
const VIOLENCE_LABEL = "Violência e violações de direitos";

function note(page: Page, text: string) {
  return page.getByTestId("family-note-item").filter({ hasText: text });
}

async function openNotes(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY_UUID}?tab=anotacoes`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("family-notes-block")).toBeVisible();
  await expect(page.getByTestId("family-note-register-action")).toBeVisible();
  // a lista carregou: ou há itens, ou o estado vazio
  await expect(
    page
      .getByTestId("family-note-item")
      .first()
      .or(page.getByTestId("family-notes-empty")),
  ).toBeVisible();
}

async function pick(
  page: Page,
  trigger: string,
  option: string,
): Promise<void> {
  await page.getByTestId(trigger).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.describe("US-VISIB-01 — visibilidade restrita por bloco (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE, locale: "pt-BR" });

  test.afterEach(async ({ page }, testInfo) => {
    await captureFinalEvidence(page, testInfo, EVIDENCE_SLUG);
  });

  test("CA02/CA04 — CRAS Centro: só Geral e Saúde, total (2), sem sinal de conteúdo restrito (a evidência é a ausência)", async ({
    page,
  }, testInfo) => {
    await openNotes(page);

    await expect(note(page, TEXT.general)).toBeVisible();
    await expect(note(page, TEXT.health)).toBeVisible();
    await expect(page.getByTestId("family-notes-block")).toContainText("(2)");
    await expect(page.getByTestId("family-note-item")).toHaveCount(2);

    // CA04: a anotação de violência de 2026-09-20 (anterior à regra) também some.
    await expect(page.getByText(TEXT.violenceOld)).toHaveCount(0);
    await expect(page.getByText(TEXT.violenceRecent)).toHaveCount(0);
    await expect(page.getByTestId("family-notes-load-error")).toHaveCount(0);
    await captureEvidence(
      page,
      testInfo,
      EVIDENCE_SLUG,
      "CA04-anterior-restrita",
    );
    await page.screenshot({
      path: "test-results/visib01-ca04-anterior-restrita.png",
    });
    await page.screenshot({ path: "test-results/visib01-ca02-ausencia.png" });

    // CA02: o filtro de violência termina no estado vazio, como se nada existisse.
    await pick(page, "family-note-filter-block", VIOLENCE_LABEL);
    await expect(page.getByTestId("family-notes-empty-filtered")).toBeVisible();
    await expect(page.getByTestId("family-note-item")).toHaveCount(0);
    await expect(page.getByTestId("family-notes-block")).toContainText("(0)");
    await captureEvidence(
      page,
      testInfo,
      EVIDENCE_SLUG,
      "CA02-filtro-violencia-vazio",
    );
  });

  test("CA01/CA05 — CREAS lê a violência que registrou; o formulário mostra só o aviso restrito e o toast o repete", async ({
    page,
  }, testInfo) => {
    expect(
      CREAS_CPF && CREAS_PASSWORD,
      "E2E_CLIENT_CREAS_OPERADOR_CPF/PASSWORD no ambiente",
    ).toBeTruthy();
    await loginAsTenantUser(page, CREAS_CPF, CREAS_PASSWORD);
    await openNotes(page);

    // CA01
    await expect(note(page, TEXT.violenceRecent)).toBeVisible();
    await expect(note(page, TEXT.violenceOld)).toBeVisible();
    await expect(note(page, TEXT.general)).toBeVisible();
    await expect(note(page, TEXT.health)).toBeVisible();
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "CA01-creas-le");
    await page.screenshot({ path: "test-results/visib01-ca01-creas-le.png" });

    // CA05
    await page.getByTestId("family-note-register-action").click();
    await expect(page.getByTestId("family-note-form-sheet")).toBeVisible();
    await pick(page, "family-note-unit-select", "E2E CREAS");
    await pick(page, "family-note-block-select", VIOLENCE_LABEL);

    await expect(page.getByTestId("family-note-block-notice")).toContainText(
      RESTRICTED_NOTICE,
    );
    await expect(page.getByTestId("family-note-readers-notice")).toHaveCount(0);
    await page.screenshot({ path: "test-results/visib01-ca05-aviso.png" });
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "CA05-aviso");

    await page.getByTestId("family-note-content").fill(RUN_TAG);
    const created = page.waitForResponse(
      (res) =>
        res.url().includes("/notes") && res.request().method() === "POST",
    );
    await page.getByTestId("family-note-submit").click();
    expect((await created).status(), "POST da anotação de violência").toBe(201);

    const toast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: RESTRICTED_NOTICE });
    await expect(toast.first()).toBeVisible();
    await page.screenshot({ path: "test-results/visib01-ca05-toast.png" });
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "CA05-toast");
    await expect(note(page, RUN_TAG)).toBeVisible();
  });

  test('CA03/CA07 — Master lê todas; a auditoria da organização mostra "Leitura de bloco restrito"', async ({
    page,
  }, testInfo) => {
    expect(
      MASTER_CPF && MASTER_PASSWORD,
      "E2E_CLIENT_MASTER_CPF/PASSWORD no ambiente",
    ).toBeTruthy();
    await loginAsTenantUser(page, MASTER_CPF, MASTER_PASSWORD);
    await openNotes(page);

    // CA03
    await expect(note(page, TEXT.general)).toBeVisible();
    await expect(note(page, TEXT.health)).toBeVisible();
    await expect(note(page, TEXT.violenceRecent)).toBeVisible();
    await expect(note(page, RUN_TAG)).toBeVisible();
    await pick(page, "family-note-filter-block", VIOLENCE_LABEL);
    await expect(note(page, TEXT.violenceOld)).toBeVisible();
    await page.screenshot({ path: "test-results/visib01-ca03-master.png" });
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "CA03-master");

    // CA07 — a leitura do CREAS (passo anterior) gravou o evento.
    await page.goto("/app/auditoria");
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("tenant-audit-table")).toBeVisible();
    await expect(
      page
        .getByTestId("tenant-audit-row")
        .filter({ hasText: "Leitura de bloco restrito" })
        .first(),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/visib01-ca07-auditoria.png" });
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "CA07-auditoria");
  });
});
