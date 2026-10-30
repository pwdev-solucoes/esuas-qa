import { expect, test, type Page } from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";
import { captureEvidence } from "../../helpers/evidence";

/**
 * US-AJ-01 (HU #11399) — descrição sigilosa do atendimento, aba "Atendimentos" do
 * prontuário (`client/`). Spec MANUAL multiusuário: o cenário declarativo E2E-037
 * cobre o registro pelo operador do CREAS (CA01) e o barramento sem descrição; aqui
 * ficam a leitura (CA02, CA03, CA05), a ausência da opção (CA04) e o Master (RN02).
 *
 * ## Arranjo (⚠️ sessão única, `throttle:6,1`, máximo de 5 logins)
 *
 * O login de um usuário derruba a sessão do outro. Ordem fixa, 2 logins:
 *  0. sessão herdada do `chromium-tenant` (assistente social do CRAS Centro, SEM
 *     login): CA03 — expande o `…101` e lê o texto com o selo "Descrição sigilosa";
 *  1. assistente administrativo (CBO 4110-10) do CRAS Centro
 *     (`E2E_CLIENT_ADMIN_STAFF`): CA02 (faixa no lugar do texto), CA05 (`…102` legível),
 *     CA04 (sem a opção no registro nem na correção; faixa no lugar do campo);
 *  2. Master (`E2E_CLIENT_MASTER`): RN02 — lê o `…101` e vê a opção na correção.
 *
 * ## Massa (E2EConfidentialAttendanceSeeder, api; tudo fictício)
 * Família `…000011399001`; atendimento `…11399101` (CREAS, sigiloso) e `…11399102`
 * (CRAS Centro, sem sigilo). Os atendimentos que o E2E-037 registra são removidos a
 * cada rodada do seeder; as asserções são pelo uuid fixo, nunca por contagem.
 * Nunca registra nem imprime CPF, nome ou descrição em log.
 */

const BASE = process.env.CLIENT_BASE_URL;
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";

const FAMILY = "00000000-0000-4000-8000-000011399001";
const SIGILOSO = "00000000-0000-4000-8000-000011399101";
const ABERTO = "00000000-0000-4000-8000-000011399102";

const TEXTO_SIGILOSO =
  "Relato fictício E2E: situação sensível registrada pelo CREAS.";
const TEXTO_ABERTO =
  "Atendimento E2E sem sigilo: orientação sobre documentação.";
const FAIXA = "Conteúdo restrito à equipe técnica.";
const SELO = "Descrição sigilosa";
const EVIDENCE_SLUG = "11399-sigilo-descricao-atendimento";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function dateBr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function open(page: Page): Promise<void> {
  await page.goto(`/app/cadastros/familias/${FAMILY}?tab=atendimentos`);
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("attendance-register-action")).toBeVisible({
    timeout: 20_000,
  });
}

async function expand(page: Page, uuid: string): Promise<void> {
  const details = page.getByTestId(`attendance-details-${uuid}`);
  if (!(await details.isVisible().catch(() => false))) {
    await page.getByTestId(`attendance-expand-${uuid}`).click();
  }
  await expect(details).toBeVisible({ timeout: 10_000 });
}

async function openForm(page: Page, action: string): Promise<void> {
  await page.getByTestId(action).click();
  await expect(page.getByTestId("attendance-form-sheet")).toBeVisible({
    timeout: 10_000,
  });
  // Deixa as opções do servidor (can_mark_confidential) carregarem.
  await page.waitForTimeout(1500);
}

async function closeForm(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("attendance-form-sheet")).toBeHidden({
    timeout: 10_000,
  });
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

