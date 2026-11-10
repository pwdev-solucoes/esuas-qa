import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loginAsTenantUser } from "../../fixtures/tenant-auth";
import { dismissPlatformUpdates } from "../../helpers/platform-updates";

/**
 * US-RAT-01 (HU #11545) — modelo do Relatório de Atividades, frontend do TENANT.
 * Spec MANUAL (o cenário declarativo E2E-052 cobre a montagem e a ativação com um
 * login próprio; aqui os mesmos CAs geram também o print do dossiê).
 *
 * ## Arranjo (⚠️ `throttle:6,1`: 2 logins, sequenciais)
 *  1. Master:
 *     - CA01–CA04: monta pela API um modelo de Pilar do CREAS (2 blocos, linha digitada,
 *       linha com subitens e B.6 do sistema), ativa, e tira os prints da lista, do editor
 *       e da pré-visualização (B.6 da "E2E CREAS RMA" em 2026-10 = 4);
 *     - CA05: no modelo em rascunho da massa, acrescenta "B.16 Estudos de caso"; confere pela
 *       API que a linha existe e pelo banco que o relatório de outubro congelado NÃO a tem;
 *     - CA06: exclui B.15.1 (usada no relatório de outubro da "E2E CREAS") ⇒ diálogo
 *       "já foi usada" ⇒ Inativar ⇒ selo "Inativa";
 *  2. Operador: CA07 — o menu não traz "Modelos do Relatório de Atividades" e a URL direta é
 *     negada (a evidência é a ausência).
 *
 * ## Massa e limpeza
 * `E2EActivityReportTemplateSeeder`. O `beforeAll` inativa qualquer modelo CREAS ATIVO (a massa da
 * #11546 semeia um) e apaga restos do E2E-052; o `afterAll` apaga o modelo dos prints, reativa o que
 * foi inativado e repõe a massa (B.16 some, B.15.1 volta a ativa). Feito por `docker exec` + artisan,
 * como o reseed da #11544.
 *
 * Credenciais só por variável de ambiente; nunca imprime CPF, nome ou corpo de resposta.
 */

const BASE = process.env.CLIENT_BASE_URL ?? "http://localhost:4174";
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID = process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const MASTER_CPF = process.env.E2E_CLIENT_MASTER_CPF ?? "";
const MASTER_PASSWORD = process.env.E2E_CLIENT_MASTER_PASSWORD ?? "";
const OPERADOR_CPF = process.env.E2E_CLIENT_OPERADOR_CPF ?? "";
const OPERADOR_PASSWORD = process.env.E2E_CLIENT_OPERADOR_PASSWORD ?? "";
const API_CONTAINER = process.env.E2E_API_CONTAINER ?? "api-laravel.test-1";

const ROUTE = "/app/configuracoes/modelos-relatorio-atividades";
const SEED_TEMPLATE = "00000000-0000-4000-8000-000011545101";
const PRINTS_TITLE = "Relatório das Atividades – CREAS (prints 11545)";
const REPORT_DIR = path.resolve(__dirname, "..", "..", "..", "..", "e2e", "reports", "11545-modelo-relatorio-atividades-acceptance");
const SHOTS = path.join(REPORT_DIR, "screenshots");

const PHP_HEAD =
  "use App\\Enums\\ActivityReport\\ActivityReportTemplateStatus as S; use App\\Models\\ActivityReportTemplate as T;";

