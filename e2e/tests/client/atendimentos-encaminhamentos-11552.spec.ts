import { expect, test, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * HU #11552 (US-AJ-17) — responsável técnico só com função técnica, data futura sem derrubar as
 * opções e "Registrar retorno" direto da linha. Painel do Tenant (`client/`).
 *
 * Complementa o E2E-058 (CA01, CA03, CA04) com o que ele não cobre: CA02 (administrativo), CA03b
 * (encaminhamento), CA04b (página de pendentes) e CA05 (lista vazia). Com CAPTURE_EVIDENCE=1 grava
 * um print por CA de tela direto em `e2e/reports/11552-atendimentos-encaminhamentos-acceptance/screenshots/`
 * (raiz do meta-repo).
 *
 * Massa: `E2EAttendanceReferralAdjustmentsSeeder` (família …11552001; encaminhamentos …11552101 da
 * Centro ao CREAS e …11552102 da Rural). Reaplique o seeder antes de cada rodada: o CA04b conclui o
 * …11552102. Fictícia; nenhum dado pessoal. Logins: 4 (operador, administrativo, CREAS, Rural).
 */

const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY = "00000000-0000-4000-8000-000011552001";
const REFERRAL_CREAS = "00000000-0000-4000-8000-000011552101";
const REFERRAL_RURAL = "00000000-0000-4000-8000-000011552102";
const CENTRO = "E2E CRAS Centro";
const CAPTURING = process.env.CAPTURE_EVIDENCE === "1";
const SHOTS = path.resolve(
  __dirname,
  "../../../../e2e/reports/11552-atendimentos-encaminhamentos-acceptance/screenshots",
);

const who = (prefix: string) => ({
  cpf: process.env[`E2E_CLIENT_${prefix}_CPF`] ?? "",
  password: process.env[`E2E_CLIENT_${prefix}_PASSWORD`] ?? "",
});

async function login(page: Page, prefix: string) {
  const u = who(prefix);
  await loginAsTenantUser(page, u.cpf, u.password, { tenantUuid: TENANT_UUID });
  await dismissPlatformUpdates(page);
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await dismissPlatformUpdates(page);
}

async function shot(page: Page, name: string, focus?: Locator) {
  if (!CAPTURING) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  if (focus) await focus.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function openAttendanceForm(page: Page) {
  await open(page, `/app/cadastros/familias/${FAMILY}?tab=atendimentos`);
  await page.getByTestId("attendance-register-action").click();
  await expect(page.getByTestId("attendance-form-sheet")).toBeVisible();
  await page.getByTestId("attendance-form-unit").click();
  await page.getByRole("option", { name: CENTRO }).click();
  await expect(page.getByTestId("attendance-form-responsible")).toBeEnabled();
}

test.describe("HU #11552 — responsável técnico, data futura e retorno direto", () => {
  test("CA01/CA03/CA03b — assistente social: lista técnica, data futura no atendimento e no encaminhamento", async ({
    page,
  }) => {
    await login(page, "OPERADOR");

    // CA01 — a lista de responsáveis do Centro traz a equipe técnica e não o administrativo.
    await openAttendanceForm(page);
    await page.getByTestId("attendance-form-responsible").click();
    await expect(
      page.getByRole("option", { name: "E2E Sigilo Psicóloga Centro" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "E2E Sigilo Administrativo" }),
    ).toHaveCount(0);
    await page.waitForTimeout(800); // fim da animação do menu, para o print sair nítido
    await shot(page, "CA01-lista-responsavel-tecnico");
    await page.keyboard.press("Escape");

    // CA03 — data de amanhã no atendimento: só a recusa da data; unidade e opções ficam.
    await page.getByTestId("attendance-form-date").fill(tomorrowIso());
    await expect(
      page.getByText("Não se registra atendimento que ainda não aconteceu"),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(
      page.getByText("Não foi possível carregar as opções do formulário"),
    ).toHaveCount(0);
    await expect(page.getByTestId("attendance-form-unit")).toContainText(CENTRO);
    await expect(page.getByTestId("attendance-form-responsible")).toBeEnabled();
    await shot(page, "CA03-data-futura-atendimento");

    // CA03b — o mesmo no encaminhamento.
    await open(page, `/app/cadastros/familias/${FAMILY}?tab=encaminhamentos`);
    await page.getByTestId("referral-register-action").click();
    await expect(page.getByTestId("referral-form-sheet")).toBeVisible();
    await page.getByTestId("referral-form-unit").click();
    await page.getByRole("option", { name: CENTRO }).click();
    await page.getByTestId("referral-form-date").fill(tomorrowIso());
    await expect(
      page.getByText("Não se registra encaminhamento que ainda não aconteceu"),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(
      page.getByText("Não foi possível carregar as opções do formulário"),
    ).toHaveCount(0);
    await expect(page.getByTestId("referral-form-unit")).toContainText(CENTRO);
    await shot(page, "CA03b-data-futura-encaminhamento");
  });

  test("CA02 — administrativo: responsável vem vazio, recusa sem escolher e grava ao escolher técnico", async ({
    page,
  }) => {
    await login(page, "ADMIN_STAFF");
    await openAttendanceForm(page);

    // O responsável técnico vem vazio (o administrativo não é elegível).
    const responsible = page.getByTestId("attendance-form-responsible");
    await expect(responsible).toContainText(/selecione/i);

    await page.getByTestId("attendance-form-type").click();
    await page.locator('[role="option"]').first().click();
    await page
      .getByTestId("attendance-form-description")
      .fill("Atendimento E2E #11552 registrado pelo apoio administrativo.");
    // Pessoa atendida é obrigatória no CRAS (HU #11403): marcada para isolar o campo do responsável.
    await page.locator('[data-testid^="attendance-person-"]').first().click();
    await page.getByTestId("attendance-form-submit").click();

    const alert = page.getByRole("alert").filter({ hasText: /respons[aá]vel/i });
    await expect(alert.first()).toBeVisible();
    await expect(page.getByTestId("attendance-form-sheet")).toBeVisible();
    await shot(page, "CA02-administrativo-responsavel-vazio", alert.first());

    // Ao escolher alguém da equipe técnica, registra.
    await responsible.click();
    await expect(
      page.getByRole("option", { name: "E2E Sigilo Administrativo" }),
    ).toHaveCount(0);
    await page.locator('[role="option"]').first().click();
    await page.getByTestId("attendance-form-submit").click();
    await expect(page.getByTestId("attendance-form-sheet")).toBeHidden({
      timeout: 15_000,
    });
  });

  test("CA04 — técnico do CREAS vê 'Registrar retorno' na linha, sem expandir", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1700, height: 900 }); // a coluna Ações cabe sem rolagem lateral
    await login(page, "CREAS_OPERADOR");
    await open(page, `/app/cadastros/familias/${FAMILY}?tab=encaminhamentos`);
    const rowReturn = page.getByTestId(`referral-row-return-${REFERRAL_CREAS}`);
    await expect(rowReturn).toBeVisible();
    await expect(
      page.getByTestId(`referral-register-return-${REFERRAL_CREAS}`),
    ).toHaveCount(0);
    await rowReturn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, "CA04-registrar-retorno-na-linha");
  });

  test("CA04b/CA05 — técnico do Rural registra o retorno pela página de pendentes e a lista esvazia", async ({
    page,
  }) => {
    await login(page, "RURAL");
    await open(page, "/app/cadastros/encaminhamentos-pendentes");
    const row = page.getByTestId(`pending-referral-row-${REFERRAL_RURAL}`);
    const returnBtn = page.getByTestId(`pending-referral-return-${REFERRAL_RURAL}`);
    await expect(row).toBeVisible();
    await expect(returnBtn).toBeVisible();
    await shot(page, "CA04b-pendentes-registrar-retorno");

    await returnBtn.click();
    await page
      .getByTestId("counter-reference-note")
      .fill("Retorno E2E #11552: família atendida.");
    await page.getByTestId("counter-reference-outcome").click();
    await page
      .locator('[role="option"]:has-text("Atendido"):not(:has-text("Não"))')
      .click();
    await page.getByTestId("register-counter-reference-confirm").click();

    // A linha some ao concluir; como era o único pendente do Rural, a lista fica vazia (CA05).
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("register-counter-reference-dialog")).toBeHidden();
    await page.waitForTimeout(800);
    const empty = page.getByTestId("pending-referrals-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(
      "Nenhum encaminhamento enviado pelas suas unidades está aguardando retorno.",
    );
    await expect(empty).not.toContainText(/desfecho/i);
    await shot(page, "CA05-lista-vazia-pendentes");
  });
});
