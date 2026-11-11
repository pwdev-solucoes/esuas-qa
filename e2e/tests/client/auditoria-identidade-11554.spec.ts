import fs from "node:fs";
import path from "node:path";
import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * US-AJ-19 (HU #11554) — auditoria com identidade de quem agiu, rótulos em português e correção do
 * ingresso, no frontend do TENANT (`client/`). Spec MANUAL, com 2 logins em ordem fixa (throttle `6,1`):
 *
 *  1. técnico da massa: abre o prontuário (gera "Prontuário aberto"), corrige o ingresso 01 → 05 com órgão
 *     e contato fictícios, corrige a descrição do atendimento e altera a renda própria do integrante
 *     (as escritas vão pela API, com os cookies da sessão — o que importa aqui é a trilha);
 *  2. Master, com o NAVEGADOR em `en-US`: abre `/app/auditoria` e prova CA01 (nome + CPF mascarado,
 *     nenhum CPF inteiro), CA02 (rótulos em português e "Fechar"), CA03 (Correção, antes → depois,
 *     órgão e contato) e CA04 (descrição do atendimento sem conteúdo — a evidência é a ausência).
 *
 * ## Massa (E2EAuditIdentitySeeder, api)
 * Reaplique o seeder antes de cada rodada (a spec GRAVA correções). O E2E-060 lê a trilha que esta
 * spec deixa: rode esta spec primeiro e o E2E-060 em seguida, SEM reaplicar o seeder.
 * Credenciais só do ambiente (E2E_CLIENT_AUDIT_TECH_*, E2E_CLIENT_MASTER_*); nenhum CPF, senha ou nome
 * real é gravado aqui.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY = "00000000-0000-4000-8000-000011554001";
const MEMBER = "00000000-0000-4000-8000-000011554002";
const ATTENDANCE = "00000000-0000-4000-8000-000011554011";
const UNIT_CENTRO = "00000000-0000-4000-8000-0000000e0001";
const TECH_NAME = "E2E Auditoria Técnico";

const AGENCY = "Órgão fictício E2E 11554";
const CONTACT = "Contato fictício E2E 11554";
const INTAKE_REASON =
  "Motivo fictício E2E 11554: primeira procura pela unidade.";
const OLD_DESCRIPTION =
  "Descrição fictícia E2E 11554: orientação sobre documentação.";
const NEW_DESCRIPTION =
  "Texto corrigido fictício E2E 11554 que não pode aparecer.";

const SHOTS = path.resolve(
  __dirname,
  "../../../../e2e/reports/11554-auditoria-identidade-rotulos-acceptance/screenshots",
);

let techContext: BrowserContext;
let techPage: Page;
let masterContext: BrowserContext;
let master: Page;

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
  // Espera as animações de abrir/fechar o painel terminarem antes do print.
  await page.waitForTimeout(700);
  await page.screenshot({
    path: path.join(SHOTS, `${name}.png`),
    fullPage: true,
  });
}

/** Chamada à API com os cookies da sessão do navegador (sem Bearer). */
async function call(
  page: Page,
  method: "get" | "put",
  suffix: string,
  data?: Record<string, unknown>,
): Promise<APIResponse> {
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(
    cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "",
  );
  return page.context().request[method](`${API_BASE}/api/client/${suffix}`, {
    ...(data ? { data } : {}),
    headers: {
      Accept: "application/json",
      Origin: BASE!,
      Referer: `${BASE}/app`,
      "X-Requested-With": "XMLHttpRequest",
      "X-Tenant-UUID": TENANT_UUID,
      "X-XSRF-TOKEN": xsrf,
    },
  });
}