function tinker(code: string): string {
  return execFileSync("docker", ["exec", API_CONTAINER, "php", "artisan", "tinker", `--execute=${PHP_HEAD} ${code}`], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

function reseed(): void {
  execFileSync(
    "docker",
    ["exec", API_CONTAINER, "php", "artisan", "db:seed", "--class=Database\\Seeders\\E2EActivityReportTemplateSeeder", "--force"],
    { stdio: "ignore", timeout: 120_000 },
  );
}

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.promises.mkdir(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  if ("goto" in target) {
    await target.screenshot({ path: file });
  } else {
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: file });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(page: Page, method: "get" | "post", urlPath: string, data?: unknown): Promise<any> {
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(cookies.find((c) => c.name === "XSRF-TOKEN")?.value ?? "");
  const res = await page.context().request[method](`${API_BASE}/api/client/${urlPath}`, {
    ...(method === "post" ? { data: data ?? {} } : {}),
    headers: {
      Accept: "application/json",
      Origin: BASE,
      Referer: `${BASE}/app`,
      "X-Requested-With": "XMLHttpRequest",
      "X-Tenant-UUID": TENANT_UUID,
      "X-XSRF-TOKEN": xsrf,
    },
  });
  expect(res.ok(), `${method} ${urlPath} => ${res.status()}`).toBeTruthy();
  const body = await res.json().catch(() => ({}));
  return body?.data ?? body;
}

let restore: string[] = [];
let shared: Page | undefined;

async function startSession(browser: Browser, cpf: string, password: string): Promise<Page> {
  if (shared) await shared.context().close();
  const context = await browser.newContext({ baseURL: BASE, locale: "pt-BR", viewport: { width: 1440, height: 1100 } });
  shared = await context.newPage();
  await loginAsTenantUser(shared, cpf, password);
  return shared;
}

test.describe.configure({ mode: "serial" });

test.describe("US-RAT-01 #11545 — modelo do Relatório de Atividades", () => {
  test.skip(!MASTER_CPF || !MASTER_PASSWORD || !OPERADOR_CPF || !OPERADOR_PASSWORD, "sem credenciais");

  test.beforeAll(() => {
    reseed();
    const out = tinker(
      "foreach (T::withoutGlobalScopes()->whereNull('deleted_at')->whereIn('status', ['draft','active','inactive'])->get() as $x) {" +
        " if (str_contains($x->title, 'E2E-052') || str_contains($x->title, 'prints 11545')) { $x->status = S::INACTIVE; $x->save(); $x->delete(); }" +
        " elseif ($x->status === S::ACTIVE) { $x->status = S::INACTIVE; $x->save(); echo 'RESTORE:' . $x->uuid . PHP_EOL; } }",
    );
    restore = [...out.matchAll(/RESTORE:([0-9a-f-]{36})/g)].map((m) => m[1]);
  });

  test.afterAll(async () => {
    if (shared) await shared.context().close();
    shared = undefined;
    tinker(
      "foreach (T::withoutGlobalScopes()->whereNull('deleted_at')->where('title', 'like', '%prints 11545%')->get() as $x) { $x->status = S::INACTIVE; $x->save(); $x->delete(); }",
    );
    for (const uuid of restore) {
      tinker(`$x = T::withoutGlobalScopes()->where('uuid', '${uuid}')->first(); if ($x) { $x->status = S::ACTIVE; $x->save(); }`);
    }
    reseed();
  });

  test("CA01–CA04 — o Master monta, ativa e pré-visualiza o modelo de Pilar do CREAS", async ({ browser }) => {
    const page = await startSession(browser, MASTER_CPF, MASTER_PASSWORD);

    const tpl = await api(page, "post", "activity-report-templates", { title: PRINTS_TITLE, social_unit_type_code: "002" });
    const b1 = await api(page, "post", `activity-report-templates/${tpl.uuid}/blocks`, {
      label: "Bloco 1",
      title: "Bloco 1 – Atividades de acompanhamento",
    });
    const b2 = await api(page, "post", `activity-report-templates/${tpl.uuid}/blocks`, {
      label: "Bloco 2",
      title: "Bloco 2 – Encaminhamentos",
    });
    const line = (block: string, body: Record<string, unknown>) =>
      api(page, "post", `activity-report-template-blocks/${block}/lines`, body);

    await line(b1.uuid, { number_label: "A.1", text: "Famílias em acompanhamento (digitada)", source_type: "manual" });
    const a5 = await line(b1.uuid, { number_label: "A.5", text: "Benefícios eventuais concedidos", source_type: "group" });
    await line(b1.uuid, {
      number_label: "A.5.1",
      text: "Cesta básica",
      source_type: "system",
      source_kind: "eventual_benefits",
      source_codes: ["4"],
      parent_line_uuid: a5.uuid,
    });
    await line(b1.uuid, { number_label: "A.5.2", text: "Auxílio gás (digitada)", source_type: "manual", parent_line_uuid: a5.uuid });
    await line(b2.uuid, {
      number_label: "B.6",
      text: "Encaminhamentos realizados",
      source_type: "system",
      source_kind: "referrals",
      source_codes: ["14"],
    });
    await api(page, "post", `activity-report-templates/${tpl.uuid}/activate`);

    // CA01 — o modelo de Pilar aparece como "Ativo" na lista.
    await page.goto(ROUTE);
    await dismissPlatformUpdates(page);
    const row = page.getByTestId("art-row").filter({ hasText: PRINTS_TITLE });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("art-status")).toHaveText(/Ativo/);
    await shot(page, "CA01-modelo-pilar-ativo");

    // CA03 e CA04 — linha com subitens do sistema/digitado e linha digitada, no editor.
    await page.goto(`${ROUTE}/${tpl.uuid}`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("art-editor")).toBeVisible();
    await expect(page.getByTestId("art-line").filter({ hasText: "A.5.1 Cesta básica" })).toBeVisible();
    await expect(page.getByTestId("art-line").filter({ hasText: "A.5.2 Auxílio gás (digitada)" })).toBeVisible();
    await shot(page.getByTestId("art-block").first(), "CA03-subitens-beneficios");
    const manual = page.getByTestId("art-line").filter({ hasText: "A.1 Famílias em acompanhamento (digitada)" });
    await expect(manual).toBeVisible();
    await shot(manual, "CA04-linha-digitada");

    // CA02 — a pré-visualização calcula a B.6 da unidade em 2026-10 (4 encaminhamentos código 14).
    await expect(page.getByTestId("art-preview")).toBeVisible();
    await page.getByTestId("art-preview-unit").selectOption({ label: "E2E CREAS RMA" });
    await page.getByTestId("art-preview-month").fill("2026-10");
    await page.getByTestId("art-preview-run").click();
    await expect(page.getByTestId("art-preview-result")).toBeVisible();
    const b6 = page.getByTestId("art-preview-line").filter({ hasText: "B.6" });
    await expect(b6.getByTestId("art-preview-value")).toHaveText(/^\s*4\s*$/);
    await shot(page.getByTestId("art-preview"), "CA02-preview-encaminhadas-cras");
  });

  test("CA05 — a linha nova entra no modelo e o relatório de outubro congelado não a tem", async () => {
    const page = shared!;
    await page.goto(`${ROUTE}/${SEED_TEMPLATE}`);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("art-editor")).toBeVisible();
    await page.getByTestId("art-add-line").first().click();
    await page.getByTestId("art-line-number").fill("B.16");
    await page.getByTestId("art-line-text").fill("Estudos de caso");
    await page.getByTestId("art-line-source-type-manual").click();
    await page.getByTestId("art-line-save").click();
    await expect(page.getByTestId("art-line").filter({ hasText: "B.16 Estudos de caso" })).toBeVisible();

    const detail = await api(page, "get", `activity-report-templates/${SEED_TEMPLATE}`);
    expect(JSON.stringify(detail)).toContain("Estudos de caso");

    const snapshot = tinker(
      "$r = App\\Models\\ActivityReport::withoutGlobalScopes()->where('reference_month', '2026-10-01')->whereHas('template', fn ($q) => $q->withoutGlobalScopes()->where('uuid', '" +
        SEED_TEMPLATE +
        "'))->first(); echo 'OCT_HAS_B16:' . (str_contains(json_encode($r->structure_snapshot), 'B.16') ? 'yes' : 'no');",
    );
    expect(snapshot).toContain("OCT_HAS_B16:no");

    await shot(page.getByTestId("art-block").first(), "CA05-linha-nova-novembro");
  });

  test("CA06 — excluir uma linha já usada oferece inativar e o selo aparece", async () => {
    const page = shared!;
    await page.goto(`${ROUTE}/${SEED_TEMPLATE}`);
    await dismissPlatformUpdates(page);
    const used = page.getByTestId("art-line").filter({ hasText: "B.15.1 Internas" });
    await expect(used).toBeVisible();
    await used.getByTestId("art-line-delete").click();
    await page.getByTestId("art-delete-confirm").click();
    const dialog = page.getByTestId("art-in-use-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/já foi usada/i);
    await shot(page, "CA06-linha-usada-inativar");
    await page.getByTestId("art-in-use-deactivate").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("art-line").filter({ hasText: "B.15.1 Internas" })).toContainText("Inativa");
    await shot(page.getByTestId("art-block").first(), "CA06b-selo-inativa");
  });

  test("CA07 — o Operador não vê o menu nem entra na tela (a evidência é a ausência)", async ({ browser }) => {
    const page = await startSession(browser, OPERADOR_CPF, OPERADOR_PASSWORD);
    await page.goto("/app");
    await dismissPlatformUpdates(page);
    await expect(page.getByRole("link", { name: /Modelos do Relatório de Atividades/i })).toHaveCount(0);

    await page.goto(ROUTE);
    await dismissPlatformUpdates(page);
    await expect(page.getByTestId("art-new")).toHaveCount(0);
    await expect(page.getByTestId("art-row")).toHaveCount(0);
    await shot(page, "CA07-operador-sem-acesso");
  });
});
