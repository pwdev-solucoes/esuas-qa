import fs from "node:fs";
import path from "node:path";
import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * HU #11652 — auditoria com ANTES e DEPOIS nas correções (frontend do TENANT, `client/`).
 * Spec MANUAL com 3 logins em ordem fixa (throttle `6,1`):
 *
 *  1. técnico da massa (E2E_CLIENT_AUDIT_TECH_*): corrige pela API, com os cookies da sessão, a descrição do
 *     atendimento (CA04), o ingresso (forma 05 + contato A → B: CA06, CA10), a razão do desligamento (CA03),
 *     atualiza a renda (CA09, `mode=update`) e, por último, a data e o tipo do atendimento (CA01, CA02);
 *  2. Master: abre `/app/auditoria`, filtra "Correção" e prova os CAs no detalhe (antes → depois, unidade,
 *     ausência de texto livre e de CPF, linha antiga, nome da época);
 *  3. Operador (sem função): recebe a negativa (CA11).
 *
 * ## Massa (E2EAuditCorrectionsSeeder, api)
 * Reaplique o seeder ANTES de cada rodada (a spec GRAVA correções) e NÃO o reaplique antes do E2E-064, que lê a
 * trilha que esta spec deixa. O CPF do CA05 é corrigido pelo próprio seeder (nenhuma tela corrige o CPF).
 * Credenciais só do ambiente; nenhum CPF, senha ou nome real é gravado aqui.
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY = "00000000-0000-4000-8000-000011652001";
const MEMBER = "00000000-0000-4000-8000-000011652031";
const ATTENDANCE = "00000000-0000-4000-8000-000011652011";
const FOLLOW_UP = "00000000-0000-4000-8000-000011652021";
const UNIT_CENTRO = "00000000-0000-4000-8000-0000000e0001";
const OLD_NAME = "E2E Auditoria Técnico (nome da época)";

const AGENCY = "Órgão fictício E2E 11652";
const CONTACT_A = "Contato fictício A E2E 11652";
const CONTACT_B = "Contato fictício B E2E 11652";
const INTAKE_REASON =
  "Motivo fictício E2E 11652: primeira procura pela unidade.";
const OLD_DESCRIPTION =
  "Descrição fictícia E2E 11652: orientação sobre benefícios.";
const NEW_DESCRIPTION_1 = "Texto corrigido fictício E2E 11652 que não pode aparecer.";
const NEW_DESCRIPTION_2 = "Segundo texto corrigido fictício E2E 11652 que não pode aparecer.";

const SHOTS = path.resolve(
  __dirname,
  "../../../../e2e/reports/11652-auditoria-antes-depois-correcoes-acceptance/screenshots",
);

let techContext: BrowserContext;
let techPage: Page;
let masterContext: BrowserContext;
let master: Page;
let opContext: BrowserContext;
let operador: Page;

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

function detailOf(page: Page): Locator {
  return page.getByTestId("tenant-audit-detail");
}

async function closeDetail(page: Page): Promise<void> {
  const detail = detailOf(page);
  if (await detail.isVisible()) {
    await detail.getByRole("button", { name: "Fechar" }).click();
    await expect(detail).toBeHidden({ timeout: 10_000 });
  }
}

/** Abre o detalhe da primeira linha que bate com o filtro e devolve o texto do detalhe. */
async function openRow(page: Page, row: Locator): Promise<Locator> {
  await closeDetail(page);
  const first = row.first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  await first.getByTestId("tenant-audit-view-detail").click();
  const detail = detailOf(page);
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  return detail;
}

/** Percorre as linhas "Correção" até achar aquela cujo detalhe traz o texto esperado. */
async function openCorrectionWith(page: Page, text: string): Promise<Locator> {
  const rows = page
    .getByTestId("tenant-audit-row")
    .filter({ hasText: "Correção" });
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    await closeDetail(page);
    await rows.nth(i).getByTestId("tenant-audit-view-detail").click();
    const detail = detailOf(page);
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    const changes = detail.getByTestId("audit-value-changes");
    if ((await changes.count()) > 0 && (await changes.innerText()).includes(text)) {
      return detail;
    }
  }
  throw new Error(`Nenhuma correção com "${text}" no detalhe.`);
}

