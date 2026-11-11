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
 * US-AJ-20 (HU #11555) — textos em português com o NAVEGADOR em inglês, pendência SIAP legível e contadores
 * sem número provisório, no frontend do TENANT (`client/`). Spec MANUAL, com 2 logins em ordem fixa
 * (throttle `6,1`; BR-001 permite até 3) e `locale: 'en-US'`:
 *
 *  1. operador do CRAS Centro: CA01 (cadastra família sem endereço → aviso TCE-AL em português),
 *     CA03 (aba Ingresso e programas da família …011555001 → "Bolsa Família"), CA06/CA07 (contador sem
 *     número durante o carregamento, atrasado com `page.route`, e o número certo depois), CA08 (menu inteiro
 *     em 1920 px) e o print do botão "Painel" da página inexistente (CA04);
 *  2. Master: CA02 ("Trocar unidade" da família …011555002: destino, aviso em português e CANCELA sem
 *     confirmar) e CA05 (apaga o endereço da "E2E CRAS Textos 11555" pela API, abre a conferência prévia da
 *     Remessa SIAP e confere "Campo: Endereço da unidade (EnderecoUnidadeSocial)"; RESTAURA o endereço em
 *     `finally`, e de novo no `afterAll`).
 *
 * CA01–CA03 verificam a correção de locale herdada da #11554 (X-Locale): nenhum ajuste de locale é feito aqui.
 *
 * ## Massa (E2ETextsCountersSeeder, api)
 * Reaplique o seeder antes de cada rodada (a spec GRAVA uma família no CA01). O E2E-061 (gerado) lê a mesma
 * massa: rode-o ANTES desta spec, com 65 s entre os arquivos, reaplicando o seeder entre eles.
 * Credenciais só do ambiente (E2E_CLIENT_OPERADOR_*, E2E_CLIENT_MASTER_*); nenhum CPF, senha ou nome real
 * é gravado aqui (o CPF do cadastro é gerado a cada rodada, fictício e válido).
 */

const BASE = process.env.CLIENT_BASE_URL;
const API_BASE = process.env.E2E_API_BASE_URL ?? "http://localhost:8000";
const TENANT_UUID =
  process.env.E2E_TENANT_UUID ?? "00000000-0000-4000-8000-0000000000c1";
const FAMILY = "00000000-0000-4000-8000-000011555001";
const FAMILY_SWAP = "00000000-0000-4000-8000-000011555002";
const UNIT_TEXTS = "00000000-0000-4000-8000-000011555051";
const UNIT_TEXTS_NAME = "E2E CRAS Textos 11555";
const UNIT_CENTRO_NAME = "E2E CRAS Centro";

const SHOTS = path.resolve(
  __dirname,
  "../../../../e2e/reports/11555-textos-idioma-contadores-acceptance/screenshots",
);

let operatorContext: BrowserContext;
let operator: Page;
let masterContext: BrowserContext;
let master: Page;
/** Id do endereço da unidade de textos, guardado antes de apagar (para restaurar). */
let savedAddressId: number | null = null;
let addressRemoved = false;

test.use({
  baseURL: BASE,
  locale: "en-US",
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

/** CPF fictício e válido (dígitos verificadores calculados), diferente a cada rodada. */
function fictitiousCpf(): string {
  for (;;) {
    const base = Array.from({ length: 9 }, () =>
      Math.floor(Math.random() * 10),
    );
    if (new Set(base).size === 1) continue;
    const digit = (len: number) => {
      const sum = base
        .slice(0, len)
        .reduce((acc, n, i) => acc + n * (len + 1 - i), 0);
      const rest = (sum * 10) % 11;
      return rest === 10 ? 0 : rest;
    };
    const d1 = digit(9);
    base.push(d1);
    const d2 = digit(10);
    return [...base, d2].join("");
  }
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

async function openRecord(
  page: Page,
  uuid: string,
  tab?: string,
): Promise<void> {
  await page.goto(`/app/cadastros/familias/${uuid}${tab ? `?tab=${tab}` : ""}`);
  await dismissPlatformUpdates(page);
  await expect(
    page.getByRole("tablist", { name: "Grupos do prontuário" }),
  ).toBeVisible({ timeout: 20_000 });
}

/** Devolve o endereço da unidade de textos (idempotente). */
async function restoreAddress(page: Page): Promise<void> {
  if (!addressRemoved || savedAddressId === null) return;
  const response = await call(page, "put", `social-units/${UNIT_TEXTS}`, {
    address_id: savedAddressId,
  });
  expect(response.status(), "restauração do endereço da unidade").toBe(200);
  addressRemoved = false;
}

test.beforeAll(async ({ browser }) => {
  if (!BASE) return;
  operatorContext = await browser.newContext({
    baseURL: BASE,
    locale: "en-US",
    viewport: { width: 1440, height: 1100 },
  });
  operator = await operatorContext.newPage();
  masterContext = await browser.newContext({
    baseURL: BASE,
    locale: "en-US",
    viewport: { width: 1440, height: 1100 },
  });
  master = await masterContext.newPage();
});

test.afterAll(async () => {
  try {
    if (master) await restoreAddress(master);
  } finally {
    await operatorContext?.close();
    await masterContext?.close();
  }
});

test.describe("US-AJ-20 — textos, idioma e contadores (client, navegador em inglês)", () => {
  test.skip(!BASE, "Defina CLIENT_BASE_URL no arquivo de ambiente do E2E.");

  test("login 1 — operador: CA01 aviso TCE-AL em português ao cadastrar família sem endereço", async () => {
    await operator.goto("/auth/login");
    await loginAsTenantUser(
      operator,
      credential("E2E_CLIENT_OPERADOR_CPF"),
      credential("E2E_CLIENT_OPERADOR_PASSWORD"),
    );
    await dismissPlatformUpdates(operator);
    await expect(operator).toHaveURL(/\/app/);

    const cpf = fictitiousCpf();
    await operator.goto("/app/cadastros/familias/nova");
    await dismissPlatformUpdates(operator);
    await expect(operator.getByTestId("manual-family-form")).toBeVisible({
      timeout: 20_000,
    });

    await operator.getByTestId("manual-family-responsible-search").click();
    await operator.getByTestId("manual-family-cpf-input").fill(cpf);
    await operator.getByTestId("manual-family-cpf-submit").click();
    await operator.getByTestId("manual-family-create-person").click();
    await operator.locator("input#create-cpf").fill(cpf);
    await operator
      .locator("input#create-full-name")
      .fill("Responsável Fictícia E2E 11555");
    await operator.locator("input#create-birth-date").fill("1990-02-11");
    await operator
      .locator("input#create-mother-name")
      .fill("Mãe Fictícia E2E 11555");
    await operator.getByTestId("create-sex-trigger").click();
    await operator.getByRole("option").first().click();
    await operator.getByTestId("create-submit").click();
    await expect(
      operator.getByTestId("manual-family-responsible-selected"),
    ).toBeVisible();

    await operator.getByTestId("manual-family-unit-trigger").click();
    await operator.getByRole("option").first().click();
    await operator.getByTestId("manual-family-submit").click();

    await expect(operator.getByTestId("manual-family-success")).toBeVisible({
      timeout: 20_000,
    });
    const warning = operator.locator(
      '[data-warning-code="family_without_address"]',
    );
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      "não poderá ser declarada na remessa ao TCE-AL",
    );
    await expect(warning).not.toContainText(
      /cannot be declared|The family was/i,
    );
    await shot(operator, "ca01-aviso-tce-al-pt-br");
  });

  test("CA03 — aba Ingresso e programas mostra 'Bolsa Família' em português", async () => {
    await openRecord(operator, FAMILY, "ingresso");
    const block = operator.getByText("Bolsa Família").first();
    await expect(block).toBeVisible({ timeout: 20_000 });
    await shot(operator, "ca03-bolsa-familia");
  });

  test("CA06 — contador de anotações: sem número durante o carregamento, depois (4)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pattern = new RegExp(`/families/${FAMILY}/notes(\\?|$)`);
    await operator.route(pattern, async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await operator.goto(`/app/cadastros/familias/${FAMILY}?tab=anotacoes`);
      await dismissPlatformUpdates(operator);
      await expect(operator.getByTestId("list-count-loading")).toBeVisible({
        timeout: 20_000,
      });
      await expect(operator.getByTestId("list-count")).toHaveCount(0);
      await shot(operator, "ca06-contador-carregando");
    } finally {
      release();
      await operator.unroute(pattern);
    }
    await expect(operator.getByTestId("list-count")).toHaveText("(4)", {
      timeout: 20_000,
    });
    await expect(operator.getByTestId("list-count-loading")).toHaveCount(0);
    await shot(operator, "ca06-contador-4");
  });

  test("CA07 — filtro de atendimentos: o (4) some durante a consulta e depois mostra (1)", async () => {
    await openRecord(operator, FAMILY, "atendimentos");
    await expect(operator.getByTestId("list-count")).toHaveText("(4)", {
      timeout: 20_000,
    });

    // A visita domiciliar da massa é de 2 dias atrás; as demais são mais antigas.
    const visit = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pattern = new RegExp(
      `/families/${FAMILY}/attendances\\?.*attended_on_from=`,
    );
    await operator.route(pattern, async (route) => {
      await gate;
      await route.continue();
    });
    try {
      const panel = operator.getByTestId("attendance-filters-panel");
      if (!(await panel.isVisible().catch(() => false))) {
        await operator.getByTestId("attendance-filters-toggle").click();
      }
      await operator.getByTestId("attendance-filter-from").fill(visit);
      await expect(operator.getByTestId("list-count-loading")).toBeVisible({
        timeout: 20_000,
      });
      await expect(operator.getByTestId("list-count")).toHaveCount(0);
      await shot(operator, "ca07-filtro-carregando");
    } finally {
      release();
      await operator.unroute(pattern);
    }
    await expect(operator.getByTestId("list-count")).toHaveText("(1)", {
      timeout: 20_000,
    });
    await shot(operator, "ca07-filtro-1");
  });

  test("CA08 — menu lateral com o nome inteiro em 1920 px", async () => {
    await operator.setViewportSize({ width: 1920, height: 1080 });
    await openRecord(operator, FAMILY, "resumo");
    const item = operator.getByRole("button", {
      name: "Acompanhamentos com Atenção",
    });
    await expect(item).toBeVisible();
    const span = item.locator("span").filter({
      hasText: "Acompanhamentos com Atenção",
    });
    const fits = await span
      .first()
      .evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(fits, "texto do item sem reticências").toBe(true);
    await shot(operator, "ca08-menu-lateral");
    await operator.setViewportSize({ width: 1440, height: 1100 });
  });

  test("CA04 — página inexistente mostra 'Painel' (nunca 'Dashboard')", async () => {
    await operator.goto("/app/rota-que-nao-existe-11555");
    await dismissPlatformUpdates(operator);
    const button = operator.getByRole("button", { name: "Painel" });
    await expect(button).toBeVisible({ timeout: 20_000 });
    await expect(operator.getByText("Dashboard")).toHaveCount(0);
    await shot(operator, "ca04-botao-painel");
  });

  test("login 2 — Master: CA02 aviso de troca de unidade em português, cancelando sem confirmar", async () => {
    await master.goto("/auth/login");
    await loginAsTenantUser(
      master,
      credential("E2E_CLIENT_MASTER_CPF"),
      credential("E2E_CLIENT_MASTER_PASSWORD"),
    );
    await dismissPlatformUpdates(master);
    await expect(master).toHaveURL(/\/app/);

    await openRecord(master, FAMILY_SWAP);
    await expect(master.getByTestId("family-reference-unit")).toContainText(
      UNIT_CENTRO_NAME,
    );

    await master.getByTestId("family-change-unit").click();
    await expect(
      master.getByTestId("change-reference-unit-dialog"),
    ).toBeVisible();
    await master.getByTestId("change-unit-trigger").click();
    await master
      .getByRole("option", { name: new RegExp(UNIT_TEXTS_NAME, "i") })
      .first()
      .click();
    await master.getByTestId("change-submit").click();

    // 1º clique NÃO grava: o backend devolve o aviso (em português) e a ação vira "confirmar".
    const warning = master.getByTestId("change-previous-unit-warning");
    await expect(master.getByTestId("change-submit")).toContainText(
      /confirmar a troca/i,
      { timeout: 20_000 },
    );
    await expect(warning).toContainText(/deixará de enxergar/i);
    await expect(warning).not.toContainText(
      /will no longer|cannot|lose access/i,
    );
    await shot(master, "ca02-troca-unidade-pt-br");

    // Cancela sem confirmar: a unidade de referência continua a mesma.
    await master.getByRole("button", { name: "Cancelar" }).click();
    await expect(
      master.getByTestId("change-reference-unit-dialog"),
    ).toHaveCount(0);
    await expect(master.getByTestId("family-reference-unit")).toContainText(
      UNIT_CENTRO_NAME,
    );
  });

  test("CA05 — conferência prévia mostra 'Campo: Endereço da unidade (EnderecoUnidadeSocial)'", async () => {
    try {
      const unit = await call(master, "get", `social-units/${UNIT_TEXTS}`);
      expect(unit.status(), "GET da unidade de textos").toBe(200);
      const body = await unit.json();
      savedAddressId = body.data?.address?.id ?? body.data?.address_id ?? null;
      expect(savedAddressId, "endereço da massa presente").not.toBeNull();

      const cleared = await call(master, "put", `social-units/${UNIT_TEXTS}`, {
        address_id: null,
      });
      expect(cleared.status(), "apagar o endereço da unidade").toBe(200);
      addressRemoved = true;

      await master.goto("/app/prestacao-contas/remessas-siap");
      await dismissPlatformUpdates(master);
      await expect(master.getByText("Conferência prévia").first()).toBeVisible({
        timeout: 20_000,
      });
      const subject = master
        .getByTestId("siap-blocking-subject")
        .filter({ hasText: UNIT_TEXTS_NAME });
      await expect(subject).toBeVisible({ timeout: 20_000 });
      await expect(subject).toContainText(
        "Campo: Endereço da unidade (EnderecoUnidadeSocial)",
      );
      await shot(master, "ca05-pendencia-siap");
    } finally {
      await restoreAddress(master);
    }
  });
});
