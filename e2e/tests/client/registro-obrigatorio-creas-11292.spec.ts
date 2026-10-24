import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence, captureFinalEvidence } from "../../helpers/evidence";

/**
 * US-VIOL-03 (HU #11292) — registro obrigatório do CREAS (Quadro 3) na aba
 * "Violência" do prontuário (`client/`). Spec MANUAL multiusuário: o cenário
 * declarativo E2E-030 cobre o operador do CREAS (CA01/CA02, validação, vazio) e o
 * técnico do CRAS Centro (CA03/CA06); aqui ficam o Master (CA05), o auxiliar de
 * escritório do CREAS (CA04, CA08, RN06) e a notificação (CA07).
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`)
 *
 * O login de um usuário derruba a sessão do outro. Ordem fixa, 3 logins:
 *  1. Master (`E2E_CLIENT_MASTER`): CA05 — lê, sem "Registrar situação" nem
 *     "Registrar confirmação" (a evidência é a AUSÊNCIA);
 *  2. auxiliar de escritório do CREAS (`E2E_CLIENT_CREAS_ADMIN_STAFF`, função
 *     4110-05, da 11289): CA04 e CA08 — sem a aba Violência, com o aviso fixo,
 *     sem a anotação do bloco 18 e com a anotação geral;
 *  3. operador do CREAS (`E2E_CLIENT_CREAS_OPERADOR`): CA07 — registra a
 *     notificação ao Conselho Tutelar em 12/10/2026.
 *
 * ## Massa (E2EViolenceRecordSeeder, api; tudo fictício)
 * `…000011292001` com os registros `…a01` (Ana, violência física, indício, 08/2026,
 * sem notificação) e `…a02` (Bruno, negligência, confirmada, 07/2026, notificada);
 * anotações `…b01` (bloco 18) e `…b02` (geral); `…000011292002` sem registro.
 * O seeder reseta a notificação do `…a01` a cada rodada.
 *
 * Asserções pelo item (situação + mês), nunca por contagem absoluta. Nunca
 * registra nem imprime CPF, nome ou situação em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY_COM_REGISTRO = "00000000-0000-4000-8000-000011292001";
const FAMILY_SEM_REGISTRO = "00000000-0000-4000-8000-000011292002";

const MASTER = {
  cpf: process.env.E2E_CLIENT_MASTER_CPF ?? "52998224725",
  password: process.env.E2E_CLIENT_MASTER_PASSWORD ?? "senha123",
};
const CREAS_ADMIN_STAFF = {
  cpf: process.env.E2E_CLIENT_CREAS_ADMIN_STAFF_CPF ?? "99000150299",
  password: process.env.E2E_CLIENT_CREAS_ADMIN_STAFF_PASSWORD ?? "senha123",
};
const CREAS_OPERADOR = {
  cpf: process.env.E2E_CLIENT_CREAS_OPERADOR_CPF ?? "99000140064",
  password: process.env.E2E_CLIENT_CREAS_OPERADOR_PASSWORD ?? "senha123",
};

const NOTICE = "Parte deste prontuário é restrita à equipe técnica.";
const NOTE_VIOLENCE = "E2E 11292 — violência registrada pelo CREAS";
const NOTE_GENERAL = "E2E 11292 — anotação geral do CREAS";
const EVIDENCE_SLUG = "11292-registro-obrigatorio-creas-quadro-3";

async function open(page: Page, family: string, tab?: string): Promise<void> {
  await page.goto(
    `/app/cadastros/familias/${family}${tab ? `?tab=${tab}` : ""}`,
  );
  await dismissPlatformUpdates(page);
  await expect(
    page.getByRole("tab", { name: "Composição Familiar", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

function recordItem(page: Page, situation: string, month: string) {
  return page
    .getByTestId("violence-record-item")
    .filter({ hasText: situation })
    .filter({ hasText: month });
}

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

test.describe("US-VIOL-03 — registro obrigatório do CREAS, Quadro 3 (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  test.describe("Master", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(
        browser.newPage({
          baseURL: BASE,
          locale: "pt-BR",
          viewport: { width: 1440, height: 1600 },
        }),
        MASTER,
      );
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA05 — o Master lê o Quadro 3 e não tem Registrar situação nem Registrar confirmação (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, FAMILY_COM_REGISTRO, "violencia");
      await expect(user.getByTestId("violence-records-section")).toBeVisible({
        timeout: 15_000,
      });
      await expect(recordItem(user, "Violência física", "08/2026")).toBeVisible(
        { timeout: 15_000 },
      );
      await expect(
        recordItem(user, "Negligência ou abandono", "07/2026"),
      ).toBeVisible();

      await expect(user.getByTestId("violence-records-register")).toHaveCount(
        0,
      );
      await expect(user.getByTestId("violence-record-confirm")).toHaveCount(0);
      await expect(user.getByTestId("violence-record-correct")).toHaveCount(0);
      await expect(user.getByTestId("violence-record-notify")).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "master-le-sem-acao",
      );
    });
  });

  test.describe("auxiliar de escritório do CREAS", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(
        browser.newPage({
          baseURL: BASE,
          locale: "pt-BR",
          viewport: { width: 1440, height: 1600 },
        }),
        CREAS_ADMIN_STAFF,
      );
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA04 — o auxiliar de escritório do CREAS não tem a aba Violência e vê o aviso fixo, na família com e na sem registro (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, FAMILY_COM_REGISTRO);
      const notice = user.getByTestId("family-confidentiality-notice");
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect(notice).toContainText(NOTICE);
      await expect(
        user.getByRole("tab", { name: "Violência", exact: true }),
      ).toHaveCount(0);
      await expect(user.getByTestId("family-tab-violencia")).toHaveCount(0);
      const withRecord = (await notice.textContent())?.trim();
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "nao-tecnico-sem-aba",
      );

      // Mesmo endereço da aba: a tela volta ao resumo, sem o Quadro 3.
      await open(user, FAMILY_COM_REGISTRO, "violencia");
      await expect(user.getByTestId("violence-records-section")).toHaveCount(0);
      await expect(user.getByTestId("violence-record-item")).toHaveCount(0);

      await open(user, FAMILY_SEM_REGISTRO);
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect(notice).toContainText(NOTICE);
      await expect(
        user.getByRole("tab", { name: "Violência", exact: true }),
      ).toHaveCount(0);
      expect((await notice.textContent())?.trim()).toBe(withRecord);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "aviso-familia-sem-registro",
      );
    });

    test("CA08 — a anotação do bloco Violência e violações não aparece para o auxiliar; a anotação geral aparece (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user, FAMILY_COM_REGISTRO, "anotacoes");
      await expect(user.getByTestId("family-notes-block")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        user.getByTestId("family-note-item").filter({ hasText: NOTE_GENERAL }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        user.getByTestId("family-note-item").filter({ hasText: NOTE_VIOLENCE }),
      ).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "anotacao-sigilosa-ausente",
      );
    });
  });

  test.describe("operador do CREAS", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(
        browser.newPage({
          baseURL: BASE,
          locale: "pt-BR",
          viewport: { width: 1440, height: 1600 },
        }),
        CREAS_OPERADOR,
      );
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test.afterEach(async ({}, testInfo) => {
      await captureFinalEvidence(user, testInfo, EVIDENCE_SLUG);
    });

    test("CA07 — o operador do CREAS registra a notificação ao Conselho Tutelar em 12/10/2026 e ela consta no item", async ({}, testInfo) => {
      await open(user, FAMILY_COM_REGISTRO, "violencia");
      const item = recordItem(user, "Violência física", "08/2026");
      await expect(item).toBeVisible({ timeout: 15_000 });
      await expect(item).toContainText("Notificação não informada");

      await item.getByTestId("violence-record-notify").click();
      const dialog = user.getByTestId("violence-notification-dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await dialog.getByTestId("violence-record-notification-done-yes").click();
      await dialog
        .getByTestId("violence-record-notified-on")
        .fill("2026-10-12");
      await dialog.getByTestId("violence-record-body-select").click();
      await user
        .getByRole("option", { name: "Conselho Tutelar", exact: true })
        .click();
      await dialog.getByTestId("violence-notification-submit").click();

      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await expect(
        recordItem(user, "Violência física", "08/2026").getByTestId(
          "violence-record-notification",
        ),
      ).toContainText("Notificado em 12/10/2026 · Conselho Tutelar", {
        timeout: 10_000,
      });
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "notificacao-conselho-tutelar",
      );
    });
  });
});