function yesterday(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function openAudit(page: Page): Promise<void> {
  await page.goto("/app/auditoria");
  await dismissPlatformUpdates(page);
  await expect(page.getByTestId("tenant-audit-table")).toBeVisible({
    timeout: 20_000,
  });
}

/** Linhas da trilha feitas pelo técnico da massa (mais recentes primeiro). */
function techRows(page: Page) {
  return page.getByTestId("tenant-audit-row").filter({ hasText: TECH_NAME });
}

test.beforeAll(async ({ browser }) => {
  if (!BASE) return;
  techContext = await browser.newContext({
    baseURL: BASE,
    locale: "pt-BR",
    viewport: { width: 1440, height: 1100 },
  });
  techPage = await techContext.newPage();
  masterContext = await browser.newContext({
    baseURL: BASE,
    locale: "en-US",
    viewport: { width: 1440, height: 1100 },
  });
  master = await masterContext.newPage();
});

test.afterAll(async () => {
  await techContext?.close();
  await masterContext?.close();
});

test.describe("US-AJ-19 — auditoria com identidade, português e correção (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test("login 1 — técnico da massa abre o prontuário e faz as correções", async () => {
    await techPage.goto("/auth/login");
    await loginAsTenantUser(
      techPage,
      credential("E2E_CLIENT_AUDIT_TECH_CPF"),
      credential("E2E_CLIENT_AUDIT_TECH_PASSWORD"),
    );
    await dismissPlatformUpdates(techPage);
    await expect(techPage).toHaveURL(/\/app/);

    // Abrir o prontuário gera "Prontuário aberto".
    await techPage.goto(`/app/cadastros/familias/${FAMILY}`);
    await dismissPlatformUpdates(techPage);
    await expect(
      techPage.getByRole("tablist", { name: "Grupos do prontuário" }),
    ).toBeVisible({ timeout: 20_000 });

    // Ingresso 01 → 05 (Encaminhamento da Saúde, exige órgão), com órgão e contato fictícios.
    const options = await call(techPage, "get", `families/${FAMILY}/intake`);
    expect(options.status(), "GET do ingresso").toBe(200);
    const body = await options.json();
    const forms: Array<{ id: number; code: string }> =
      body.data?.intake_forms ?? [];
    const health = forms.find((f) => f.code === "05");
    expect(health, "forma 05 entre as formas ativas").toBeTruthy();

    const intake = await call(techPage, "put", `families/${FAMILY}/intake`, {
      intake_form_id: health!.id,
      referring_agency_name: AGENCY,
      referring_agency_contact: CONTACT,
      reason: INTAKE_REASON,
    });
    expect(intake.status(), "correção do ingresso").toBe(200);

    // Descrição do atendimento corrigida (texto sensível: a trilha não pode exibi-lo).
    const attendance = await call(
      techPage,
      "put",
      `families/${FAMILY}/attendances/${ATTENDANCE}`,
      { description: NEW_DESCRIPTION },
    );
    expect(attendance.status(), "correção da descrição").toBe(200);

    // Renda própria do integrante: 800,00 → 1.200,50 (novo retrato).
    const income = await call(
      techPage,
      "put",
      `families/${FAMILY}/members/${MEMBER}/conditions`,
      {
        mode: "update",
        taken_on: yesterday(),
        social_unit_uuid: UNIT_CENTRO,
        work_income_conditions: {
          own_income: 1200.5,
          has_work_card: null,
          occupation_condition_uuid: null,
          has_professional_qualification: null,
          professional_qualification: null,
          receives_retirement_or_pension: null,
        },
      },
    );
    expect(income.status(), "renda própria do integrante").toBe(200);
  });

  test("login 2 — Master (navegador en-US) abre a auditoria da organização", async () => {
    await master.goto("/auth/login");
    await loginAsTenantUser(
      master,
      credential("E2E_CLIENT_MASTER_CPF"),
      credential("E2E_CLIENT_MASTER_PASSWORD"),
    );
    await dismissPlatformUpdates(master);
    await openAudit(master);
  });

  test("CA01 — a linha mostra o nome e o CPF mascarado de quem agiu", async () => {
    const row = techRows(master).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(TECH_NAME);

    const identity = row.getByTestId("tenant-audit-author-identity");
    await expect(identity).toBeVisible();
    await expect(identity).toHaveText(/\*\*\*\.\d{3}\.\d{3}-\*\*/);

    // Prova de ausência: nenhuma sequência de 11 dígitos nem CPF inteiro na página.
    const text = await master.locator("body").innerText();
    expect(text).not.toMatch(/\d{11}/);
    expect(text).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    await shot(master, "CA01-nome-e-cpf-mascarado");
  });

  test('CA02 — rótulos em português com o navegador en-US e botão "Fechar"', async () => {
    const row = master
      .getByTestId("tenant-audit-row")
      .filter({ hasText: "Renda própria" })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("tenant-audit-fields")).toContainText(
      "Renda própria",
    );

    await row.getByTestId("tenant-audit-view-detail").click();
    const detail = master.getByTestId("tenant-audit-detail");
    await expect(detail).toBeVisible({ timeout: 15_000 });
    // O fluxo real grava a condição como "Registro criado", sem o campo do integrante entre os
    // alterados; o rótulo "Integrante" fica provado pelo Pest TenantAuditLabelsTest (observação no dossiê).
    await expect(detail).toContainText("Condição de trabalho do integrante");
    await expect(
      master.getByTestId("tenant-audit-detail-channel"),
    ).toContainText("Painel do Tenant");
    await expect(detail.getByRole("button", { name: "Fechar" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Close" })).toHaveCount(0);
    // Nenhuma chave técnica no detalhe.
    await expect(detail).not.toContainText(
      /own_income|family_member_id|tenant_panel/,
    );
    await shot(master, "CA02-rotulos-em-portugues");

    await detail.getByRole("button", { name: "Fechar" }).click();
    await expect(detail).toBeHidden({ timeout: 10_000 });
  });

  test("CA03 — a correção do ingresso mostra Correção e antes → depois", async () => {
    const row = master
      .getByTestId("tenant-audit-row")
      .filter({ hasText: "Correção" })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByTestId("tenant-audit-view-detail").click();

    const detail = master.getByTestId("tenant-audit-detail");
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(master.getByTestId("tenant-audit-detail-event")).toContainText(
      "Correção",
    );
    const changes = master.getByTestId("audit-value-changes");
    await expect(changes).toContainText(
      "Demanda espontânea → Encaminhamento da Saúde",
    );
    await expect(changes).toContainText(AGENCY);
    await expect(changes).toContainText(CONTACT);
    // O motivo (texto livre) nunca aparece.
    await expect(detail).not.toContainText(INTAKE_REASON);
    await shot(master, "CA03-correcao-do-ingresso");

    await detail.getByRole("button", { name: "Fechar" }).click();
    await expect(detail).toBeHidden({ timeout: 10_000 });
  });

  test("CA04 — descrição do atendimento corrigida sem conteúdo (a evidência é a ausência)", async () => {
    const fields = master
      .getByTestId("tenant-audit-fields")
      .filter({ hasText: "Descrição do atendimento (conteúdo não exibido)" })
      .first();
    await expect(fields).toBeVisible({ timeout: 15_000 });

    const row = master
      .getByTestId("tenant-audit-row")
      .filter({ hasText: "Descrição do atendimento (conteúdo não exibido)" })
      .first();
    await row.getByTestId("tenant-audit-view-detail").click();
    const detail = master.getByTestId("tenant-audit-detail");
    await expect(detail).toBeVisible({ timeout: 15_000 });

    // Prova de ausência: nem o texto novo nem o antigo aparecem em lugar algum da página.
    const text = await master.locator("body").innerText();
    expect(text).not.toContain(NEW_DESCRIPTION);
    expect(text).not.toContain(OLD_DESCRIPTION);
    await expect(detail.getByTestId("audit-value-changes")).toHaveCount(0);
    await shot(master, "CA04-descricao-sem-conteudo");
  });
});