test.beforeAll(async ({ browser }) => {
  if (!BASE) return;
  const make = async () => {
    const context = await browser.newContext({
      baseURL: BASE,
      locale: "pt-BR",
      viewport: { width: 1440, height: 1100 },
    });
    return { context, page: await context.newPage() };
  };
  ({ context: techContext, page: techPage } = await make());
  ({ context: masterContext, page: master } = await make());
  ({ context: opContext, page: operador } = await make());
});

test.afterAll(async () => {
  await techContext?.close();
  await masterContext?.close();
  await opContext?.close();
});

test.describe("HU #11652 — auditoria com antes e depois nas correções (client)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test("login 1 — técnico da massa faz as correções", async () => {
    await techPage.goto("/auth/login");
    await loginAsTenantUser(
      techPage,
      credential("E2E_CLIENT_AUDIT_TECH_CPF"),
      credential("E2E_CLIENT_AUDIT_TECH_PASSWORD"),
    );
    await dismissPlatformUpdates(techPage);
    await expect(techPage).toHaveURL(/\/app/);

    // CA04 — só a descrição (texto livre: a trilha não pode exibi-lo).
    const desc = await call(
      techPage,
      "put",
      `families/${FAMILY}/attendances/${ATTENDANCE}`,
      { description: NEW_DESCRIPTION_1 },
    );
    expect(desc.status(), "correção da descrição").toBe(200);

    // CA06/CA10 — ingresso 01 → 05 com órgão e contato A; depois o contato A → B.
    const options = await call(techPage, "get", `families/${FAMILY}/intake`);
    expect(options.status(), "GET do ingresso").toBe(200);
    const forms: Array<{ id: number; code: string }> =
      (await options.json()).data?.intake_forms ?? [];
    const health = forms.find((f) => f.code === "05");
    expect(health, "forma 05 entre as formas ativas").toBeTruthy();
    for (const contact of [CONTACT_A, CONTACT_B]) {
      const intake = await call(techPage, "put", `families/${FAMILY}/intake`, {
        intake_form_id: health!.id,
        referring_agency_name: AGENCY,
        referring_agency_contact: contact,
        reason: INTAKE_REASON,
      });
      expect(intake.status(), "correção do ingresso").toBe(200);
    }

    // CA03 — razão do desligamento "Evasão ou recusa da Família" → "Mudança de município".
    const opts = await call(
      techPage,
      "get",
      `families/${FAMILY}/follow-ups/${FOLLOW_UP}/evaluations/options`,
    );
    expect(opts.status(), "opções do desligamento").toBe(200);
    const reasons: Array<{ uuid: string; name: string }> =
      (await opts.json()).data?.exit_reasons ?? [];
    const moved = reasons.find((r) => r.name === "Mudança de município");
    expect(moved, "razão Mudança de município").toBeTruthy();
    const discharge = await call(
      techPage,
      "put",
      `families/${FAMILY}/follow-ups/${FOLLOW_UP}/discharge`,
      { follow_up_exit_reason_uuid: moved!.uuid },
    );
    expect(discharge.status(), "correção do desligamento").toBe(200);

    // CA09 — atualização (não correção) da renda: "Registro criado".
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
    expect(income.status(), "atualização da renda").toBe(200);

    // CA01/CA02 — por último (é a 1ª "Correção" da lista): data 10→08/10/2026 e tipo → Visita domiciliar.
    const att = await call(
      techPage,
      "get",
      `families/${FAMILY}/attendances/options`,
    );
    expect(att.status(), "opções do atendimento").toBe(200);
    const types: Array<{ uuid: string; name: string }> =
      (await att.json()).data?.types ?? [];
    const visit = types.find((t) => t.name === "Visita domiciliar");
    expect(visit, "tipo Visita domiciliar").toBeTruthy();
    const edit = await call(
      techPage,
      "put",
      `families/${FAMILY}/attendances/${ATTENDANCE}`,
      {
        attended_on: "2026-10-08",
        attendance_type_uuid: visit!.uuid,
        description: NEW_DESCRIPTION_2,
      },
    );
    expect(edit.status(), "correção da data e do tipo").toBe(200);
  });

  test("login 2 — Master abre a auditoria e filtra por Correção", async () => {
    await master.goto("/auth/login");
    await loginAsTenantUser(
      master,
      credential("E2E_CLIENT_MASTER_CPF"),
      credential("E2E_CLIENT_MASTER_PASSWORD"),
    );
    await dismissPlatformUpdates(master);
    await openAudit(master);

    await master.getByRole("combobox", { name: "Tipo de ação" }).click();
    await master.getByRole("option", { name: "Correção", exact: true }).click();
    await master.getByTestId("tenant-audit-apply").click();
    await expect(
      master.getByTestId("tenant-audit-row").first(),
    ).toContainText("Correção", { timeout: 15_000 });
    await master.waitForTimeout(1500); // a lista termina de recarregar com o filtro
    const rows = master.getByTestId("tenant-audit-row");
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      await expect(rows.nth(i)).toContainText("Correção");
    }
  });

  test("CA01/CA02 — data e tipo do atendimento, antes → depois, pelo nome", async () => {
    const detail = await openCorrectionWith(master, "10/10/2026 → 08/10/2026");
    await expect(master.getByTestId("tenant-audit-detail-event")).toContainText(
      "Correção",
    );
    const changes = detail.getByTestId("audit-value-changes");
    await expect(changes).toContainText(
      "Data do atendimento: 10/10/2026 → 08/10/2026",
    );
    await expect(changes).toContainText("Tipo de atendimento");
    await expect(changes).toContainText("Atendimento socioassistencial individualizado → Visita domiciliar");
    await shot(master, "CA01-data-do-atendimento");
    await shot(master, "CA02-tipo-do-atendimento");
  });

  test("CA03 — razão do desligamento, antes → depois", async () => {
    const detail = await openCorrectionWith(master, "Mudança de município");
    await expect(master.getByTestId("tenant-audit-detail-event")).toContainText(
      "Correção",
    );
    await expect(detail.getByTestId("audit-value-changes")).toContainText(
      "Evasão ou recusa da Família → Mudança de município",
    );
    await shot(master, "CA03-razao-do-desligamento");
  });

  test("CA04 — descrição corrigida sem conteúdo (a evidência é a ausência)", async () => {
    const row = master
      .getByTestId("tenant-audit-row")
      .filter({ hasText: "Descrição do atendimento (conteúdo não exibido)" })
      .filter({ hasNotText: "Data do atendimento" });
    const detail = await openRow(master, row);
    await expect(master.getByTestId("tenant-audit-detail-event")).toContainText(
      "Correção",
    );
    const text = await master.locator("body").innerText();
    for (const t of [OLD_DESCRIPTION, NEW_DESCRIPTION_1, NEW_DESCRIPTION_2]) {
      expect(text).not.toContain(t);
    }
    await expect(detail.getByTestId("audit-value-changes")).toHaveCount(0);
    await shot(master, "CA04-descricao-sem-conteudo");
  });

  test("CA05 — CPF alterado, sem valor anterior nem novo (a evidência é a ausência)", async () => {
    const row = master
      .getByTestId("tenant-audit-row")
      .filter({ hasText: "Correção" })
      .filter({ has: master.getByTestId("tenant-audit-fields").filter({ hasText: "CPF" }) });
    const detail = await openRow(master, row);
    await expect(master.getByTestId("tenant-audit-detail-event")).toContainText(
      "Correção",
    );
    await expect(detail).toContainText("CPF");
    await expect(detail.getByTestId("audit-value-changes")).toHaveCount(0);
    // Prova de ausência: nenhuma sequência de 11 dígitos nem CPF formatado na página.
    const text = await master.locator("body").innerText();
    expect(text).not.toMatch(/\d{11}/);
    expect(text).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    await shot(master, "CA05-cpf-alterado-sem-valor");
  });

  test("CA06/CA10 — contato do órgão antes → depois e unidade CRAS Centro", async () => {
    const detail = await openCorrectionWith(
      master,
      `${CONTACT_A} → ${CONTACT_B}`,
    );
    await expect(detail.getByTestId("audit-value-changes")).toContainText(
      `${CONTACT_A} → ${CONTACT_B}`,
    );
    await shot(master, "CA06-contato-do-orgao");

    const unit = master.getByTestId("tenant-audit-detail-unit");
    await expect(unit).toContainText("CRAS Centro");
    await expect(unit).not.toContainText("Não informado");
    // O motivo (texto livre) nunca aparece.
    await expect(detail).not.toContainText(INTAKE_REASON);
    await shot(master, "CA10-unidade-cras-centro");
  });

  test("CA07 — correção antiga aparece como foi gravada, sem valores", async () => {
    const row = master
      .getByTestId("tenant-audit-row")
      .filter({ hasText: "Registro atualizado" })
      .filter({ hasText: "Data do atendimento" });
    // O filtro "Correção" esconde a linha antiga: limpa o filtro.
    await closeDetail(master);
    await master.getByTestId("tenant-audit-clear").click();
    await master.getByRole("combobox", { name: "Tipo de ação" }).click();
    await master
      .getByRole("option", { name: "Registro atualizado", exact: true })
      .click();
    await master.getByRole("combobox", { name: "Módulo" }).click();
    await master.getByRole("option", { name: /^Atendimentos?$/ }).click();
    await master.getByTestId("tenant-audit-apply").click();
    await master.waitForTimeout(1500);
    await expect(row.first()).toBeVisible({ timeout: 15_000 });
    const detail = await openRow(master, row);
    await expect(master.getByTestId("tenant-audit-detail-event")).toContainText(
      "Registro atualizado",
    );
    await expect(detail.getByTestId("audit-value-changes")).toHaveCount(0);
    await shot(master, "CA07-correcao-antiga");
  });

  test("CA08 — nome de quem agiu no momento da correção", async () => {
    // Filtra pelo usuário técnico: reúne a correção do nome da época e a atualização da renda.
    await closeDetail(master);
    await master.getByTestId("tenant-audit-clear").click();
    await master.getByRole("combobox", { name: "Usuário" }).click();
    await master
      .getByRole("option", { name: /^E2E Auditoria Técnico/ })
      .first()
      .click();
    await master.getByTestId("tenant-audit-apply").click();
    await master.waitForTimeout(1500);
    const row = master
      .getByTestId("tenant-audit-row")
      .filter({ hasText: OLD_NAME });
    const detail = await openRow(master, row);
    await expect(detail).toContainText(OLD_NAME);
    await shot(master, "CA08-nome-da-epoca");
  });

  test("CA09 — atualização da renda aparece como Registro criado", async () => {
    const row = master
      .getByTestId("tenant-audit-row")
      .filter({ hasText: "Registro criado" })
      .filter({ hasText: "Renda própria" });
    const detail = await openRow(master, row);
    await expect(master.getByTestId("tenant-audit-detail-event")).toContainText(
      "Registro criado",
    );
    await expect(master.getByTestId("tenant-audit-detail-event")).not.toContainText(
      "Correção",
    );
    await shot(master, "CA09-registro-criado");
    await closeDetail(master);
  });

  test("CA11 — Operador recebe a negativa de acesso", async () => {
    await operador.goto("/auth/login");
    await loginAsTenantUser(
      operador,
      credential("E2E_CLIENT_OPERADOR_CPF"),
      credential("E2E_CLIENT_OPERADOR_PASSWORD"),
    );
    await dismissPlatformUpdates(operador);
    await operador.goto("/app/auditoria");
    await dismissPlatformUpdates(operador);
    await expect(operador).toHaveURL(/\/403/, { timeout: 15_000 });
    await expect(operador.getByText("Acesso Negado")).toBeVisible();
    await expect(operador.getByTestId("tenant-audit-table")).toHaveCount(0);

    // A API recusa também (403): a auditoria é exclusiva do Master.
    const res = await call(operador, "get", "tenant-audits");
    expect(res.status(), "GET tenant-audits do Operador").toBe(403);
    await shot(operador, "CA11-operador-acesso-negado");
  });
});