const newPage = (browser: import("@playwright/test").Browser) =>
  browser.newPage({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

test.describe("US-AJ-01 — descrição sigilosa do atendimento (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test.describe.configure({ mode: "serial" });
  test.use({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1600 },
  });

  test("CA03 — a assistente social do CRAS Centro lê a descrição do atendimento sigiloso do CREAS, com o selo", async ({
    page,
  }, testInfo) => {
    await open(page);
    await expand(page, SIGILOSO);

    const details = page.getByTestId(`attendance-details-${SIGILOSO}`);
    await expect(details).toContainText(TEXTO_SIGILOSO);
    await expect(
      page.getByTestId(`attendance-confidential-badge-${SIGILOSO}`),
    ).toContainText(SELO);
    await expect(
      page.getByTestId(`attendance-description-restricted-${SIGILOSO}`),
    ).toHaveCount(0);
    await captureEvidence(page, testInfo, EVIDENCE_SLUG, "cras-le-descricao");
  });

  test.describe("assistente administrativo do CRAS Centro", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(newPage(browser), {
        cpf: env("E2E_CLIENT_ADMIN_STAFF_CPF"),
        password: env("E2E_CLIENT_ADMIN_STAFF_PASSWORD"),
      });
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test("CA02 — o assistente administrativo vê data, tipo, unidade, responsável e pessoa do atendimento sigiloso e a faixa no lugar da descrição", async ({}, testInfo) => {
      await open(user);
      const row = user.getByTestId(`attendance-row-${SIGILOSO}`);
      await expect(row).toContainText(dateBr(10));
      await expect(row).toContainText("E2E CREAS");
      await expect(row).toContainText("E2E Sigilo Responsável");
      // Tipo e responsável preenchidos (a coluna não cai em traço).
      const cells = row.locator("td");
      await expect(cells.nth(1)).not.toHaveText(/^\s*[—-]\s*$/);
      await expect(cells.nth(3)).not.toHaveText(/^\s*[—-]\s*$/);

      await expand(user, SIGILOSO);
      await expect(
        user.getByTestId(`attendance-description-restricted-${SIGILOSO}`),
      ).toContainText(FAIXA);
      await expect(
        user.getByTestId(`attendance-details-${SIGILOSO}`),
      ).not.toContainText(TEXTO_SIGILOSO);
      await expect(
        user.getByTestId(`attendance-confidential-badge-${SIGILOSO}`),
      ).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "administrativo-ve-faixa",
      );
    });

    test("CA05 — o assistente administrativo lê a descrição do atendimento sem marcação, sem selo", async ({}, testInfo) => {
      await open(user);
      await expand(user, ABERTO);
      await expect(
        user.getByTestId(`attendance-details-${ABERTO}`),
      ).toContainText(TEXTO_ABERTO);
      await expect(
        user.getByTestId(`attendance-confidential-badge-${ABERTO}`),
      ).toHaveCount(0);
      await expect(
        user.getByTestId(`attendance-description-restricted-${ABERTO}`),
      ).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "sem-marcacao-legivel",
      );
    });

    test("CA04 — o assistente administrativo não tem a opção de sigilo ao registrar nem ao corrigir, e a correção do sigiloso mostra a faixa no lugar do campo (a evidência é a ausência)", async ({}, testInfo) => {
      await open(user);

      // Registro: sem a opção.
      await openForm(user, "attendance-register-action");
      await expect(
        user.getByTestId("attendance-form-description-confidential"),
      ).toHaveCount(0);
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "sem-opcao-registro",
      );
      await closeForm(user);

      // Correção do atendimento aberto: sem a opção.
      await openForm(user, `attendance-correct-${ABERTO}`);
      await expect(
        user.getByTestId("attendance-form-description-confidential"),
      ).toHaveCount(0);
      await closeForm(user);

      // Correção do sigiloso: faixa no lugar do campo (fecha sem salvar).
      await openForm(user, `attendance-correct-${SIGILOSO}`);
      await expect(
        user.getByTestId("attendance-form-description-restricted"),
      ).toContainText(FAIXA);
      await expect(
        user.getByTestId("attendance-form-description-confidential"),
      ).toHaveCount(0);
      await expect(user.getByTestId("attendance-form-description")).toHaveCount(
        0,
      );
      await captureEvidence(
        user,
        testInfo,
        EVIDENCE_SLUG,
        "sem-opcao-correcao",
      );
      await closeForm(user);
    });
  });

  test.describe("Master", () => {
    let user: Page;

    test.beforeAll(async ({ browser }) => {
      user = await loginNew(newPage(browser), {
        cpf: env("E2E_CLIENT_MASTER_CPF"),
        password: env("E2E_CLIENT_MASTER_PASSWORD"),
      });
    });

    test.afterAll(async () => {
      await user?.close();
    });

    test("RN02 — o Master lê a descrição do atendimento sigiloso e vê a opção de sigilo na correção", async ({}, testInfo) => {
      await open(user);
      await expand(user, SIGILOSO);
      await expect(
        user.getByTestId(`attendance-details-${SIGILOSO}`),
      ).toContainText(TEXTO_SIGILOSO);
      await expect(
        user.getByTestId(`attendance-confidential-badge-${SIGILOSO}`),
      ).toContainText(SELO);

      await openForm(user, `attendance-correct-${SIGILOSO}`);
      await expect(
        user.getByTestId("attendance-form-description-confidential"),
      ).toBeVisible();
      await captureEvidence(user, testInfo, EVIDENCE_SLUG, "master-ve-opcao");
      await closeForm(user);
    });
  });
});
